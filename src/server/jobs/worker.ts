import { randomUUID } from "node:crypto";
import type { InventoryResult } from "@/lib/contracts";
import type {
  ExecutionContext,
  OciAdapter,
  OciCredentials,
  OperationResult,
} from "@/server/oci/types";
import {
  DEFAULT_LEASE_MS,
  MAX_CONCURRENT_ACCOUNT_SYNCS,
  JobError,
  LeaseLostError,
  safeErrorMessage,
  type ClaimedJob,
  type JobStore,
} from "./store";

export interface WorkerDependencies {
  store: JobStore;
  adapter: Pick<OciAdapter, "verify" | "inventory" | "execute">;
  getCredentials(accountId: string, region: string): OciCredentials;
  saveInventory(accountId: string, result: InventoryResult): void;
  setAccountName(accountId: string, tenancyName: string): void;
  setAccountError(accountId: string, message: string): void;
  retryDelayMs?: (attempt: number) => number;
}
export interface RunWorkerOptions {
  signal: AbortSignal;
  /** Dependencies and the first heartbeat are ready; no task has been claimed yet. */
  onReady?: () => void;
  /** Reports the first scheduler failure immediately, before active work drains. */
  onFatal?: (error: unknown) => void;
  pollIntervalMs?: number;
  /** Claim at most one task and await its outcome, without filling concurrent slots. */
  once?: boolean;
  dependencies?: WorkerDependencies;
  /** Override only for isolated tests or a deliberately configured deployment. */
  workerId?: string;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
}
class CancellationError extends Error {
  constructor() {
    super("Cancellation requested.");
    this.name = "AbortError";
  }
}
const RESULT_CHECKPOINT = "__workerOperationResult";
const defaultRetryDelay = (attempt: number) =>
  Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1)) + Math.floor(Math.random() * 1000);

async function defaultDependencies(): Promise<WorkerDependencies> {
  const [
    { getJobStore },
    { getCredentialSnapshot, setAccountStatus, setAccountTenancyName },
    { saveInventory },
    { ociAdapter },
  ] = await Promise.all([
    import("./index"),
    import("@/server/accounts"),
    import("@/server/inventory"),
    import("@/server/oci/adapter"),
  ]);
  const revisions = new Map<string, number>();
  return {
    store: getJobStore(),
    adapter: ociAdapter,
    getCredentials(accountId, region) {
      revisions.delete(accountId);
      const snapshot = getCredentialSnapshot(accountId, region);
      revisions.set(accountId, snapshot.revision);
      return snapshot.credentials;
    },
    saveInventory,
    setAccountName(accountId, tenancyName) {
      const revision = revisions.get(accountId);
      if (revision !== undefined) setAccountTenancyName(accountId, tenancyName, revision);
    },
    setAccountError(accountId, message) {
      const revision = revisions.get(accountId);
      if (revision !== undefined) setAccountStatus(accountId, "error", message, revision);
    },
  };
}

async function executeClaimed(
  job: ClaimedJob,
  workerId: string,
  dependencies: WorkerDependencies,
  signal: AbortSignal,
  leaseMs: number,
  heartbeatIntervalMs: number,
): Promise<void> {
  const { store, adapter, getCredentials, saveInventory, setAccountError } = dependencies;
  const id = job.summary.id;
  const controller = new AbortController();
  const onShutdown = () => controller.abort(signal.reason || new Error("Worker is shutting down."));
  signal.addEventListener("abort", onShutdown, { once: true });
  if (signal.aborted) onShutdown();
  let credentials: OciCredentials | undefined;
  let cloudConfirmed = Boolean(job.checkpoints[RESULT_CHECKPOINT]);
  function check(): void {
    store.assertLease(id, workerId);
    if (store.cancellationRequested(id) && !controller.signal.aborted)
      controller.abort(new CancellationError());
    controller.signal.throwIfAborted();
    if (!cloudConfirmed) store.assertCompletionWindow(id, workerId);
  }
  const leaseMonitor = setInterval(() => {
    try {
      if (!store.renewLease(id, workerId, leaseMs)) {
        controller.abort(new LeaseLostError());
        return;
      }
      if (store.cancellationRequested(id)) controller.abort(new CancellationError());
      if (!cloudConfirmed) store.assertCompletionWindow(id, workerId);
    } catch (error) {
      controller.abort(error);
    }
  }, heartbeatIntervalMs);
  leaseMonitor.unref();
  const context: ExecutionContext = {
    jobId: id,
    signal: controller.signal,
    checkpoints: { ...job.checkpoints },
    async progress(message, detail) {
      check();
      store.progress(
        id,
        workerId,
        safeErrorMessage(new Error(message), credentials ? [credentials.privateKey] : []),
        detail,
      );
    },
    async checkpoint(key, value) {
      check();
      if (key === RESULT_CHECKPOINT)
        throw new JobError("The worker checkpoint namespace is reserved.", "INVALID_CHECKPOINT");
      store.checkpoint(id, workerId, key, value);
      context.checkpoints[key] = value;
    },
  };
  try {
    check();
    const account = store.getAccount(job.operation.accountId);
    if (!account)
      throw new JobError(
        "Account was removed before this task could run.",
        "ACCOUNT_NOT_FOUND",
        404,
      );
    credentials = getCredentials(account.id, job.operation.region);
    const regions = account.regions.length ? account.regions : [account.homeRegion];
    if (job.operation.kind === "sync-account") {
      if (
        account.status !== "connected" ||
        !account.lastSyncAt ||
        account.nameSource === "pending"
      ) {
        await context.progress("正在验证 OCI 账号连接。");
        const verified = await adapter.verify(credentials);
        check();
        if (
          !store.withActiveLease(id, workerId, () =>
            dependencies.setAccountName(account.id, verified.tenancyName),
          )
        )
          throw new CancellationError();
        await context.progress("账号连接验证成功，正在读取云资源。");
      } else await context.progress("正在读取云资源。");
      const result = await adapter.inventory(credentials, account, regions, context);
      check();
      if (!store.withActiveLease(id, workerId, () => saveInventory(account.id, result))) {
        throw new CancellationError();
      }
      store.finish(id, workerId, "succeeded", {
        message: "Inventory synchronized.",
        instances: result.instances.length,
        regions: result.regions,
        warnings: result.warnings,
      });
      return;
    }
    // The adapter always reconciles cloud state and saved checkpoints before writes.
    // A persisted successful response is sufficient to resume only local inventory refresh.
    let outcome = context.checkpoints[RESULT_CHECKPOINT] as OperationResult | undefined;
    if (!outcome) {
      outcome = await adapter.execute(credentials, job.operation, context);
      // Preserve a confirmed successful response even if cancellation raced with completion.
      store.checkpoint(id, workerId, RESULT_CHECKPOINT, outcome);
      context.checkpoints[RESULT_CHECKPOINT] = outcome;
      cloudConfirmed = true;
    } else
      store.progress(
        id,
        workerId,
        "The cloud operation was already confirmed; refreshing inventory only.",
      );
    let synchronization: Record<string, unknown> = { status: "completed" };
    try {
      check();
      const inventory = await adapter.inventory(credentials, account, regions, context);
      if (!store.withActiveLease(id, workerId, () => saveInventory(account.id, inventory))) {
        throw new CancellationError();
      }
      if (inventory.warnings.length)
        synchronization = { status: "completed-with-warnings", warnings: inventory.warnings };
    } catch (error) {
      if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError)
        throw error;
      store.assertLease(id, workerId);
      const message = safeErrorMessage(error, [credentials.privateKey]);
      // A post-write refresh must run after the write. Reusing an earlier in-flight
      // account read could otherwise publish a snapshot taken before this operation.
      const sync = store.enqueueOperation(
        {
          kind: "sync-account",
          accountId: account.id,
          region: account.homeRegion,
          payload: {},
          idempotencyKey: `sync-after:${id}:${job.summary.attempt}`,
        },
        job.requestedBy,
      );
      synchronization = { status: "queued", jobId: sync.id, note: message };
      store.warning(
        id,
        workerId,
        "Cloud operation completed, but inventory refresh will run as a separate task.",
        { syncJobId: sync.id, error: message },
      );
    }
    store.finish(id, workerId, "succeeded", {
      message: outcome.message,
      details: outcome.details || {},
      synchronization,
    });
  } catch (error) {
    // An expired lease belongs to the next worker. The old worker must never commit a result.
    if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError)
      return;
    if (
      controller.signal.reason instanceof JobError &&
      controller.signal.reason.code === "COMPLETION_TIMEOUT"
    )
      error = controller.signal.reason;
    try {
      store.assertLease(id, workerId);
      const message = safeErrorMessage(error, credentials ? [credentials.privateKey] : []);
      if (signal.aborted) {
        store.interrupt(
          id,
          workerId,
          "Worker shutdown interrupted execution; the remote outcome will be checked on recovery.",
        );
        return;
      }
      if (store.cancellationRequested(id)) {
        store.finish(id, workerId, "cancelled", undefined, message);
        return;
      }
      if (job.operation.kind === "sync-account") {
        store.withActiveLease(id, workerId, () => {
          if (!signal.aborted && !controller.signal.aborted)
            setAccountError(job.operation.accountId, message);
        });
      }
      // OCI accepted the operation and is still processing it. This is a status
      // reconciliation, not another failed request: retain a separate finite window.
      if (
        job.operation.kind !== "sync-account" &&
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "RESOURCE_PENDING"
      ) {
        store.waitForCompletion(id, workerId, message);
        return;
      }
      const retryable = Boolean(
        error && typeof error === "object" && "retryable" in error && error.retryable === true,
      );
      if (error && typeof error === "object") {
        const info = error as { code?: unknown; requestId?: unknown };
        store.warning(id, workerId, "Execution error recorded.", {
          code: typeof info.code === "string" ? info.code.slice(0, 200) : "EXECUTION_ERROR",
          ...(typeof info.requestId === "string"
            ? { requestId: info.requestId.slice(0, 300) }
            : {}),
          retryable,
        });
      }
      if (retryable)
        store.retryLater(
          id,
          workerId,
          message,
          (dependencies.retryDelayMs || defaultRetryDelay)(job.summary.attempt),
        );
      else store.finish(id, workerId, "failed", undefined, message);
    } catch (finalizeError) {
      if (!(finalizeError instanceof LeaseLostError)) throw finalizeError;
    }
  } finally {
    clearInterval(leaseMonitor);
    signal.removeEventListener("abort", onShutdown);
  }
}

/** Runs only queued jobs. Tests replace every cloud dependency with an offline adapter. */
export async function runWorker(options: RunWorkerOptions): Promise<void> {
  const workerId = options.workerId || randomUUID();
  const leaseMs = Math.max(100, options.leaseMs || DEFAULT_LEASE_MS);
  const heartbeatIntervalMs = Math.max(
    10,
    Math.min(options.heartbeatIntervalMs || 5000, Math.floor(leaseMs / 3)),
  );
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 500);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(options.signal.reason || new Error("Worker stopped."));
  let initializedStore: JobStore | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let fatalError: unknown;
  let failed = false;
  const active = new Set<Promise<void>>();
  let wake: (() => void) | undefined;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    fatalError = error;
    try {
      options.onFatal?.(error);
    } catch {
      // A lifecycle observer cannot replace the original failure or prevent cleanup.
    } finally {
      shutdown.abort(error);
    }
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  try {
    if (shutdown.signal.aborted) return;
    const dependencies = options.dependencies || (await defaultDependencies());
    const store = dependencies.store;
    if (shutdown.signal.aborted) return;
    initializedStore = store;
    const launch = (job: ClaimedJob) => {
      const execution = executeClaimed(
        job,
        workerId,
        dependencies,
        shutdown.signal,
        leaseMs,
        heartbeatIntervalMs,
      )
        .catch(fail)
        .finally(() => {
          active.delete(execution);
          wake?.();
        });
      active.add(execution);
    };
    const waitForWork = () =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          shutdown.signal.removeEventListener("abort", done);
          if (wake === done) wake = undefined;
          resolve();
        };
        const timer = setTimeout(done, pollIntervalMs);
        wake = done;
        shutdown.signal.addEventListener("abort", done, { once: true });
        if (shutdown.signal.aborted) done();
      });
    store.heartbeat(workerId, leaseMs);
    heartbeat = setInterval(() => {
      try {
        store.heartbeat(workerId, leaseMs);
      } catch (error) {
        fail(error);
      }
    }, heartbeatIntervalMs);
    heartbeat.unref();
    options.onReady?.();
    while (!shutdown.signal.aborted) {
      // The database enforces the two-read/one-write limits across all workers;
      // this local bound only caps execution objects owned by this process.
      const capacity = options.once ? 1 : MAX_CONCURRENT_ACCOUNT_SYNCS + 1;
      while (!shutdown.signal.aborted && active.size < capacity) {
        const job = store.claimNext(workerId, leaseMs);
        if (!job) break;
        launch(job);
      }
      if (options.once) break;
      await waitForWork();
    }
  } catch (error) {
    fail(error);
  } finally {
    // Keep process and job heartbeats alive until every running task has persisted
    // its outcome/interruption. The entrypoint's existing shutdown deadline still
    // handles a transport that cannot return promptly.
    await Promise.allSettled([...active]);
    if (heartbeat) clearInterval(heartbeat);
    options.signal.removeEventListener("abort", stop);
    try {
      initializedStore?.stopWorker(workerId);
    } catch (error) {
      fail(error);
    }
  }
  if (failed) throw fatalError;
}
