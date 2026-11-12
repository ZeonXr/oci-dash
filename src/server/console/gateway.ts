import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { createWebSocketStream, WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { currentSessionHash, requireUser } from "../auth";
import { audit } from "../db";
import { AppError } from "../errors";
import { errorResponse, json, readJson } from "../http";
import { assertRequestOrigin, configuredOrigin, gatewayRequestUrl } from "../request-origin";
import type { ConsoleManager } from "./manager";
import type { ConsoleActor } from "./types";

interface GatewayOptions {
  manager: ConsoleManager;
  origin?: string;
  authenticate?: (request: Request) => ConsoleActor;
  recordEvent?: (actor: ConsoleActor, action: string, resource: string, result: string) => void;
}

export interface ConsoleGateway {
  handleRequest(request: Request): Promise<Response>;
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  close(): Promise<void>;
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

/** Console HTTP and WebSocket handling; the application owns the listening server. */
export function createConsoleGateway(options: GatewayOptions): ConsoleGateway {
  const expectedOrigin = configuredOrigin(options.origin ?? process.env.APP_ORIGIN);
  const authenticate = options.authenticate ?? actorFor;
  const recordEvent =
    options.recordEvent ??
    ((actor: ConsoleActor, action: string, resource: string, result: string) =>
      audit(actor.username, action, resource, result));
  const manager = options.manager;
  let stopping = false;
  let closing: Promise<void> | undefined;
  const pendingUpgrades = new Set<Duplex>();
  const liveSockets = new WeakMap<WebSocket, boolean>();
  const revalidateSockets = new WeakMap<WebSocket, () => void>();
  const websocket = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has("oci-console") ? "oci-console" : false),
  });
  const toRequest = (request: IncomingMessage) => {
    const url = gatewayRequestUrl(
      request.url ?? "/",
      request.headers.host ?? "",
      request.headers.origin,
      expectedOrigin,
    );
    return new Request(url, {
      method: request.method,
      headers: headersFrom(request),
    });
  };
  function assertOrigin(request: Request) {
    assertRequestOrigin(request, expectedOrigin);
  }

  async function handleRequest(request: Request): Promise<Response> {
    try {
      if (stopping) throw new AppError("控制台服务正在停止", 503, "CONSOLE_UNAVAILABLE");
      const path = new URL(request.url).pathname;
      const actor = authenticate(request);
      const method = request.method;
      if (!["GET", "HEAD"].includes(method)) {
        assertOrigin(request);
      }
      if (method === "GET" && path === "/api/console/session") {
        return json({ session: manager.current(actor) });
      }
      if (method === "POST" && path === "/api/console/sessions") {
        const { instanceId } = startSchema.parse(await readJson(request));
        const session = await manager.create(instanceId, actor);
        recordEvent(actor, "console.create", instanceId, "正在准备 VNC 控制台");
        return json({ session }, 202);
      }
      const match = sessionRoute.exec(path);
      if (!match) throw new AppError("控制台接口不存在", 404, "NOT_FOUND");
      const [, id, action] = match;
      if (method === "GET" && !action) return json({ session: manager.get(id!, actor) });
      if (method === "POST" && action === "ticket") return json(manager.issueTicket(id!, actor));
      if (method === "POST" && action === "touch") {
        manager.touch(id!, actor);
        return json({ ok: true });
      }
      if ((method === "DELETE" && !action) || (method === "POST" && action === "close")) {
        await manager.close(id!, actor);
        const session = manager.get(id!, actor);
        recordEvent(actor, "console.close", session.instanceId, "已请求关闭 VNC 控制台");
        return json({ session });
      }
      throw new AppError("请求方法不支持", 405, "METHOD_NOT_ALLOWED");
    } catch (error) {
      return errorResponse(error);
    }
  }

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
    handleRequest,
    upgrade,
    close(): Promise<void> {
      if (closing) return closing;
      stopping = true;
      clearInterval(heartbeat);
      for (const socket of pendingUpgrades) socket.destroy();
      for (const client of websocket.clients) client.terminate();
      closing = (async () => {
        const socketsClosed = new Promise<void>((resolve, reject) => {
          websocket.close((error) => (error ? reject(error) : resolve()));
        });
        await Promise.all([socketsClosed, manager.shutdown()]);
      })();
      return closing;
    },
  };
}
