import { once } from "node:events";
import { request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication, type ApplicationServices } from "@/server/runtime/application";
import type { RunWorkerOptions } from "@/server/jobs/worker";
import { json } from "@/server/http";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const apps: ReturnType<typeof createApplication>[] = [];
function fixture(
  overrides: Partial<ApplicationServices> = {},
  timeout = 1000,
  port = 0,
  options: { dev?: boolean } = {},
) {
  const order: string[] = [];
  let workerOptions: RunWorkerOptions | undefined;
  const services: ApplicationServices = {
    initialize: vi.fn(async () => {
      order.push("initialize");
    }),
    next: vi.fn(() => ({
      prepare: vi.fn(async () => {
        order.push("next.ready");
      }),
      handle: vi.fn(async (_request, response) => {
        response.end("Next");
      }),
      close: vi.fn(async () => {
        order.push("next.closed");
      }),
    })),
    console: vi.fn(() => ({
      initialize: vi.fn(async () => {
        order.push("console.ready");
      }),
      handleRequest: vi.fn(async () => json({ console: true })),
      upgrade: vi.fn(async (_request, socket) => {
        socket.end();
      }),
      close: vi.fn(async () => {
        order.push("console.closed");
      }),
    })),
    worker: vi.fn(async (options) => {
      workerOptions = options;
      order.push("worker.ready");
      options.onReady?.();
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      order.push("worker.closed");
    }),
    api: vi.fn(async () => json({ api: true })),
    healthy: vi.fn(() => true),
    closeDatabase: vi.fn(() => {
      order.push("database.closed");
    }),
    ...overrides,
  };
  const app = createApplication({
    port,
    host: "127.0.0.1",
    services,
    shutdownTimeoutMs: timeout,
    ...options,
  });
  apps.push(app);
  const origin = () => `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return {
    app,
    services,
    order,
    origin,
    get workerOptions() {
      return workerOptions!;
    },
  };
}

function upgrade(origin: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(origin + path, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": Buffer.alloc(16, 1).toString("base64"),
      },
    });
    request.once("response", (response) => {
      response.resume();
      response.once("error", reject);
      response.once("end", () => resolve(response.statusCode!));
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Synthetic upgrade handlers must return an HTTP status"));
    });
    request.once("error", reject);
    request.setTimeout(1000, () => request.destroy(new Error("Upgrade dispatch timed out")));
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.stop()));
  vi.restoreAllMocks();
});

describe("single-process application lifecycle", () => {
  it("reserves its port before initialization and stays unavailable until the worker is ready", async () => {
    const initialized = deferred();
    const workerReady = deferred();
    const f = fixture({
      initialize: async () => {
        await initialized.promise;
      },
      worker: async (options) => {
        await workerReady.promise;
        options.onReady?.();
        await new Promise<void>((resolve) =>
          options.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const starting = f.app.start();
    await once(f.app.server, "listening");
    expect((await fetch(f.origin() + "/api/health")).status).toBe(503);
    expect((await fetch(f.origin() + "/instances")).status).toBe(503);
    initialized.resolve();
    await vi.waitFor(() => expect(f.services.next).toHaveBeenCalledTimes(1));
    expect((await fetch(f.origin() + "/api/health")).status).toBe(503);
    workerReady.resolve();
    await starting;
    expect(f.app.state).toBe("running");
    expect(await (await fetch(f.origin() + "/api/health")).json()).toMatchObject({ ok: true });
    expect(await (await fetch(f.origin() + "/api/example")).json()).toEqual({ api: true });
    expect(await (await fetch(f.origin() + "/instances")).text()).toBe("Next");
  });

  it("starts exactly once and closes SQLite after HTTP, console and tasks drain", async () => {
    const workerStopped = deferred();
    let aborted = false;
    const f = fixture({
      worker: vi.fn(async (options) => {
        options.onReady?.();
        options.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        await workerStopped.promise;
      }),
    });
    await Promise.all([f.app.start(), f.app.start()]);
    expect(f.services.initialize).toHaveBeenCalledTimes(1);
    expect(f.services.worker).toHaveBeenCalledTimes(1);
    const stopping = f.app.stop();
    expect(aborted).toBe(true);
    await vi.waitFor(() => expect(f.order).toContain("console.closed"));
    expect(f.services.closeDatabase).not.toHaveBeenCalled();
    workerStopped.resolve();
    expect(await stopping).toBe(0);
    expect(f.order.at(-1)).toBe("database.closed");
  });

  it("waits for a disconnected API handler before closing its database", async () => {
    const entered = deferred();
    const disconnected = deferred();
    const pending = deferred();
    const f = fixture({
      api: async (request) => {
        request.signal.addEventListener("abort", disconnected.resolve, { once: true });
        entered.resolve();
        await pending.promise;
        f.order.push("api.finished");
        return json({ api: true });
      },
    });
    await f.app.start();
    const request = httpRequest(f.origin() + "/api/pending");
    request.on("error", () => undefined);
    request.end();
    try {
      await entered.promise;
      request.destroy();
      await disconnected.promise;
      let stopped = false;
      const stopping = f.app.stop().then((code) => {
        stopped = true;
        return code;
      });
      await vi.waitFor(() => expect(f.order).toContain("console.closed"));
      expect(stopped).toBe(false);
      expect(f.services.closeDatabase).not.toHaveBeenCalled();
      pending.resolve();
      expect(await stopping).toBe(0);
      expect(f.order.indexOf("api.finished")).toBeLessThan(f.order.indexOf("database.closed"));
      expect(f.services.closeDatabase).toHaveBeenCalledOnce();
    } finally {
      pending.resolve();
      request.destroy();
      await f.app.stop();
    }
  });

  it("stops normally during worker initialization without declaring readiness or failing startup", async () => {
    const entered = deferred();
    const initializing = deferred();
    const announced = vi.fn();
    let workerSignal: AbortSignal | undefined;
    const f = fixture({
      worker: async (options) => {
        workerSignal = options.signal;
        entered.resolve();
        await initializing.promise;
        if (options.signal.aborted) return;
        announced();
        options.onReady?.();
      },
    });
    const starting = f.app.start();
    try {
      await entered.promise;
      const stopping = f.app.stop();
      expect(workerSignal?.aborted).toBe(true);
      expect(f.services.closeDatabase).not.toHaveBeenCalled();
      initializing.resolve();
      await expect(starting).resolves.toBeUndefined();
      expect(await stopping).toBe(0);
      expect(announced).not.toHaveBeenCalled();
      expect(f.app.state).toBe("stopped");
      expect(f.app.server.listening).toBe(false);
      expect(f.services.closeDatabase).toHaveBeenCalledOnce();
    } finally {
      initializing.resolve();
      await f.app.stop();
      await starting.catch(() => undefined);
    }
  });

  it("closes a listener that finishes binding after an immediate stop", async () => {
    const f = fixture();
    let listening = false;
    f.app.server.once("listening", () => {
      listening = true;
    });
    const starting = f.app.start();
    expect(listening).toBe(false);
    const stopping = f.app.stop();
    await starting;
    expect(await stopping).toBe(0);
    expect(f.app.state).toBe("stopped");
    expect(f.app.server.listening).toBe(false);
    expect(f.app.server.address()).toBeNull();
    expect(f.services.initialize).not.toHaveBeenCalled();
    expect(f.services.worker).not.toHaveBeenCalled();
    expect(f.services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("fails immediately on a runner fatal notification while its active work is still draining", async () => {
    const active = deferred();
    let options!: RunWorkerOptions;
    const f = fixture({
      worker: async (input) => {
        options = input;
        input.onReady?.();
        await active.promise;
      },
    });
    await f.app.start();
    options.onFatal?.(new Error("synthetic database failure"));
    expect(f.app.state).toBe("failed");
    expect(options.signal.aborted).toBe(true);
    expect(f.services.closeDatabase).not.toHaveBeenCalled();
    active.resolve();
    expect(await f.app.completion).toBe(1);
  });

  it("rejects a port conflict before opening another database or task loop", async () => {
    const first = fixture();
    await first.app.start();
    const second = fixture({}, 1000, (first.app.server.address() as AddressInfo).port);
    await expect(second.app.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(await second.app.completion).toBe(1);
    expect(second.services.initialize).not.toHaveBeenCalled();
    expect(second.services.worker).not.toHaveBeenCalled();
    expect(first.app.state).toBe("running");
  });

  it("cleans up partial startup without launching a worker", async () => {
    const f = fixture({
      next: () => ({
        prepare: async () => {
          throw new Error("synthetic prepare failure");
        },
        handle: vi.fn(),
        close: vi.fn(async () => undefined),
      }),
    });
    await expect(f.app.start()).rejects.toThrow("synthetic prepare failure");
    expect(await f.app.completion).toBe(1);
    expect(f.services.worker).not.toHaveBeenCalled();
    expect(f.app.server.listening).toBe(false);
    expect(f.services.closeDatabase).toHaveBeenCalledOnce();
  });

  it("bounds stalled task shutdown without closing its database underneath it", async () => {
    const active = deferred();
    const f = fixture(
      {
        worker: async (options) => {
          options.onReady?.();
          await active.promise;
        },
      },
      30,
    );
    await f.app.start();
    expect(await f.app.stop()).toBe(1);
    expect(f.services.closeDatabase).not.toHaveBeenCalled();
    active.resolve();
    await vi.waitFor(() => expect(f.services.closeDatabase).toHaveBeenCalledOnce());
  });

  it("makes an expired runner heartbeat or database failure unhealthy without querying OCI", async () => {
    const healthy = vi.fn(() => true);
    const f = fixture({ healthy });
    await f.app.start();
    healthy.mockReturnValue(false);
    expect((await fetch(f.origin() + "/api/health")).status).toBe(503);
    healthy.mockImplementation(() => {
      throw new Error("database unavailable");
    });
    expect((await fetch(f.origin() + "/api/health")).status).toBe(503);
    expect(f.services.api).not.toHaveBeenCalled();
  });

  it("routes console upgrades through the actual application and rejects unrelated upgrade paths", async () => {
    const consoleService = {
      initialize: vi.fn(async () => undefined),
      handleRequest: vi.fn(async () => json({ console: true })),
      upgrade: vi.fn(async (_request: IncomingMessage, socket: Duplex) => {
        socket.end(
          "HTTP/1.1 426 Synthetic Console\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
      }),
      close: vi.fn(async () => undefined),
    } satisfies ReturnType<ApplicationServices["console"]>;
    const f = fixture({ console: () => consoleService });
    await f.app.start();
    const path = "/api/console/sessions/01234567-89ab-cdef-0123-456789abcdef/socket";
    expect(await upgrade(f.origin(), path)).toBe(426);
    expect(consoleService.upgrade).toHaveBeenCalledOnce();
    expect(consoleService.upgrade.mock.calls[0][0].url).toBe(path);
    for (const path of ["/unrelated/socket", "/_next/hmr"]) {
      expect(await upgrade(f.origin(), path)).toBe(503);
    }
    expect(consoleService.upgrade).toHaveBeenCalledOnce();
    expect(f.services.api).not.toHaveBeenCalled();
  });

  it("rejects development HMR upgrades promptly when no Next listener has registered", async () => {
    const f = fixture({}, 1000, 0, { dev: true });
    await f.app.start();
    expect(f.app.server.listenerCount("upgrade")).toBe(1);
    expect(await upgrade(f.origin(), "/_next/hmr?sessionId=synthetic")).toBe(503);
    expect(f.app.state).toBe("running");
  });

  it("warms the development page handler and leaves HMR to its single registered listener", async () => {
    const hmrRequests: string[] = [];
    const nextHandler = vi.fn();
    const f = fixture(
      {
        next: (server) => {
          let registered = false;
          const onUpgrade = (request: IncomingMessage, socket: Duplex) => {
            if (!request.url?.startsWith("/_next/hmr")) return;
            hmrRequests.push(request.url);
            socket.end(
              "HTTP/1.1 426 Synthetic HMR\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
          };
          return {
            prepare: async () => undefined,
            handle: async (request, response) => {
              nextHandler(request.url);
              if (!registered) {
                registered = true;
                server.on("upgrade", onUpgrade);
              }
              response.end("Synthetic Next");
            },
            close: async () => {
              server.removeListener("upgrade", onUpgrade);
            },
          };
        },
      },
      1000,
      0,
      { dev: true },
    );
    await f.app.start();
    expect(nextHandler).toHaveBeenCalledExactlyOnceWith("/favicon.ico");
    expect(f.app.server.listenerCount("upgrade")).toBe(2);
    const path = "/_next/hmr?sessionId=synthetic";
    expect(await upgrade(f.origin(), path)).toBe(426);
    expect(hmrRequests).toEqual([path]);
    expect(await upgrade(f.origin(), "/unrelated/socket")).toBe(503);
    expect(hmrRequests).toEqual([path]);
    expect(f.services.api).not.toHaveBeenCalled();
  });

  it("terminates an open HMR transport during normal shutdown and closes SQLite after owned services", async () => {
    const websocket = new WebSocketServer({ noServer: true });
    const serverConnectionClosed = deferred();
    let connectionClosed = false;
    let upgradedSocket: Duplex | undefined;
    let transportDestroyedAtDatabaseClose = false;
    websocket.on("connection", (client) => {
      client.once("close", () => {
        connectionClosed = true;
        f.order.push("hmr.closed");
        serverConnectionClosed.resolve();
      });
    });
    const f = fixture(
      {
        next: (server) => {
          let registered = false;
          const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
            if (!request.url?.startsWith("/_next/hmr")) return;
            upgradedSocket = socket;
            websocket.handleUpgrade(request, socket, head, (client) => {
              websocket.emit("connection", client, request);
            });
          };
          return {
            prepare: async () => undefined,
            handle: async (_request, response) => {
              if (!registered) {
                registered = true;
                server.on("upgrade", onUpgrade);
              }
              response.end("Synthetic Next");
            },
            close: async () => {
              // Real Next.close() can finish without closing its HMR connections.
              server.removeListener("upgrade", onUpgrade);
              f.order.push("next.closed");
            },
          };
        },
        closeDatabase: vi.fn(() => {
          transportDestroyedAtDatabaseClose = upgradedSocket?.destroyed === true;
          f.order.push("database.closed");
        }),
      },
      1000,
      0,
      { dev: true },
    );
    let client: WebSocket | undefined;
    try {
      await f.app.start();
      client = new WebSocket(f.origin().replace(/^http:/, "ws:") + "/_next/hmr");
      client.on("error", () => undefined);
      await once(client, "open");
      expect(websocket.clients.size).toBe(1);
      expect(connectionClosed).toBe(false);
      expect(f.services.closeDatabase).not.toHaveBeenCalled();
      const closed = once(client, "close");
      expect(await f.app.stop()).toBe(0);
      await Promise.all([closed, serverConnectionClosed.promise]);
      expect(client.readyState).toBe(WebSocket.CLOSED);
      expect(connectionClosed).toBe(true);
      expect(websocket.clients.size).toBe(0);
      expect(transportDestroyedAtDatabaseClose).toBe(true);
      for (const closed of ["worker.closed", "console.closed", "next.closed"]) {
        expect(f.order.indexOf(closed)).toBeGreaterThanOrEqual(0);
        expect(f.order.indexOf(closed)).toBeLessThan(f.order.indexOf("database.closed"));
      }
      expect(f.services.closeDatabase).toHaveBeenCalledOnce();
      expect(f.app.server.listening).toBe(false);
      expect(f.app.state).toBe("stopped");
    } finally {
      client?.terminate();
      await f.app.stop();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
    }
  });
});
