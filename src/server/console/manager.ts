import { randomBytes, randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import type { ConsoleSessionSummary, ConsoleSocketTicket } from "../../lib/console-contracts";
import { getCredentials } from "../accounts";
import { getDatabase, isDemo } from "../db";
import { AppError, safeMessage } from "../errors";
import { getInstance } from "../inventory";
import { CloudError } from "../oci/types";
import {
  consoleSummary,
  createConsoleStore,
  type ConsoleSessionRecord,
  type ConsoleSessionStore,
} from "./store";
import type { ConsoleActor, ConsoleTarget, ConsoleTransport, ConsoleTunnel } from "./types";

export interface ConsoleManager {
  initialize(): Promise<void>;
  current(actor: ConsoleActor): ConsoleSessionSummary | null;
  create(instanceId: string, actor: ConsoleActor): Promise<ConsoleSessionSummary>;
  get(id: string, actor: ConsoleActor): ConsoleSessionSummary;
  issueTicket(id: string, actor: ConsoleActor): ConsoleSocketTicket;
  connect(id: string, ticket: string, actor: ConsoleActor): Promise<Duplex>;
  touch(id: string, actor: ConsoleActor): void;
  close(id: string, actor: ConsoleActor): Promise<void>;
  shutdown(): Promise<void>;
}

export interface ConsoleLimits {
  ticketTtlMs: number;
  idleTimeoutMs: number;
  maxDurationMs: number;
  readyTimeoutMs: number;
  prepareTimeoutMs: number;
  connectTimeoutMs: number;
  cleanupTimeoutMs: number;
  checkIntervalMs: number;
  cleanupRetryMs: number;
}

export interface ConsoleManagerOptions {
  transport: ConsoleTransport;
  store?: ConsoleSessionStore;
  resolveTarget?: (instanceId: string) => ConsoleTarget;
  resolveCleanupTarget?: (record: ConsoleSessionRecord) => ConsoleTarget;
  isActorValid?: (actor: ConsoleActor) => boolean;
  clock?: () => number;
  limits?: Partial<ConsoleLimits>;
}

const defaultLimits: ConsoleLimits = {
  ticketTtlMs: 30_000,
  idleTimeoutMs: 15 * 60_000,
  maxDurationMs: 60 * 60_000,
  readyTimeoutMs: 60_000,
  prepareTimeoutMs: 120_000,
  connectTimeoutMs: 15_000,
  cleanupTimeoutMs: 10_000,
  checkIntervalMs: 5_000,
  cleanupRetryMs: 15_000,
};

interface Runtime {
  id: string;
  target?: ConsoleTarget;
  controller: AbortController;
  preparePending: boolean;
  prepared?: Promise<void>;
  tunnel?: ConsoleTunnel;
  stream?: Duplex;
  connecting: boolean;
  closing?: Promise<void>;
  cleanupOperation?: Promise<void>;
  lastCleanupAt: number;
  terminal: "closed" | "failed";
  terminalError: string | null;
  ticket?: { value: string; expiresAt: number };
}

const actorFrom = (row: ConsoleSessionRecord): ConsoleActor => ({
  userId: row.ownerUserId,
  username: row.ownerUsername,
  sessionHash: row.ownerSessionHash,
});

function defaultTarget(instanceId: string): ConsoleTarget {
  const instance = getInstance(instanceId);
  if (instance.state === "TERMINATED" || instance.state === "TERMINATING")
    throw new AppError("已终止的实例不能打开控制台", 409, "INSTANCE_TERMINATED");
  return {
    instanceId: instance.id,
    instanceName: instance.displayName,
    accountId: instance.accountId,
    region: instance.region,
    credentials: getCredentials(instance.accountId, instance.region),
  };
}

/** Cloud operations are detached from HTTP. The durable slot remains held until cleanup is proven. */
export function createConsoleManager(options: ConsoleManagerOptions): ConsoleManager {
  const store = options.store ?? createConsoleStore();
  const clock = options.clock ?? Date.now;
  const limits = { ...defaultLimits, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Console limit ${name} must be positive`);
  }
  const resolveTarget = options.resolveTarget ?? defaultTarget;
  const resolveCleanupTarget =
    options.resolveCleanupTarget ??
    (options.resolveTarget
      ? (row: ConsoleSessionRecord) => resolveTarget(row.instanceId)
      : (row: ConsoleSessionRecord): ConsoleTarget => ({
          instanceId: row.instanceId,
          instanceName: row.instanceName,
          accountId: row.accountId,
          region: row.region,
          credentials: getCredentials(row.accountId, row.region),
        }));
  const isActorValid =
    options.isActorValid ??
    ((actor: ConsoleActor) =>
      !!getDatabase()
        .prepare("SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?")
        .get(actor.sessionHash, actor.userId, new Date(clock()).toISOString()));
  const runtimes = new Map<string, Runtime>();
  let initialized = false;
  let initializing: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;

  const timestamp = () => new Date(clock()).toISOString();
  const runtimeFor = (row: ConsoleSessionRecord): Runtime => {
    let runtime = runtimes.get(row.id);
    if (!runtime) {
      runtime = {
        id: row.id,
        controller: new AbortController(),
        preparePending: false,
        connecting: false,
        lastCleanupAt: -Infinity,
        terminal: row.state === "failed" ? "failed" : "closed",
        terminalError: row.lastError,
      };
      runtimes.set(row.id, runtime);
    }
    return runtime;
  };
  function ensureInitialized() {
    if (!initialized || stopped)
      throw new AppError("控制台服务尚未就绪", 503, "CONSOLE_UNAVAILABLE");
  }
  function validateActor(actor: ConsoleActor) {
    if (!actor.userId || !actor.sessionHash || !isActorValid(actor))
      throw new AppError("登录已过期，请重新登录", 401, "UNAUTHORIZED");
  }
  function owned(id: string, actor: ConsoleActor): ConsoleSessionRecord {
    ensureInitialized();
    validateActor(actor);
    const row = store.get(id);
    if (!row) throw new AppError("控制台会话不存在", 404, "CONSOLE_NOT_FOUND");
    if (row.ownerUserId !== actor.userId || row.ownerSessionHash !== actor.sessionHash)
      throw new AppError("控制台由另一个登录会话占用", 403, "CONSOLE_FORBIDDEN");
    return row;
  }

  function expirationReason(row: ConsoleSessionRecord): string | null {
    if (clock() >= Date.parse(row.expiresAt)) return "控制台已达到最长会话时间。";
    if (clock() - Date.parse(row.lastActivityAt) >= limits.idleTimeoutMs)
      return "长时间无操作，控制台会话已结束。";
    if (
      row.state === "ready" &&
      row.readyAt &&
      clock() - Date.parse(row.readyAt) >= limits.readyTimeoutMs
    )
      return "控制台就绪后未连接，会话已结束。";
    if (row.state === "preparing" && clock() - Date.parse(row.createdAt) >= limits.prepareTimeoutMs)
      return "控制台连接准备超时。";
    return null;
  }

  function assertNotExpired(row: ConsoleSessionRecord) {
    if (row.slot !== 1 || row.cleanupPending) return;
    const reason = expirationReason(row);
    if (!reason) return;
    void cleanup(runtimeFor(row), row.state === "preparing" ? "failed" : "closed", reason);
    throw new AppError("控制台会话已过期，请重新创建", 410, "CONSOLE_EXPIRED");
  }

  async function bounded<T>(operation: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => {
            onTimeout();
            reject(new Error("Console operation timed out"));
          }, ms);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }

  function cleanup(
    runtime: Runtime,
    terminal: "closed" | "failed" = runtime.terminal,
    error: string | null = runtime.terminalError,
  ): Promise<void> {
    runtime.terminal = terminal;
    runtime.terminalError = error;
    runtime.ticket = undefined;
    runtime.controller.abort();
    runtime.stream?.destroy();
    // Demo startup can point at an existing database. It must not delete its cloud resources.
    if (isDemo()) return Promise.resolve();
    if (runtime.closing) return runtime.closing;
    const row = store.get(runtime.id);
    if (!row || row.slot !== 1) return Promise.resolve();
    store.update(row.id, { state: "closing", cleanupPending: true, lastError: error });
    runtime.lastCleanupAt = clock();
    runtime.closing = Promise.resolve().then(async () => {
      const abort = new AbortController();
      try {
        // A cancelled start may still create its OCI connection. Never release the slot first.
        if (!runtime.cleanupOperation) {
          const operation = (async () => {
            if (runtime.preparePending) await runtime.prepared;
            if (runtime.preparePending) throw new Error("Console preparation still running");
            if (isDemo()) throw new Error("Cloud cleanup is disabled in demo mode");
            if (runtime.tunnel) await runtime.tunnel.close();
            const latest = store.get(runtime.id)!;
            const target = runtime.target ?? resolveCleanupTarget(latest);
            await options.transport.cleanup({
              target,
              sessionId: runtime.id,
              connectionId: latest.connectionId,
              creationState: latest.creationState,
              onCreationResolved() {
                store.update(runtime.id, { creationState: "created" });
              },
              signal: abort.signal,
            });
          })();
          runtime.cleanupOperation = operation;
          void operation
            .finally(() => {
              if (runtime.cleanupOperation === operation) runtime.cleanupOperation = undefined;
            })
            .catch(() => undefined);
        }
        await bounded(runtime.cleanupOperation, limits.cleanupTimeoutMs, () => abort.abort());
        if (store.get(runtime.id)?.creationState === "uncertain")
          throw new CloudError(
            "创建结果仍不明确，正在继续核对 OCI 控制台连接",
            "CONSOLE_CREATE_UNCERTAIN",
            true,
          );
        store.finish(runtime.id, runtime.terminal, runtime.terminalError);
        runtimes.delete(runtime.id);
      } catch (error) {
        // Retain the global slot, metadata and account lock until a later verified cleanup.
        store.update(runtime.id, {
          state: "failed",
          cleanupPending: true,
          lastError:
            error instanceof CloudError && error.code === "CONSOLE_CREATE_UNCERTAIN"
              ? "OCI 创建结果仍不明确，已保留会话并将继续核对清理。"
              : "控制台清理尚未完成，将自动重试；也可再次关闭会话重试。",
        });
      } finally {
        runtime.closing = undefined;
      }
    });
    return runtime.closing;
  }

  async function prepare(runtime: Runtime) {
    try {
      const tunnel = await options.transport.start({
        target: runtime.target!,
        sessionId: runtime.id,
        signal: runtime.controller.signal,
        onCreationState(creationState) {
          store.update(runtime.id, { creationState });
        },
        onConnectionCreated(connectionId) {
          store.update(runtime.id, { connectionId, creationState: "created" });
        },
      });
      runtime.tunnel = tunnel;
      store.update(runtime.id, { connectionId: tunnel.connectionId, creationState: "created" });
      void tunnel.closed.then(
        () => {
          if (!runtime.controller.signal.aborted)
            void cleanup(runtime, "failed", "控制台隧道已断开。");
        },
        () => {
          if (!runtime.controller.signal.aborted)
            void cleanup(runtime, "failed", "控制台隧道已断开。");
        },
      );
      if (!runtime.controller.signal.aborted) {
        const row = store.get(runtime.id)!;
        if (!isActorValid(actorFrom(row))) {
          runtime.terminalError = "登录已失效，控制台会话已结束。";
          runtime.controller.abort();
        } else {
          store.update(runtime.id, { state: "ready", readyAt: timestamp() });
        }
      }
    } catch (error) {
      if (!runtime.controller.signal.aborted) {
        runtime.terminal = "failed";
        if (error instanceof CloudError) {
          const message = safeMessage(error);
          const code = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.code) ? error.code : null;
          runtime.terminalError =
            code && !message.includes(code) ? `${message}（${code}）` : message;
        } else {
          runtime.terminalError = "控制台连接准备失败，请检查实例状态和 OCI 权限。";
        }
        runtime.controller.abort();
      }
    } finally {
      runtime.preparePending = false;
      if (runtime.controller.signal.aborted) {
        // Do not await cleanup here: an existing cleanup can itself be waiting for prepare.
        queueMicrotask(() => void cleanup(runtime));
      }
    }
  }

  async function sweep() {
    if (sweeping || stopped || isDemo()) return;
    sweeping = true;
    try {
      const row = store.active();
      if (!row) return;
      const runtime = runtimeFor(row);
      if (runtime.ticket && runtime.ticket.expiresAt <= clock()) runtime.ticket = undefined;
      if (row.cleanupPending || row.state === "closing" || row.state === "failed") {
        if (clock() - runtime.lastCleanupAt >= limits.cleanupRetryMs) await cleanup(runtime);
        return;
      }
      const reason = !isActorValid(actorFrom(row))
        ? "登录已失效，控制台会话已结束。"
        : expirationReason(row);
      if (reason) await cleanup(runtime, row.state === "preparing" ? "failed" : "closed", reason);
    } finally {
      sweeping = false;
    }
  }

  return {
    initialize() {
      if (initializing) return initializing;
      initializing = (async () => {
        if (stopped) throw new AppError("控制台服务已停止", 503, "CONSOLE_UNAVAILABLE");
        if (isDemo()) {
          initialized = true;
          return;
        }
        const previous = store.active();
        if (previous)
          await cleanup(runtimeFor(previous), "closed", "应用重启后，旧控制台会话已结束。");
        initialized = true;
        if (!stopped) {
          timer = setInterval(() => void sweep().catch(() => undefined), limits.checkIntervalMs);
          timer.unref();
        }
      })();
      return initializing;
    },
    current(actor) {
      ensureInitialized();
      validateActor(actor);
      const row = store.active();
      return row ? consoleSummary(row) : null;
    },
    async create(instanceId, actor) {
      ensureInitialized();
      validateActor(actor);
      if (isDemo()) throw new AppError("演示模式不能打开真实控制台", 403, "DEMO_MODE");
      // Target resolution and reservation are synchronous; two requests cannot await into this slot.
      let target = resolveTarget(instanceId);
      if (target.instanceId !== instanceId)
        throw new AppError("控制台实例信息不匹配", 409, "CONSOLE_TARGET_MISMATCH");
      const now = timestamp();
      const row: ConsoleSessionRecord = {
        id: randomUUID(),
        instanceId,
        instanceName: target.instanceName,
        accountId: target.accountId,
        region: target.region,
        ownerUserId: actor.userId,
        ownerUsername: actor.username,
        ownerSessionHash: actor.sessionHash,
        state: "preparing",
        connectionId: null,
        creationState: "not_attempted",
        createdAt: now,
        expiresAt: new Date(clock() + limits.maxDurationMs).toISOString(),
        lastActivityAt: now,
        readyAt: null,
        lastError: null,
        cleanupPending: false,
        slot: 1,
      };
      store.reserve(row, () => {
        validateActor(actor);
        // Re-read inside the SQLite write transaction: account edits cannot race the slot lock.
        target = resolveTarget(instanceId);
        if (
          target.instanceId !== instanceId ||
          target.accountId !== row.accountId ||
          target.region !== row.region
        )
          throw new AppError("实例配置已变更，请刷新后重试", 409, "CONSOLE_TARGET_MISMATCH");
        row.instanceName = target.instanceName;
      });
      const runtime = runtimeFor(row);
      runtime.target = target;
      runtime.preparePending = true;
      runtime.prepared = Promise.resolve().then(() => prepare(runtime));
      return consoleSummary(row);
    },
    get(id, actor) {
      return consoleSummary(owned(id, actor));
    },
    issueTicket(id, actor) {
      const row = owned(id, actor);
      assertNotExpired(row);
      const runtime = runtimes.get(id);
      if (row.state !== "ready" || row.cleanupPending || !runtime || runtime.connecting)
        throw new AppError("控制台尚未就绪或已有客户端连接", 409, "CONSOLE_NOT_READY");
      runtime.ticket = {
        value: randomBytes(32).toString("base64url"),
        expiresAt: clock() + limits.ticketTtlMs,
      };
      return {
        ticket: runtime.ticket.value,
        expiresAt: new Date(runtime.ticket.expiresAt).toISOString(),
        path: `/api/console/sessions/${id}/socket`,
      };
    },
    async connect(id, ticket, actor) {
      const row = owned(id, actor);
      assertNotExpired(row);
      const runtime = runtimes.get(id);
      if (
        !runtime?.ticket ||
        runtime.ticket.value !== ticket ||
        runtime.ticket.expiresAt <= clock()
      )
        throw new AppError("控制台连接票据无效或已过期", 401, "CONSOLE_INVALID_TICKET");
      if (row.state !== "ready" || row.cleanupPending || runtime.connecting || !runtime.tunnel)
        throw new AppError("控制台尚未就绪或已有客户端连接", 409, "CONSOLE_NOT_READY");
      // Consume before the first await; duplicate handshakes cannot race into a second connection.
      runtime.ticket = undefined;
      runtime.connecting = true;
      try {
        const pending = runtime.tunnel.connect();
        void pending
          .then((stream) => {
            if (runtime.controller.signal.aborted) stream.destroy();
          })
          .catch(() => undefined);
        const stream = await bounded(pending, limits.connectTimeoutMs, () =>
          runtime.controller.abort(),
        );
        if (
          runtime.controller.signal.aborted ||
          !isActorValid(actor) ||
          expirationReason(store.get(id)!)
        ) {
          stream.destroy();
          throw new Error("Console connection closed");
        }
        runtime.stream = stream;
        store.update(id, { state: "connected", lastActivityAt: timestamp() });
        const disconnected = () => {
          if (!runtime.controller.signal.aborted) void cleanup(runtime);
        };
        stream.once("close", disconnected);
        stream.once("end", disconnected);
        stream.once("error", () => {
          if (!runtime.controller.signal.aborted)
            void cleanup(runtime, "failed", "控制台连接异常中断。");
        });
        if (stream.destroyed || stream.readableEnded) disconnected();
        return stream;
      } catch {
        void cleanup(runtime, "failed", "控制台客户端连接失败。");
        throw new AppError("控制台连接失败，请重新创建会话", 502, "CONSOLE_CONNECT_FAILED");
      } finally {
        runtime.connecting = false;
      }
    },
    touch(id, actor) {
      const row = owned(id, actor);
      assertNotExpired(row);
      if ((row.state === "ready" || row.state === "connected") && !row.cleanupPending)
        store.update(id, { lastActivityAt: timestamp() });
    },
    async close(id, actor) {
      const row = owned(id, actor);
      if (row.slot === 1) await cleanup(runtimeFor(row));
    },
    async shutdown() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (initializing) await initializing.catch(() => undefined);
      if (isDemo()) return;
      const row = store.active();
      if (row) await cleanup(runtimeFor(row));
    },
  };
}
