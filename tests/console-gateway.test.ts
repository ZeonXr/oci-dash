import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex } from "node:stream";
import { once } from "node:events";
import { WebSocket, type RawData } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConsoleSessionSummary } from "@/lib/console-contracts";
import { createConsoleGateway } from "@/server/console/gateway";
import type { ConsoleManager } from "@/server/console/manager";
import type { ConsoleActor } from "@/server/console/types";
import { AppError } from "@/server/errors";
import { createHttpHandler } from "@/server/runtime/http";
import { configuredOrigin, gatewayRequestUrl } from "@/server/request-origin";

const ORIGIN = "https://console-tests.invalid";
const COOKIE = "test_session=gateway-test-login";
const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const TICKET = "test_only_socket_ticket_0123456789abcdefghijkl";
const SOCKET_PATH = `/api/console/sessions/${SESSION_ID}/socket`;
const actor: ConsoleActor = {
  userId: "test-user",
  username: "test-admin",
  sessionHash: "hashed-test-login",
};
const gateways: ReturnType<typeof createConsoleGateway>[] = [];
const servers: Server[] = [];
const clients: WebSocket[] = [];

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function http(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: new URL(ORIGIN).host,
          ...(options.body !== undefined
            ? { "content-length": String(Buffer.byteLength(options.body)) }
            : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.once("error", reject);
      },
    );
    request.setTimeout(3_000, () => request.destroy(new Error("Local gateway request timed out")));
    request.once("error", reject);
    request.end(options.body);
  });
}

function bytes(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}

async function fixture(options: { origin?: string | null; requestOrigin?: string } = {}) {
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: Buffer }[] =
    [];
  const page = vi.fn(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({
      method: request.method!,
      path: request.url!,
      headers: request.headers,
      body: Buffer.concat(chunks),
    });
    response.writeHead(201, {
      "content-type": "application/octet-stream",
      "set-cookie": ["first=one; Path=/; HttpOnly", "second=two; Path=/; SameSite=Lax"],
      "x-handler": "direct-page",
    });
    response.end(Buffer.from([0, 255, 7, 128, 66]));
  });
  const apiHandler = vi.fn(async (request: Request, _segments: string[]) => {
    const url = new URL(request.url);
    requests.push({
      method: request.method,
      path: url.pathname + url.search,
      headers: Object.fromEntries(request.headers),
      body: Buffer.from(await request.arrayBuffer()),
    });
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-handler": "direct-api",
    });
    headers.append("set-cookie", "first=one; Path=/; HttpOnly");
    headers.append("set-cookie", "second=two; Path=/; SameSite=Lax");
    return new Response(Buffer.from([0, 255, 7, 128, 66]), { status: 201, headers });
  });
  let session: ConsoleSessionSummary = {
    id: SESSION_ID,
    instanceId: "test-instance",
    instanceName: "mock-instance",
    accountId: "mock-account",
    state: "ready",
    createdAt: "2026-11-07T00:00:00.000Z",
    expiresAt: "2026-11-07T01:00:00.000Z",
    lastError: null,
    cleanupPending: false,
  };
  const received: Buffer[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      received.push(Buffer.from(chunk));
      done();
    },
  });
  const manager = {
    initialize: vi.fn(async () => undefined),
    current: vi.fn(() => session),
    create: vi.fn(async () => {
      session = { ...session, state: "preparing" };
      return session;
    }),
    get: vi.fn(() => session),
    issueTicket: vi.fn(() => ({
      ticket: TICKET,
      expiresAt: "2026-11-07T00:00:30.000Z",
      path: SOCKET_PATH,
    })),
    connect: vi.fn(async () => stream),
    touch: vi.fn(),
    close: vi.fn(async () => {
      session = { ...session, state: "closed" };
    }),
    shutdown: vi.fn(async () => {
      stream.destroy();
    }),
  } satisfies ConsoleManager;
  const authenticate = vi.fn((request: Request): ConsoleActor => {
    if (request.headers.get("cookie") !== COOKIE)
      throw new AppError("test authentication required", 401, "UNAUTHORIZED");
    return actor;
  });
  const recordEvent = vi.fn();
  const origin = options.origin === null ? undefined : (options.origin ?? ORIGIN);
  const gateway = createConsoleGateway({
    manager,
    origin,
    authenticate,
    recordEvent,
  });
  gateways.push(gateway);
  const handle = createHttpHandler({
    origin,
    ready: () => true,
    health: () => Response.json({ ok: true }),
    api: apiHandler,
    console: () => gateway,
    page,
  });
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  server.on("upgrade", (request, socket, head) => {
    try {
      const url = gatewayRequestUrl(
        request.url ?? "/",
        request.headers.host ?? "",
        request.headers.origin,
        configuredOrigin(origin),
      );
      if (!/^\/api\/console\/sessions\/[a-f0-9-]{36}\/socket$/.test(url.pathname))
        throw new AppError("Unknown upgrade path", 404);
      void gateway.upgrade(request, socket, head).catch(() => socket.destroy());
    } catch (error) {
      socket.end(
        `HTTP/1.1 ${error instanceof AppError ? error.status : 400} Connection Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const requestOrigin =
    options.requestOrigin ??
    options.origin ??
    (options.origin === null ? `http://127.0.0.1:${port}` : ORIGIN);
  const api = (path: string, options: Parameters<typeof http>[2] = {}) =>
    http(port, path, {
      ...options,
      headers: {
        cookie: COOKIE,
        origin: requestOrigin,
        host: new URL(requestOrigin).host,
        "content-type": "application/json",
        ...options.headers,
      },
    });
  const client = (
    path = SOCKET_PATH,
    protocols = ["oci-console", `ticket.${TICKET}`],
    headers: Record<string, string> = {},
  ) => {
    const websocket = new WebSocket(`ws://127.0.0.1:${port}${path}`, protocols, {
      headers: {
        cookie: COOKIE,
        origin: requestOrigin,
        host: new URL(requestOrigin).host,
        ...headers,
      },
    });
    websocket.on("error", () => undefined);
    clients.push(websocket);
    return websocket;
  };
  const open = async () => {
    const websocket = client();
    await once(websocket, "open");
    return websocket;
  };
  return {
    gateway,
    server,
    port,
    requests,
    page,
    apiHandler,
    manager,
    authenticate,
    recordEvent,
    stream,
    received,
    api,
    client,
    open,
  };
}

function rejected(websocket: WebSocket): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    websocket.once("open", () => reject(new Error("An invalid websocket unexpectedly opened")));
    websocket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("error", reject);
      response.once("end", () => {
        websocket.terminate();
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
  });
}

beforeEach(() => {
  vi.stubEnv("APP_ORIGIN", ORIGIN);
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    if (client.readyState !== WebSocket.CLOSED) client.terminate();
  }
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("shared HTTP server with console handling", () => {
  it("passes ordinary body, path and cookie directly to the page handler and preserves its response", async () => {
    const f = await fixture();
    const body = Buffer.from([0, 255, 1, 128, 33]);
    const result = await http(f.port, "/ordinary/path?value=one%20two", {
      method: "POST",
      body,
      headers: {
        cookie: "first=1; second=2",
        "content-type": "application/octet-stream",
        "x-request": "forward-me",
        origin: ORIGIN,
      },
    });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(Buffer.from([0, 255, 7, 128, 66]));
    expect(result.headers["set-cookie"]).toEqual([
      "first=one; Path=/; HttpOnly",
      "second=two; Path=/; SameSite=Lax",
    ]);
    expect(result.headers["x-handler"]).toBe("direct-page");
    expect(f.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/ordinary/path?value=one%20two",
        body,
        headers: expect.objectContaining({
          cookie: "first=1; second=2",
          "x-request": "forward-me",
        }),
      }),
    ]);
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it("responds safely when the page handler is unavailable", async () => {
    const f = await fixture();
    f.page.mockRejectedValueOnce(new Error("Synthetic page failure"));
    const result = await http(f.port, "/normal-page");
    expect(result.status).toBe(503);
    expect(JSON.parse(result.body.toString())).toMatchObject({ code: "APP_UNAVAILABLE" });
    expect(result.headers["cache-control"]).toBe("no-store");
  });

  it("passes API Request metadata and body directly and preserves separate response cookies", async () => {
    const f = await fixture();
    const body = JSON.stringify({ synthetic: true });
    const result = await f.api("/api/auth/login?source=direct", { method: "POST", body });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(Buffer.from([0, 255, 7, 128, 66]));
    expect(result.headers["set-cookie"]).toEqual([
      "first=one; Path=/; HttpOnly",
      "second=two; Path=/; SameSite=Lax",
    ]);
    expect(result.headers["x-handler"]).toBe("direct-api");
    expect(f.requests).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/api/auth/login?source=direct",
        body: Buffer.from(body),
        headers: expect.objectContaining({ cookie: COOKIE, origin: ORIGIN }),
      }),
    ]);
    expect(f.apiHandler.mock.calls[0][1]).toEqual(["auth", "login"]);
    expect(f.page).not.toHaveBeenCalled();
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it("allows relative health reads through an internal Host while rejecting absolute foreign targets", async () => {
    const f = await fixture();
    const headers = { host: "127.0.0.1:3000" };
    const healthy = await http(f.port, "/api/health", { headers });
    expect(healthy.status).toBe(200);
    expect(JSON.parse(healthy.body.toString())).toEqual({ ok: true });
    expect(f.requests).toEqual([]);
    const foreign = await http(f.port, "https://other.invalid/api/health", { headers });
    expect(foreign.status).toBe(400);
    expect(f.requests).toHaveLength(0);
    expect(f.page).not.toHaveBeenCalled();
    expect(f.apiHandler).not.toHaveBeenCalled();
    expect(f.authenticate).not.toHaveBeenCalled();
  });
});

describe("console gateway without a fixed public origin", () => {
  beforeEach(() => vi.stubEnv("APP_ORIGIN", undefined));

  it("supports a random localhost port for HTTP and websocket admission", async () => {
    const f = await fixture({ origin: null });
    const created = await f.api("/api/console/sessions", {
      method: "POST",
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(created.status).toBe(202);
    const socket = await f.open();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(f.manager.connect).toHaveBeenCalledWith(SESSION_ID, TICKET, actor);
  });

  it("supports HTTPS Origins and preserves the authoritative Host for direct page and API handling", async () => {
    const f = await fixture({ origin: null, requestOrigin: "https://panel.example" });
    const result = await f.api("/ordinary/login", {
      method: "POST",
      body: JSON.stringify({ username: "synthetic" }),
      headers: {
        host: "PANEL.EXAMPLE:443",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(result.status).toBe(201);
    expect(f.requests[0].headers.host).toBe("PANEL.EXAMPLE:443");
    expect(f.requests[0].headers["x-forwarded-host"]).toBeUndefined();
    expect(f.requests[0].headers["x-forwarded-proto"]).toBeUndefined();
    const login = await f.api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "synthetic" }),
      headers: {
        host: "PANEL.EXAMPLE:443",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    });
    expect(login.status).toBe(201);
    expect(new URL(f.apiHandler.mock.calls[0][0].url).hostname).toBe("panel.example");
    expect(f.apiHandler.mock.calls[0][0].headers.get("host")).toBe("PANEL.EXAMPLE:443");
    const created = await f.api("https://panel.example/api/console/sessions", {
      method: "POST",
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(created.status).toBe(202);
    await f.open();
    expect(f.manager.connect).toHaveBeenCalledTimes(1);
  });

  it.each(["", "null", "https://other.example"])(
    "rejects %s Origin on API writes and websocket upgrades",
    async (origin) => {
      const f = await fixture({ origin: null, requestOrigin: "https://panel.example" });
      const denied = await f.api("/api/auth/login", {
        method: "POST",
        headers: { origin, "x-forwarded-host": "other.example" },
      });
      expect(denied.status).toBe(403);
      expect(
        (await rejected(f.client(SOCKET_PATH, ["oci-console", `ticket.${TICKET}`], { origin })))
          .status,
      ).toBe(403);
      expect(f.requests).toHaveLength(0);
      expect(f.manager.connect).not.toHaveBeenCalled();
    },
  );

  it("rejects cross-site and missing Host before dispatching a write", async () => {
    const f = await fixture({ origin: null, requestOrigin: "https://panel.example" });
    const invalidHeaders: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { host: "" },
    ];
    for (const headers of invalidHeaders) {
      const result = await f.api("/api/auth/logout", { method: "POST", headers });
      expect(result.status).toBe(403);
    }
    expect(f.requests).toHaveLength(0);
  });

  it("rejects absolute foreign HTTP and websocket targets before dispatching or consuming tickets", async () => {
    const f = await fixture({ origin: null, requestOrigin: "https://panel.example" });
    for (const target of [
      "https://other.example/api/auth/login",
      "//other.example/api/auth/login",
      "/\\other.example/api/auth/login",
    ]) {
      expect((await f.api(target, { method: "POST" })).status).toBe(400);
    }
    const upgrade = await http(f.port, `https://other.example${SOCKET_PATH}`, {
      headers: {
        host: "panel.example",
        origin: "https://panel.example",
        cookie: COOKIE,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-version": "13",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
        "sec-websocket-protocol": `oci-console, ticket.${TICKET}`,
      },
    });
    expect(upgrade.status).toBe(400);
    expect(f.requests).toHaveLength(0);
    expect(f.manager.connect).not.toHaveBeenCalled();
  });
});

describe("console gateway HTTP API", () => {
  it("retains its authentication and mutation Origin checks for standard Request callers", async () => {
    const f = await fixture();
    const body = JSON.stringify({ instanceId: "test-instance" });
    const unauthenticated = await f.gateway.handleRequest(
      new Request(`${ORIGIN}/api/console/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body,
      }),
    );
    expect(unauthenticated.status).toBe(401);
    const crossOrigin = await f.gateway.handleRequest(
      new Request(`${ORIGIN}/api/console/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: COOKIE,
          origin: "https://other.invalid",
        },
        body,
      }),
    );
    expect(crossOrigin.status).toBe(403);
    expect(f.manager.create).not.toHaveBeenCalled();
  });

  it("requires authentication for read and write console endpoints", async () => {
    const f = await fixture();
    for (const [method, path] of [
      ["GET", "/api/console/session"],
      ["POST", "/api/console/sessions"],
      ["GET", `/api/console/sessions/${SESSION_ID}`],
    ]) {
      const result = await http(f.port, path!, {
        method,
        headers: { origin: ORIGIN, "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ instanceId: "test-instance" }) : undefined,
      });
      expect(result.status).toBe(401);
      expect(JSON.parse(result.body.toString())).toMatchObject({ code: "UNAUTHORIZED" });
    }
    expect(f.manager.current).not.toHaveBeenCalled();
    expect(f.manager.create).not.toHaveBeenCalled();
    expect(f.manager.get).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://other.invalid"])(
    "rejects mutation with absent or foreign Origin: %s",
    async (origin) => {
      const f = await fixture();
      const result = await http(f.port, "/api/console/sessions", {
        method: "POST",
        headers: {
          cookie: COOKIE,
          "content-type": "application/json",
          ...(origin ? { origin } : {}),
        },
        body: JSON.stringify({ instanceId: "test-instance" }),
      });
      expect(result.status).toBe(403);
      expect(f.manager.create).not.toHaveBeenCalled();
    },
  );

  it("rejects a cross-site mutation even if its Origin is otherwise correct", async () => {
    const f = await fixture();
    const result = await f.api("/api/console/sessions", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(result.status).toBe(403);
    expect(f.manager.create).not.toHaveBeenCalled();
  });

  it("uses the explicitly configured gateway origin consistently when APP_ORIGIN differs", async () => {
    vi.stubEnv("APP_ORIGIN", "https://environment-origin.invalid");
    const f = await fixture();
    const accepted = await f.api("/api/console/sessions", {
      method: "POST",
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(accepted.status).toBe(202);
    const denied = await f.api("/api/console/sessions", {
      method: "POST",
      headers: { origin: "https://environment-origin.invalid" },
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(denied.status).toBe(403);
    expect(f.manager.create).toHaveBeenCalledTimes(1);
  });

  it("also rejects a foreign Host when Origin matches the explicit configuration", async () => {
    const f = await fixture();
    const denied = await f.api("/api/console/sessions", {
      method: "POST",
      headers: { host: "other.invalid" },
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(denied.status).toBe(403);
    expect(f.manager.create).not.toHaveBeenCalled();
  });

  it("rejects an absolute foreign request-target even without APP_ORIGIN", async () => {
    vi.stubEnv("APP_ORIGIN", undefined);
    const f = await fixture();
    const result = await f.api("https://other.invalid/api/console/sessions", {
      method: "POST",
      headers: { origin: "https://other.invalid" },
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(result.status).toBe(400);
    expect(f.manager.create).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
  });

  it("implements create, current, status, ticket, touch and close contracts", async () => {
    const f = await fixture();
    const created = await f.api("/api/console/sessions", {
      method: "POST",
      body: JSON.stringify({ instanceId: "test-instance" }),
    });
    expect(created.status).toBe(202);
    expect(JSON.parse(created.body.toString())).toMatchObject({
      session: { id: SESSION_ID, state: "preparing" },
    });
    expect(f.manager.create).toHaveBeenCalledWith("test-instance", actor);
    const current = await f.api("/api/console/session");
    expect(JSON.parse(current.body.toString())).toMatchObject({
      session: { id: SESSION_ID },
    });
    const status = await f.api(`/api/console/sessions/${SESSION_ID}`);
    expect(status.status).toBe(200);
    expect(f.manager.get).toHaveBeenCalledWith(SESSION_ID, actor);
    const ticket = await f.api(`/api/console/sessions/${SESSION_ID}/ticket`, { method: "POST" });
    expect(JSON.parse(ticket.body.toString())).toEqual({
      ticket: TICKET,
      expiresAt: "2026-11-07T00:00:30.000Z",
      path: SOCKET_PATH,
    });
    expect(ticket.headers["cache-control"]).toBe("no-store");
    const touched = await f.api(`/api/console/sessions/${SESSION_ID}/touch`, { method: "POST" });
    expect(JSON.parse(touched.body.toString())).toEqual({ ok: true });
    expect(f.manager.touch).toHaveBeenCalledWith(SESSION_ID, actor);
    const closed = await f.api(`/api/console/sessions/${SESSION_ID}`, { method: "DELETE" });
    expect(JSON.parse(closed.body.toString())).toMatchObject({ session: { state: "closed" } });
    expect(f.manager.close).toHaveBeenCalledWith(SESSION_ID, actor);
    expect(f.recordEvent).toHaveBeenCalledWith(
      actor,
      "console.create",
      "test-instance",
      expect.any(String),
    );
    expect(f.recordEvent).toHaveBeenCalledWith(
      actor,
      "console.close",
      "test-instance",
      expect.any(String),
    );
    expect(JSON.stringify(f.recordEvent.mock.calls)).not.toContain(TICKET);
  });

  it("supports the POST close fallback without exposing a write through GET", async () => {
    const f = await fixture();
    const bad = await f.api(`/api/console/sessions/${SESSION_ID}/close`);
    expect(bad.status).toBe(405);
    expect(f.manager.close).not.toHaveBeenCalled();
    const good = await f.api(`/api/console/sessions/${SESSION_ID}/close`, { method: "POST" });
    expect(good.status).toBe(200);
    expect(f.manager.close).toHaveBeenCalledWith(SESSION_ID, actor);
  });

  it("rejects invalid or oversized create input before reaching the manager", async () => {
    const f = await fixture();
    for (const [body, expectedStatus] of [
      ["{bad-json", 400],
      [JSON.stringify({ instanceId: "test-instance", unexpected: true }), 400],
      [JSON.stringify({ instanceId: "" }), 400],
      [JSON.stringify({ instanceId: "x".repeat(17_000) }), 413],
    ] as const) {
      const result = await f.api("/api/console/sessions", { method: "POST", body });
      expect(result.status).toBe(expectedStatus);
    }
    const result = await f.api("/api/console/sessions", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not-json",
    });
    expect(result.status).toBe(415);
    expect(f.manager.create).not.toHaveBeenCalled();
  });

  it("preserves manager authorization errors and keeps unknown console routes out of page and API handlers", async () => {
    const f = await fixture();
    f.manager.get.mockImplementation(() => {
      throw new AppError("another login owns this console", 403, "CONSOLE_FORBIDDEN");
    });
    const response = await f.api(`/api/console/sessions/${SESSION_ID}`);
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body.toString())).toMatchObject({ code: "CONSOLE_FORBIDDEN" });
    const unknown = await f.api("/api/console/not-a-route");
    expect(unknown.status).toBe(404);
    expect(f.requests).toHaveLength(0);
  });
});

describe("console gateway websocket admission", () => {
  it("authenticates each websocket upgrade and rejects an unauthenticated client", async () => {
    const f = await fixture();
    const result = await rejected(
      f.client(SOCKET_PATH, ["oci-console", `ticket.${TICKET}`], { cookie: "invalid=login" }),
    );
    expect(result.status).toBe(401);
    expect(f.authenticate).toHaveBeenCalledTimes(1);
    expect(f.manager.connect).not.toHaveBeenCalled();
  });

  it.each(["", "https://other.invalid"])(
    "rejects websocket upgrade with missing or wrong Origin: %s",
    async (origin) => {
      const f = await fixture();
      const result = await rejected(
        f.client(SOCKET_PATH, ["oci-console", `ticket.${TICKET}`], { origin }),
      );
      expect(result.status).toBe(403);
      expect(f.manager.connect).not.toHaveBeenCalled();
    },
  );

  it("rejects websocket cross-site metadata even with an allowed Origin", async () => {
    const f = await fixture();
    const result = await rejected(
      f.client(SOCKET_PATH, ["oci-console", `ticket.${TICKET}`], {
        "sec-fetch-site": "cross-site",
      }),
    );
    expect(result.status).toBe(403);
    expect(f.manager.connect).not.toHaveBeenCalled();
  });

  it.each([
    { "sec-websocket-key": "not-a-valid-websocket-key" },
    { "sec-websocket-key": "" },
    { "sec-websocket-version": "12" },
    { "sec-websocket-version": "8" },
  ])(
    "rejects invalid standard websocket handshake headers before consuming a ticket: %j",
    async (override) => {
      const f = await fixture();
      const result = await http(f.port, SOCKET_PATH, {
        headers: {
          cookie: COOKIE,
          origin: ORIGIN,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
          "sec-websocket-protocol": `oci-console, ticket.${TICKET}`,
          ...override,
        },
      });
      expect(result.status).toBe(400);
      expect(f.manager.connect).not.toHaveBeenCalled();
    },
  );

  it.each([
    [],
    ["oci-console"],
    [`ticket.${TICKET}`],
    ["unknown-protocol", `ticket.${TICKET}`],
    ["oci-console", "ticket.short"],
    ["oci-console", `ticket.${TICKET}`, "unexpected-third-protocol"],
  ])(
    "rejects missing, malformed or extra websocket protocols: %j",
    async (...protocols: string[]) => {
      const f = await fixture();
      const result = await rejected(f.client(SOCKET_PATH, protocols));
      expect(result.status).toBe(403);
      expect(f.manager.connect).not.toHaveBeenCalled();
    },
  );

  it("rejects tickets in query strings and unknown upgrade paths", async () => {
    const f = await fixture();
    for (const path of [
      `${SOCKET_PATH}?ticket=${TICKET}`,
      "/unrelated/socket",
      "/api/console/sessions/not-a-uuid/socket",
    ]) {
      const result = await rejected(f.client(path));
      expect(result.status).toBe(404);
      expect(result.body.toString()).not.toContain(TICKET);
    }
    expect(f.manager.connect).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
    expect(f.recordEvent).not.toHaveBeenCalled();
  });

  it("does not leak tickets in rejected upgrade responses or error logging", async () => {
    const f = await fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.manager.connect.mockRejectedValue(new Error(`mock transport failed with ticket ${TICKET}`));
    const result = await rejected(f.client());
    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
    expect(JSON.stringify(result.headers)).not.toContain(TICKET);
    expect(JSON.stringify(errors.mock.calls)).not.toContain(TICKET);
    expect(JSON.stringify(warnings.mock.calls)).not.toContain(TICKET);
    expect(JSON.stringify(f.recordEvent.mock.calls)).not.toContain(TICKET);
  });
});

describe("console gateway binary transport and closure", () => {
  it("forwards binary data in both directions and selects only the public protocol", async () => {
    const f = await fixture(),
      client = await f.open();
    expect(client.protocol).toBe("oci-console");
    expect(f.authenticate).toHaveBeenCalledTimes(1);
    const request = f.authenticate.mock.calls[0][0];
    expect(request.headers.get("cookie")).toBe(COOKIE);
    expect(request.headers.get("origin")).toBe(ORIGIN);
    expect(new URL(request.url).search).toBe("");
    expect(f.manager.connect).toHaveBeenCalledWith(SESSION_ID, TICKET, actor);
    const toServer = Buffer.from([0, 255, 12, 128, 37]);
    client.send(toServer);
    await vi.waitFor(() => expect(Buffer.concat(f.received)).toEqual(toServer));
    const message = once(client, "message");
    const toClient = Buffer.from([255, 0, 128, 90, 7]);
    f.stream.push(toClient);
    const [data, isBinary] = await message;
    expect(bytes(data as RawData)).toEqual(toClient);
    expect(isBinary).toBe(true);
    expect(f.recordEvent).toHaveBeenCalledWith(
      actor,
      "console.connect",
      SESSION_ID,
      expect.any(String),
    );
    expect(JSON.stringify(f.recordEvent.mock.calls)).not.toContain(TICKET);
  });

  it("destroys the backend stream when the websocket client disconnects", async () => {
    const f = await fixture(),
      client = await f.open();
    const closed = once(f.stream, "close");
    client.close();
    await closed;
    expect(f.stream.destroyed).toBe(true);
  });

  it.each(["close", "error"] as const)(
    "closes the websocket after backend stream %s",
    async (event) => {
      const f = await fixture(),
        client = await f.open();
      const closed = once(client, "close");
      if (event === "close") f.stream.destroy();
      else f.stream.destroy(new Error("mock transport error"));
      await closed;
      expect(client.readyState).toBe(WebSocket.CLOSED);
    },
  );

  it("closes clients and calls manager shutdown when the gateway stops", async () => {
    const f = await fixture(),
      client = await f.open();
    const closed = once(client, "close");
    await f.gateway.close();
    await closed;
    expect(client.readyState).toBe(WebSocket.CLOSED);
    expect(f.stream.destroyed).toBe(true);
    expect(f.manager.shutdown).toHaveBeenCalledTimes(1);
    expect(f.server.listening).toBe(true);
    expect((await http(f.port, "/normal-page")).status).toBe(201);
    const unavailable = await f.api("/api/console/session");
    expect(unavailable.status).toBe(503);
    expect(JSON.parse(unavailable.body.toString())).toMatchObject({ code: "CONSOLE_UNAVAILABLE" });
    const denied = await rejected(f.client());
    expect(denied.status).toBe(503);
    expect(f.manager.connect).toHaveBeenCalledTimes(1);
    await f.gateway.close();
    expect(f.manager.shutdown).toHaveBeenCalledTimes(1);
  });

  it("terminates pending upgrades and destroys a backend connection that finishes after close", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lateStream = new Duplex({
      read() {},
      write(_chunk, _encoding, done) {
        done();
      },
    });
    f.manager.connect.mockImplementation(async () => {
      await pending;
      return lateStream;
    });
    const client = f.client();
    const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
    try {
      await vi.waitFor(() => expect(f.manager.connect).toHaveBeenCalledOnce());
      await f.gateway.close();
      await closed;
      expect(client.readyState).toBe(WebSocket.CLOSED);
      expect(f.manager.shutdown).toHaveBeenCalledOnce();
      expect(lateStream.destroyed).toBe(false);
      release();
      await vi.waitFor(() => expect(lateStream.destroyed).toBe(true));
      expect(f.recordEvent).not.toHaveBeenCalled();
    } finally {
      release();
      lateStream.destroy();
    }
  });

  it("waits for manager shutdown without taking ownership of the shared HTTP server", async () => {
    const f = await fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.manager.shutdown.mockImplementation(async () => {
      await pending;
      f.stream.destroy();
    });
    let stopped = false;
    const closing = f.gateway.close().then(() => {
      stopped = true;
    });
    try {
      expect(f.manager.shutdown).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(f.server.listening).toBe(true);
      release();
      await closing;
      expect(stopped).toBe(true);
    } finally {
      release();
      await closing;
    }
  });

  it.each(["revoked", "changed-owner"] as const)(
    "revalidates an open websocket and closes it when authentication is %s",
    async (change) => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const f = await fixture(),
        client = await f.open();
      if (change === "revoked")
        f.authenticate.mockImplementation(() => {
          throw new AppError("login revoked", 401, "UNAUTHORIZED");
        });
      else f.authenticate.mockReturnValue({ ...actor, sessionHash: "different-login" });
      const closed = once(client, "close");
      const backendClosed = once(f.stream, "close");
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.all([closed, backendClosed]);
      expect(f.authenticate).toHaveBeenCalledTimes(2);
      expect(f.stream.destroyed).toBe(true);
      expect(client.readyState).toBe(WebSocket.CLOSED);
    },
  );
});
