import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import type { ConsoleGateway } from "../console/gateway";
import type { RunWorkerOptions } from "../jobs/worker";
import { json } from "../http";
import { createHttpHandler, type PageHandler } from "./http";
import { version } from "../../../package.json";

interface NextService {
  prepare(): Promise<void>;
  handle: PageHandler;
  close(): Promise<void>;
}
interface ConsoleService extends ConsoleGateway {
  initialize(): Promise<void>;
}
export interface ApplicationServices {
  initialize(): Promise<void>;
  next(server: Server): NextService;
  console(): ConsoleService;
  worker(options: RunWorkerOptions): Promise<void>;
  api(request: Request, segments: string[]): Promise<Response>;
  healthy(workerId: string, startedAt: number): boolean;
  closeDatabase(): void;
}
interface ApplicationOptions {
  port: number;
  host: string;
  dev?: boolean;
  origin?: string;
  services: ApplicationServices;
  shutdownTimeoutMs?: number;
  startupTimeoutMs?: number;
  onError?(error: unknown): void;
}
type ApplicationState = "starting" | "running" | "stopping" | "failed" | "stopped";

/** One owner for HTTP, the task loop and all shutdown decisions. No import starts work. */
export function createApplication(options: ApplicationOptions) {
  const workerId = randomUUID();
  const startedAt = Date.now();
  const services = options.services;
  const shutdown = new AbortController();
  const sockets = new Set<Duplex>();
  const upgradedSockets = new Set<Duplex>();
  const pendingRequests = new Set<Promise<void>>();
  let state: ApplicationState = "starting";
  let next: NextService | undefined;
  let consoleService: ConsoleService | undefined;
  let workerDone: Promise<void> | undefined;
  let workerReady = false;
  let startPromise: Promise<void> | undefined;
  let startupSettled = Promise.resolve();
  let closing = false;
  let failed = false;
  let startupTimer: NodeJS.Timeout | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let complete!: (exitCode: number) => void;
  const completion = new Promise<number>((resolve) => {
    complete = resolve;
  });
  const ready = () => state === "running" && workerReady;
  const health = () => {
    try {
      if (ready() && services.healthy(workerId, startedAt))
        return json({ ok: true, version: process.env.APP_VERSION ?? version });
    } catch {
      // A health request must never initialize a replacement database or hide a failed runner.
    }
    return json({ ok: false }, 503);
  };
  const handler = createHttpHandler({
    origin: options.origin,
    ready,
    health,
    api: (request, segments) => services.api(request, segments),
    console: () => consoleService,
    page: async (request, response) => {
      if (!next) throw new Error("Next is not prepared");
      await next.handle(request, response);
    },
  });
  const server = createServer({ maxHeaderSize: 16_384 }, (request, response) => {
    const pending = handler(request, response)
      .catch(() => {
        response.destroy();
      })
      .finally(() => pendingRequests.delete(pending));
    pendingRequests.add(pending);
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    const path = request.url ?? "";
    // Next registers its own HMR upgrade handler on this server. Do not call it twice.
    if (
      options.dev &&
      ready() &&
      path.startsWith("/_next/hmr") &&
      server.listenerCount("upgrade") > 1
    )
      return;
    if (ready() && path.startsWith("/api/console/")) {
      void consoleService!.upgrade(request, socket, head).catch(() => socket.destroy());
    } else {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });
  server.on("error", (error) => {
    stop(error);
  });

  function reportFailure(error: unknown) {
    if (failed) return;
    failed = true;
    try {
      options.onError?.(error);
    } catch {
      /* Logging cannot prevent shutdown. */
    }
  }

  function stop(error?: unknown): Promise<number> {
    if (error !== undefined) reportFailure(error);
    if (closing) return completion;
    closing = true;
    state = failed ? "failed" : "stopping";
    workerReady = false;
    clearTimeout(startupTimer);
    shutdown.abort(error ?? new Error("Application shutdown requested"));
    // HTTP close does not own upgraded sockets, including Next's HMR clients.
    for (const socket of upgradedSockets) socket.destroy();
    shutdownTimer = setTimeout(() => {
      reportFailure(new Error("Application shutdown timed out"));
      state = "failed";
      for (const socket of sockets) socket.destroy();
      server.close();
      // Do not close SQLite under still-running tasks. The process owner exits on completion.
      complete(1);
    }, options.shutdownTimeoutMs ?? 25_000);
    void (async () => {
      await startupSettled;
      const httpClosed = new Promise<void>((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
        server.closeIdleConnections();
      });
      const settled = await Promise.allSettled([
        httpClosed,
        (async () => {
          while (pendingRequests.size) await Promise.allSettled([...pendingRequests]);
        })(),
        workerDone,
        consoleService?.close(),
        next?.close(),
      ]);
      for (const result of settled) if (result.status === "rejected") reportFailure(result.reason);
      try {
        services.closeDatabase();
      } catch (error) {
        reportFailure(error);
      }
      clearTimeout(shutdownTimer);
      state = "stopped";
      complete(failed ? 1 : 0);
    })().catch(() => {
      clearTimeout(shutdownTimer);
      state = "failed";
      complete(1);
    });
    return completion;
  }

  function start(): Promise<void> {
    if (startPromise) return startPromise;
    if (closing) return Promise.reject(new Error("Application is stopping"));
    let finishStartup!: () => void;
    startupSettled = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    startupTimer = setTimeout(() => {
      stop(new Error("Application startup timed out"));
    }, options.startupTimeoutMs ?? 120_000);
    startPromise = (async () => {
      // Reserve the port before opening the database or allowing any queued cloud operation.
      await new Promise<void>((resolve, reject) => {
        const error = (reason: Error) => reject(reason);
        server.once("error", error);
        server.listen(options.port, options.host, () => {
          server.removeListener("error", error);
          resolve();
        });
      });
      if (shutdown.signal.aborted) return;
      await services.initialize();
      if (shutdown.signal.aborted) return;
      next = services.next(server);
      await next.prepare();
      if (shutdown.signal.aborted) return;
      consoleService = services.console();
      await consoleService.initialize();
      if (shutdown.signal.aborted) return;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(shutdown.signal.reason);
        shutdown.signal.addEventListener("abort", aborted, { once: true });
        workerDone = Promise.resolve().then(() =>
          services.worker({
            workerId,
            signal: shutdown.signal,
            onReady() {
              shutdown.signal.removeEventListener("abort", aborted);
              workerReady = true;
              resolve();
            },
            onFatal(error) {
              reject(error);
              stop(error);
            },
          }),
        );
        void workerDone
          .then(
            () => {
              if (!closing) stop(new Error("Task executor stopped unexpectedly"));
            },
            (error) => {
              reject(error);
              stop(error);
            },
          )
          .finally(() => shutdown.signal.removeEventListener("abort", aborted));
      });
      if (shutdown.signal.aborted) return;
      state = "running";
      if (options.dev) {
        // Next installs its HMR listener on the first page request. Warm it once so an
        // already-open browser can reconnect after a backend restart without reloading.
        const address = server.address() as AddressInfo;
        const host =
          address.address === "::"
            ? "[::1]"
            : address.address === "0.0.0.0"
              ? "127.0.0.1"
              : address.family === "IPv6"
                ? `[${address.address}]`
                : address.address;
        const response = await fetch(`http://${host}:${address.port}/favicon.ico`, {
          signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(10_000)]),
          headers: { Connection: "close" },
        });
        await response.arrayBuffer();
      }
    })()
      .catch((error) => {
        if (!closing) stop(error);
        if (failed) throw error;
      })
      .finally(() => {
        clearTimeout(startupTimer);
        finishStartup();
      });
    return startPromise;
  }
  return {
    server,
    workerId,
    completion,
    start,
    stop,
    get state() {
      return state;
    },
  };
}
