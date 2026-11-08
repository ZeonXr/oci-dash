import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { currentSessionHash, requireUser } from "../auth";
import { audit } from "../db";
import { AppError } from "../errors";
import { errorResponse, json } from "../http";
import type { ConsoleManager } from "./manager";
import type { ConsoleActor } from "./types";

interface GatewayOptions {
  manager: ConsoleManager;
  upstreamPort: number;
  origin?: string;
  authenticate?: (request: Request) => ConsoleActor;
  recordEvent?: (actor: ConsoleActor, action: string, resource: string, result: string) => void;
}

const identifier = "([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})";
const sessionRoute = new RegExp(`^/api/console/sessions/${identifier}(?:/(ticket|close|touch))?$`);
const socketRoute = new RegExp(`^/api/console/sessions/${identifier}/socket$`);
const startSchema = z.object({ instanceId: z.string().min(1).max(2048) }).strict();

function actorFor(request: Request): ConsoleActor {
  const user = requireUser(request);
  const sessionHash = currentSessionHash(request);
  if (!sessionHash) throw new AppError("请先登录", 401, "UNAUTHORIZED");
  return { userId: user.id, username: user.username, sessionHash };
}

function headersFrom(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
    else headers.set(name, value);
  }
  return headers;
}

async function bodyFrom(request: IncomingMessage): Promise<unknown> {
  if (!(request.headers["content-type"] ?? "").includes("application/json"))
    throw new AppError("请求应使用 JSON", 415);
  if (Number(request.headers["content-length"] ?? 0) > 16_384) throw new AppError("请求过大", 413);
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > 16_384) throw new AppError("请求过大", 413);
    parts.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new AppError("JSON 格式不正确");
  }
}

async function respond(response: ServerResponse, result: Response): Promise<void> {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
  response.end(Buffer.from(await result.arrayBuffer()));
}

/** A single public HTTP/WSS entry; the generated Next server remains a loopback upstream. */
export function createConsoleGateway(options: GatewayOptions) {
  const expectedOrigin = new URL(
    options.origin ?? process.env.APP_ORIGIN ?? "http://localhost:3000",
  ).origin;
  const authenticate = options.authenticate ?? actorFor;
  const recordEvent =
    options.recordEvent ??
    ((actor: ConsoleActor, action: string, resource: string, result: string) =>
      audit(actor.username, action, resource, result));
  const manager = options.manager;
  let stopping = false;
  let closing: Promise<void> | undefined;
  const proxyRequests = new Set<ReturnType<typeof httpRequest>>();
  const pendingUpgrades = new Set<Duplex>();
  const sockets = new Set<Duplex>();
  const liveSockets = new WeakMap<WebSocket, boolean>();
  const revalidateSockets = new WeakMap<WebSocket, () => void>();
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("oci-console") ? "oci-console" : false),
  });
  const toRequest = (request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", expectedOrigin);
    if (url.origin !== expectedOrigin) throw new AppError("请求地址无效", 400);
    return new Request(url, {
      method: request.method,
      headers: headersFrom(request),
    });
  };
  function assertOrigin(request: Request) {
    if (
      request.headers.get("origin") !== expectedOrigin ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      throw new AppError("请求来源不匹配，请从面板页面操作", 403, "ORIGIN_MISMATCH");
  }

  async function consoleApi(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      const normalized = toRequest(request);
      const actor = authenticate(normalized);
      const method = request.method ?? "GET";
      if (!["GET", "HEAD"].includes(method)) {
        assertOrigin(normalized);
      }
      if (method === "GET" && path === "/api/console/session") {
        return respond(response, json({ session: manager.current(actor) }));
      }
      if (method === "POST" && path === "/api/console/sessions") {
        const { instanceId } = startSchema.parse(await bodyFrom(request));
        const session = await manager.create(instanceId, actor);
        recordEvent(actor, "console.create", instanceId, "正在准备 VNC 控制台");
        return respond(response, json({ session }, 202));
      }
      const match = sessionRoute.exec(path);
      if (!match) throw new AppError("控制台接口不存在", 404, "NOT_FOUND");
      const [, id, action] = match;
      if (method === "GET" && !action)
        return respond(response, json({ session: manager.get(id!, actor) }));
      if (method === "POST" && action === "ticket")
        return respond(response, json(manager.issueTicket(id!, actor)));
      if (method === "POST" && action === "touch") {
        manager.touch(id!, actor);
        return respond(response, json({ ok: true }));
      }
      if ((method === "DELETE" && !action) || (method === "POST" && action === "close")) {
        await manager.close(id!, actor);
        const session = manager.get(id!, actor);
        recordEvent(actor, "console.close", session.instanceId, "已请求关闭 VNC 控制台");
        return respond(response, json({ session }));
      }
      throw new AppError("请求方法不支持", 405, "METHOD_NOT_ALLOWED");
    } catch (error) {
      await respond(response, errorResponse(error));
    } finally {
      if (!request.complete) request.resume();
    }
  }

  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    if (stopping) {
      response.writeHead(503, { Connection: "close" });
      response.end();
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", expectedOrigin);
      if (url.origin !== expectedOrigin) throw new Error("Unexpected request target");
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.pathname === "/api/console" || url.pathname.startsWith("/api/console/")) {
      void consoleApi(request, response, url.pathname).catch(() => response.destroy());
      return;
    }
    const headers = { ...request.headers };
    delete headers.connection;
    delete headers.upgrade;
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: options.upstreamPort,
        path: url.pathname + url.search,
        method: request.method,
        headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
        incoming.on("error", () => response.destroy());
      },
    );
    proxyRequests.add(upstream);
    upstream.once("close", () => proxyRequests.delete(upstream));
    upstream.setTimeout(90_000, () => upstream.destroy());
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(503, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(
          JSON.stringify({ error: "应用正在启动或暂时不可用", code: "APP_UNAVAILABLE" }),
        );
      }
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    let stream: Duplex | undefined;
    pendingUpgrades.add(socket);
    socket.on("error", () => stream?.destroy());
    socket.once("close", () => stream?.destroy());
    try {
      if (stopping) throw new AppError("应用正在停止", 503);
      const normalized = toRequest(request);
      const url = new URL(normalized.url);
      const match = socketRoute.exec(url.pathname);
      if (!match || url.search) throw new AppError("控制台连接地址无效", 404);
      assertOrigin(normalized);
      const actor = authenticate(normalized);
      if (
        request.method !== "GET" ||
        request.headers.upgrade?.toLowerCase() !== "websocket" ||
        !(request.headers.connection ?? "")
          .toLowerCase()
          .split(/\s*,\s*/)
          .includes("upgrade") ||
        request.headers["sec-websocket-version"] !== "13" ||
        !/^[A-Za-z0-9+/]{22}==$/.test(String(request.headers["sec-websocket-key"] ?? ""))
      ) {
        throw new AppError("WebSocket 握手无效", 400, "INVALID_UPGRADE");
      }
      const protocols = (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim());
      if (
        protocols.length !== 2 ||
        protocols[0] !== "oci-console" ||
        !/^ticket\.[A-Za-z0-9_-]{32,128}$/.test(protocols[1] ?? "")
      ) {
        throw new AppError("控制台连接票据无效", 403, "INVALID_CONSOLE_TICKET");
      }
      const id = match[1]!;
      stream = await manager.connect(id, protocols[1]!.slice(7), actor);
      if (socket.destroyed || stopping) {
        stream.destroy();
        return;
      }
      const transport = stream;
      let accepted = false;
      websocket.handleUpgrade(request, socket, head, (client) => {
        accepted = true;
        liveSockets.set(client, true);
        revalidateSockets.set(client, () => {
          const current = authenticate(normalized);
          if (current.userId !== actor.userId || current.sessionHash !== actor.sessionHash)
            throw new AppError("登录已失效", 401);
        });
        client.on("pong", () => liveSockets.set(client, true));
        const channel = createWebSocketStream(client, { encoding: undefined });
        const disconnect = () => {
          transport.destroy();
          channel.destroy();
          client.terminate();
        };
        channel.on("error", disconnect);
        transport.on("error", disconnect);
        transport.on("close", disconnect);
        client.on("error", disconnect);
        client.once("close", () => transport.destroy());
        transport.pipe(channel);
        channel.pipe(transport);
        recordEvent(actor, "console.connect", id, "VNC 控制台传输已连接");
      });
      if (!accepted) transport.destroy();
    } catch (error) {
      stream?.destroy();
      const status = error instanceof AppError ? error.status : 502;
      if (!socket.destroyed)
        socket.end(
          `HTTP/1.1 ${status} Connection Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        );
    } finally {
      pendingUpgrades.delete(socket);
    }
  }
  server.on("upgrade", (request, socket, head) => {
    void upgrade(request, socket, head).catch(() => socket.destroy());
  });
  const heartbeat = setInterval(() => {
    for (const client of websocket.clients) {
      try {
        revalidateSockets.get(client)?.();
      } catch {
        client.terminate();
        continue;
      }
      if (!liveSockets.get(client)) client.terminate();
      else {
        liveSockets.set(client, false);
        if (client.readyState === WebSocket.OPEN) client.ping();
      }
    }
  }, 15_000);
  heartbeat.unref();

  return {
    server,
    async listen(port: number, host = "0.0.0.0"): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const failure = (error: Error) => reject(error);
        server.once("error", failure);
        server.listen(port, host, () => {
          server.removeListener("error", failure);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      clearInterval(heartbeat);
      for (const socket of pendingUpgrades) socket.destroy();
      for (const client of websocket.clients) client.terminate();
      closing = (async () => {
        const httpClosed = new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
          server.closeIdleConnections();
        });
        const deadline = setTimeout(() => {
          for (const request of proxyRequests) request.destroy();
          for (const socket of sockets) socket.destroy();
        }, 10_000);
        try {
          await Promise.all([httpClosed, manager.shutdown()]);
        } finally {
          clearTimeout(deadline);
          websocket.close();
        }
      })();
      return closing;
    },
  };
}
