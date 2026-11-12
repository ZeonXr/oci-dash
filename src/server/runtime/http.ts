import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConsoleGateway } from "../console/gateway";
import { AppError } from "../errors";
import { errorResponse, json } from "../http";
import { assertRequestOrigin, configuredOrigin, gatewayRequestUrl } from "../request-origin";

export type PageHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;
interface HttpOptions {
  origin?: string;
  ready(): boolean;
  health(): Response;
  api(request: Request, segments: string[]): Promise<Response>;
  console(): ConsoleGateway | undefined;
  page: PageHandler;
}

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function headersFrom(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((part) => headers.append(name, part));
    else headers.set(name, value);
  }
  return headers;
}

/** Drain an oversized JSON body without destroying the socket before its 413 is sent. */
function readBody(request: IncomingMessage, limit: number): Promise<Buffer<ArrayBuffer>> {
  if (Number(request.headers["content-length"] ?? 0) > limit) {
    request.resume();
    return Promise.reject(new AppError("请求过大", 413));
  }
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      request.removeListener("data", data);
      request.removeListener("end", end);
      request.removeListener("error", error);
      request.removeListener("aborted", aborted);
    };
    const error = (reason: Error) => {
      cleanup();
      reject(reason);
    };
    const aborted = () => error(new AppError("请求已取消", 499, "REQUEST_CANCELLED"));
    const end = () => {
      cleanup();
      resolve(Buffer.concat(parts, size));
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) {
        cleanup();
        request.resume();
        reject(new AppError("请求过大", 413));
      } else parts.push(bytes);
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", error);
    request.once("aborted", aborted);
    if (request.aborted) aborted();
  });
}

async function respond(response: ServerResponse, result: Response, head: boolean): Promise<void> {
  if (response.destroyed || response.headersSent) return;
  result.headers.forEach((value, name) => {
    if (name !== "set-cookie") response.setHeader(name, value);
  });
  const cookies = result.headers.getSetCookie();
  if (cookies.length) response.setHeader("Set-Cookie", cookies);
  response.statusCode = result.status;
  response.end(head || !result.body ? undefined : Buffer.from(await result.arrayBuffer()));
}

/** Only JSON APIs are adapted here. Next owns page, RSC and asset streaming. */
export function createHttpHandler(options: HttpOptions): PageHandler {
  const origin = configuredOrigin(options.origin);
  return async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    const controller = new AbortController();
    const abort = () => controller.abort(new AppError("请求已取消", 499, "REQUEST_CANCELLED"));
    const close = () => {
      if (!response.writableFinished) abort();
    };
    request.once("aborted", abort);
    request.once("error", abort);
    response.once("close", close);
    try {
      const url = gatewayRequestUrl(
        request.url ?? "/",
        request.headers.host ?? "",
        request.headers.origin,
        origin,
      );
      const method = request.method ?? "GET";
      const headers = headersFrom(request);
      const metadata = { url: url.href, headers };
      if (!["GET", "HEAD"].includes(method)) assertRequestOrigin(metadata, origin);
      const isApi = url.pathname === "/api" || url.pathname.startsWith("/api/");
      let segments: string[] = [];
      if (isApi) {
        try {
          segments = url.pathname.slice(5).split("/").filter(Boolean).map(decodeURIComponent);
        } catch {
          throw new AppError("请求地址无效", 400, "INVALID_REQUEST_TARGET");
        }
      }
      if (segments.length === 1 && segments[0] === "health" && ["GET", "HEAD"].includes(method)) {
        await respond(response, options.health(), method === "HEAD");
        return;
      }
      if (!options.ready()) {
        response.setHeader("Retry-After", "1");
        await respond(
          response,
          json({ error: "应用正在启动或停止", code: "APP_UNAVAILABLE" }, 503),
          method === "HEAD",
        );
        return;
      }
      if (isApi) {
        const isConsole = segments[0] === "console";
        if (!isConsole) {
          const allow = "GET, HEAD, OPTIONS, POST, PATCH, DELETE";
          if (method === "OPTIONS") {
            await respond(
              response,
              new Response(null, { status: 204, headers: { Allow: allow } }),
              false,
            );
            return;
          }
          if (!["GET", "HEAD", "POST", "PATCH", "DELETE"].includes(method)) {
            await respond(
              response,
              new Response(null, { status: 405, headers: { Allow: allow } }),
              false,
            );
            return;
          }
        }
        const body = ["GET", "HEAD"].includes(method)
          ? undefined
          : await readBody(request, isConsole ? 16_384 : 256 * 1024);
        const normalized = new Request(url, { method, headers, body, signal: controller.signal });
        let result: Response;
        if (isConsole) {
          const gateway = options.console();
          if (!gateway) throw new AppError("控制台服务尚未就绪", 503, "CONSOLE_UNAVAILABLE");
          result = await gateway.handleRequest(normalized);
        } else {
          result = await options.api(normalized, segments);
        }
        await respond(response, result, method === "HEAD");
        return;
      }
      // The actual Host is authoritative; forwarded headers cannot replace it in Next.
      for (const name of [
        "x-forwarded-host",
        "x-forwarded-proto",
        "proxy-authorization",
        "proxy-connection",
      ])
        delete request.headers[name];
      try {
        await options.page(request, response);
      } catch {
        await respond(
          response,
          json({ error: "应用暂时不可用", code: "APP_UNAVAILABLE" }, 503),
          method === "HEAD",
        );
      }
    } catch (error) {
      await respond(response, errorResponse(error), request.method === "HEAD");
    } finally {
      request.removeListener("aborted", abort);
      request.removeListener("error", abort);
      response.removeListener("close", close);
      if (!request.complete) request.resume();
    }
  };
}
