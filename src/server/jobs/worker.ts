import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { InventoryResult } from "@/lib/contracts";
import type {
  ExecutionContext,
  OciAdapter,
  OciCredentials,
  OperationResult,
} from "@/server/oci/types";
import {
  DEFAULT_LEASE_MS,
  JobError,
  LeaseLostError,
  safeErrorMessage,
  type ClaimedJob,
  type JobStore,
} from "./store";

export interface WorkerDependencies {
  store: JobStore;
  adapter: Pick<OciAdapter, "inventory" | "execute">;
  getCredentials(accountId: string, region: string): OciCredentials;
  saveInventory(accountId: string, result: InventoryResult): void;
  retryDelayMs?: (attempt: number) => number;
}
export interface RunWorkerOptions {
  signal: AbortSignal;
  pollIntervalMs?: number;
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
  const [{ getJobStore }, { getCredentials }, { saveInventory }, { ociAdapter }] =
    await Promise.all([
      import("./index"),
      import("@/server/accounts"),
      import("@/server/inventory"),
      import("@/server/oci/adapter"),
    ]);
  return { store: getJobStore(), adapter: ociAdapter, getCredentials, saveInventory };
}

async function executeClaimed(
  job: ClaimedJob,
  workerId: string,
  dependencies: WorkerDependencies,
  signal: AbortSignal,
  leaseMs: number,
  heartbeatIntervalMs: number,
): Promise<void> {
  const { store, adapter, getCredentials, saveInventory } = dependencies;
  const id = job.summary.id;
  const controller = new AbortController();
  const onShutdown = () => controller.abort(signal.reason || new Error("Worker is shutting down."));
  signal.addEventListener("abort", onShutdown, { once: true });
  if (signal.aborted) onShutdown();
  let credentials: OciCredentials | undefined;
  function check(): void {
    store.assertLease(id, workerId);
    if (store.cancellationRequested(id) && !controller.signal.aborted)
      controller.abort(new CancellationError());
    controller.signal.throwIfAborted();
  }
  const leaseMonitor = setInterval(() => {
    try {
      if (!store.renewLease(id, workerId, leaseMs)) {
        controller.abort(new LeaseLostError());
        return;
      }
      if (store.cancellationRequested(id)) controller.abort(new CancellationError());
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
      const result = await adapter.inventory(credentials, account, regions, context);
      check();
      saveInventory(account.id, result);
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
      store.assertLease(id, workerId);
      saveInventory(account.id, inventory);
      if (inventory.warnings.length)
        synchronization = { status: "completed-with-warnings", warnings: inventory.warnings };
    } catch (error) {
      if (error instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError)
        throw error;
      store.assertLease(id, workerId);
      const message = safeErrorMessage(error, [credentials.privateKey]);
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
  const dependencies = options.dependencies || (await defaultDependencies());
  const store = dependencies.store;
  const workerId = options.workerId || randomUUID();
  const leaseMs = Math.max(100, options.leaseMs || DEFAULT_LEASE_MS);
  const heartbeatIntervalMs = Math.max(
    10,
    Math.min(options.heartbeatIntervalMs || 5000, Math.floor(leaseMs / 3)),
  );
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? 500);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(options.signal.reason || new Error("Worker stopped."));
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  let fatalError: unknown;
  store.heartbeat(workerId, leaseMs);
  const heartbeat = setInterval(() => {
    try {
      store.heartbeat(workerId, leaseMs);
    } catch (error) {
      fatalError = error;
      shutdown.abort(error);
    }
  }, heartbeatIntervalMs);
  heartbeat.unref();
  try {
    while (!shutdown.signal.aborted) {
      // Demo is enforced at the execution boundary too: pre-existing real jobs
      // remain queued while this worker only maintains its health heartbeat.
      const job = process.env.DEMO_MODE === "true" ? null : store.claimNext(workerId, leaseMs);
      if (job)
        await executeClaimed(
          job,
          workerId,
          dependencies,
          shutdown.signal,
          leaseMs,
          heartbeatIntervalMs,
        );
      if (options.once) break;
      if (!job)
        try {
          await sleep(pollIntervalMs, undefined, { signal: shutdown.signal });
        } catch (error) {
          if (!shutdown.signal.aborted) throw error;
        }
    }
    if (fatalError) throw fatalError;
  } finally {
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", stop);
    store.stopWorker(workerId);
  }
}
