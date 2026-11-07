import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, InventoryResult, OperationRequest } from "@/lib/contracts";
import type { ExecutionContext } from "@/server/oci/types";
import { CloudError } from "@/server/oci/types";
import { createJobStore } from "@/server/jobs/store";
import { runWorker, type WorkerDependencies } from "@/server/jobs/worker";

const handles: Database.Database[] = [];
const directories: { directory: string; base: string }[] = [];
const account: AccountSummary = {
  id: "test-account",
  name: "Offline account",
  tenancyId: "tenancy",
  userId: "user",
  fingerprint: "fp",
  homeRegion: "test-region",
  regions: ["test-region"],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const op: OperationRequest = {
  kind: "public-ip-rotate",
  accountId: account.id,
  region: "test-region",
  resourceId: "test-instance",
  payload: { privateIpId: "test-private-ip" },
};
const emptyInventory: InventoryResult = { instances: [], warnings: [], regions: ["test-region"] };
let previousDemoMode: string | undefined;
beforeEach(() => {
  previousDemoMode = process.env.DEMO_MODE;
  process.env.DEMO_MODE = "false";
});
function fixture() {
  const accountState: AccountSummary = { ...account, regions: [...account.regions] };
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "oci-dash-jobs-test-"));
  directories.push({ directory, base });
  const path = join(directory, "jobs.sqlite");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const open = () => {
    const db = new Database(path);
    db.pragma("journal_mode=WAL");
    handles.push(db);
    return {
      db,
      store: createJobStore({ db, getAccount: () => accountState, now: () => new Date(time) }),
    };
  };
  const initial = open();
  const adapter = {
    verify: vi.fn(async () => ({
      tenancyName: account.name,
      homeRegion: account.homeRegion,
      regions: [...account.regions],
    })),
    execute: vi.fn(async () => ({
      message: "Cloud operation complete",
      details: { publicIp: "203.0.113.2" },
    })),
    inventory: vi.fn(async () => emptyInventory),
  };
  const dependencies: WorkerDependencies = {
    store: initial.store,
    adapter,
    getCredentials: () => ({
      tenancyId: "test",
      userId: "test",
      fingerprint: "test",
      privateKey: "FAKE_PRIVATE_CREDENTIAL_NEVER_PERSIST",
      region: "test-region",
    }),
    saveInventory: vi.fn((_accountId: string, result: InventoryResult) => {
      accountState.status = result.warnings.length ? "error" : "connected";
      accountState.lastError = result.warnings.length ? result.warnings.join("; ") : null;
    }),
    setAccountError: vi.fn((_accountId: string, message: string) => {
      accountState.status = "error";
      accountState.lastError = message;
    }),
    retryDelayMs: () => 100,
  };
  return {
    ...initial,
    open,
    adapter,
    dependencies,
    accountState,
    advance: (ms: number) => {
      time += ms;
    },
    once: (deps = dependencies) =>
      runWorker({ signal: new AbortController().signal, once: true, dependencies: deps }),
  };
}
afterEach(() => {
  if (previousDemoMode === undefined) delete process.env.DEMO_MODE;
  else process.env.DEMO_MODE = previousDemoMode;
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const { directory, base } of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== base || !basename(target).startsWith("oci-dash-jobs-test-"))
      throw Error("Unsafe test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("worker with an offline OCI adapter", () => {
  it.each(["initial connection", "post-operation refresh"])(
    "keeps inventory publication atomic with lease ownership during %s",
    async (kind) => {
      const f = fixture();
      const peer = f.open();
      peer.db.pragma("busy_timeout=0");
      const job =
        kind === "initial connection"
          ? f.store.enqueueAccountSync(account.id, "admin")
          : f.store.enqueueOperation(op, "admin");
      let takeoverError: unknown;
      const publish = vi.fn(() => {
        // A competing process tries to take over precisely while cache publication
        // is in progress, after the lease expires. It must wait for that commit.
        f.advance(30_001);
        try {
          peer.store.claimNext("replacement");
        } catch (error) {
          takeoverError = error;
        }
      });
      await f.once({ ...f.dependencies, saveInventory: publish });
      expect(publish).toHaveBeenCalledOnce();
      expect(takeoverError).toMatchObject({ code: "SQLITE_BUSY" });
      expect(peer.store.claimNext("replacement")?.summary.id).toBe(job.id);
    },
  );

  it("verifies an account before inventory and marks it connected only after cache persistence", async () => {
    const f = fixture();
    f.accountState.status = "unchecked";
    const order: string[] = [];
    f.adapter.verify.mockImplementationOnce(async () => {
      order.push("verify");
      expect(f.accountState.status).toBe("unchecked");
      return {
        tenancyName: account.name,
        homeRegion: account.homeRegion,
        regions: account.regions,
      };
    });
    f.adapter.inventory.mockImplementationOnce(async () => {
      order.push("inventory");
      expect(f.accountState.status).toBe("unchecked");
      return emptyInventory;
    });
    const job = f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(order).toEqual(["verify", "inventory"]);
    expect(f.accountState).toMatchObject({ status: "connected", lastError: null });
    expect(f.store.getJob(job.id)?.state).toBe("succeeded");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.dependencies.setAccountError).not.toHaveBeenCalled();
  });

  it("records a redacted verification failure without reading inventory or replacing cached resources", async () => {
    const f = fixture();
    f.adapter.verify.mockRejectedValueOnce(
      new CloudError("Denied FAKE_PRIVATE_CREDENTIAL_NEVER_PERSIST", "NOT_AUTHENTICATED"),
    );
    const job = f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.adapter.inventory).not.toHaveBeenCalled();
    expect(f.dependencies.saveInventory).not.toHaveBeenCalled();
    expect(f.dependencies.setAccountError).toHaveBeenCalledWith(account.id, "Denied [REDACTED]");
    expect(f.accountState).toMatchObject({ status: "error", lastError: "Denied [REDACTED]" });
    expect(f.store.getJob(job.id)).toMatchObject({ state: "failed", attempt: 1 });
  });

  it("recovers a retryable connection failure using the same durable job and clears the account error on success", async () => {
    const f = fixture();
    f.adapter.verify.mockRejectedValueOnce(
      new CloudError("Temporary OCI outage", "UNAVAILABLE", true),
    );
    const job = f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.store.getJob(job.id)).toMatchObject({ state: "retrying", attempt: 1 });
    expect(f.accountState).toMatchObject({ status: "error", lastError: "Temporary OCI outage" });
    expect(f.store.enqueueAccountSync(account.id, "admin").id).toBe(job.id);
    f.advance(101);
    await f.once();
    expect(f.adapter.verify).toHaveBeenCalledTimes(2);
    expect(f.adapter.inventory).toHaveBeenCalledTimes(1);
    expect(f.store.getJob(job.id)).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(f.accountState).toMatchObject({ status: "connected", lastError: null });
  });

  it("records an inventory failure after verification and preserves the previous cache", async () => {
    const f = fixture();
    f.adapter.inventory.mockRejectedValueOnce(
      new CloudError("Region inventory unavailable", "REGION_ERROR"),
    );
    const job = f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.adapter.verify).toHaveBeenCalledOnce();
    expect(f.dependencies.saveInventory).not.toHaveBeenCalled();
    expect(f.accountState).toMatchObject({
      status: "error",
      lastError: "Region inventory unavailable",
    });
    expect(f.store.getJob(job.id)?.state).toBe("failed");
  });

  it.each(["cancel", "shutdown", "lease-loss"] as const)(
    "does not overwrite account state when verification fails after %s",
    async (condition) => {
      const f = fixture();
      let started!: () => void, rejectVerify!: (error: Error) => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.adapter.verify.mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectVerify = reject;
            started();
          }),
      );
      const shutdown = new AbortController();
      const job = f.store.enqueueAccountSync(account.id, "admin");
      const worker = runWorker({
        signal: shutdown.signal,
        once: true,
        dependencies: f.dependencies,
      });
      await ready;
      if (condition === "cancel") f.store.cancelJob(job.id);
      if (condition === "shutdown") shutdown.abort();
      if (condition === "lease-loss") {
        f.advance(30_001);
        expect(f.store.claimNext("replacement")?.summary.id).toBe(job.id);
      }
      rejectVerify(new CloudError("Late obsolete verification failure", "NOT_AUTHENTICATED"));
      await worker;
      expect(f.dependencies.setAccountError).not.toHaveBeenCalled();
      expect(f.dependencies.saveInventory).not.toHaveBeenCalled();
      expect(f.adapter.inventory).not.toHaveBeenCalled();
      expect(f.accountState).toMatchObject({ status: "connected", lastError: null });
      expect(f.store.getJob(job.id)?.state).toBe(
        condition === "cancel" ? "cancelled" : condition === "shutdown" ? "interrupted" : "running",
      );
    },
  );

  it("keeps its heartbeat in demo mode without claiming pre-existing real jobs", async () => {
    const f = fixture();
    const job = f.store.enqueueOperation(op, "admin");
    const shutdown = new AbortController();
    const getCredentials = vi.fn(f.dependencies.getCredentials);
    process.env.DEMO_MODE = "true";
    const worker = runWorker({
      signal: shutdown.signal,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 10,
      dependencies: { ...f.dependencies, getCredentials },
    });
    try {
      expect(f.store.getWorkerStatus().online).toBe(true);
      const initial = f.store.getWorkerStatus().lastHeartbeatAt;
      f.advance(50);
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(f.store.getWorkerStatus().lastHeartbeatAt).not.toBe(initial);
      expect(f.store.getJob(job.id)).toMatchObject({ state: "queued", attempt: 0 });
      expect(getCredentials).not.toHaveBeenCalled();
      expect(f.adapter.execute).not.toHaveBeenCalled();
      expect(f.adapter.inventory).not.toHaveBeenCalled();
    } finally {
      shutdown.abort();
      await worker;
    }
  });
  it("executes one persisted request and retains successful history after inventory refresh", async () => {
    const f = fixture();
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    expect(f.adapter.execute).toHaveBeenCalledTimes(1);
    expect(f.adapter.inventory).toHaveBeenCalledTimes(1);
    expect(f.dependencies.saveInventory).toHaveBeenCalledWith(account.id, emptyInventory);
    expect(f.store.getJob(job.id)).toMatchObject({
      state: "succeeded",
      attempt: 1,
      result: { message: "Cloud operation complete", synchronization: { status: "completed" } },
    });
    expect(f.store.listJobs()).toHaveLength(1);
    expect(f.store.getJobEvents(job.id).at(-1)?.message).toBe("Task completed.");
    expect(f.store.getWorkerStatus().online).toBe(false);
  });

  it("queues a post-write refresh instead of reusing an earlier in-flight account read", async () => {
    const f = fixture();
    const older = f.store.enqueueAccountSync(account.id, "admin");
    f.store.claimNext("earlier-reader");
    f.advance(1);
    f.adapter.inventory.mockRejectedValueOnce(new Error("Inventory read temporarily unavailable"));
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    const result = f.store.getJob(job.id)!;
    expect(result.state).toBe("succeeded");
    expect(result.result?.synchronization).toMatchObject({ status: "queued" });
    const syncId = (result.result?.synchronization as { jobId: string }).jobId;
    const sync = f.store.getJob(syncId)!;
    expect(sync.id).not.toBe(older.id);
    expect(sync).toMatchObject({ state: "queued", attempt: 0 });
    expect(f.store.claimNext("parallel-reader")).toBeNull();
    f.store.finish(older.id, "earlier-reader", "succeeded");
    await f.once();
    expect(f.store.getJob(sync.id)?.state).toBe("succeeded");
    expect(f.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("reopens a database after a partial failure and reconciles saved work before continuing", async () => {
    const f = fixture();
    let deletions = 0,
      assignments = 0;
    const execute = vi.fn(
      async (_credentials: unknown, _operation: unknown, context: ExecutionContext) => {
        if (!context.checkpoints.publicIpDeletion) {
          deletions++;
          await context.checkpoint("publicIpDeletion", { confirmed: true, oldPublicIpId: "old" });
          throw new CloudError("Response lost after deletion", "NETWORK_TIMEOUT", true);
        }
        expect(context.checkpoints.publicIpDeletion).toEqual({
          confirmed: true,
          oldPublicIpId: "old",
        });
        assignments++;
        await context.checkpoint("newPublicIp", { id: "new", privateIpId: "test-private-ip" });
        return { message: "Rotation reconciled" };
      },
    );
    const deps = { ...f.dependencies, adapter: { ...f.adapter, execute } };
    const job = f.store.enqueueOperation(op, "admin");
    await f.once(deps);
    expect(f.store.getJob(job.id)).toMatchObject({ state: "retrying", attempt: 1 });
    f.db.close();
    f.advance(101);
    const restarted = f.open();
    await f.once({ ...deps, store: restarted.store });
    expect(restarted.store.getJob(job.id)).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(deletions).toBe(1);
    expect(assignments).toBe(1);
    expect(
      restarted.store
        .getJobEvents(job.id)
        .some((e) => e.message.includes("reconciling saved checkpoints")),
    ).toBe(true);
  });

  it("acknowledges cancellation before the next cloud write", async () => {
    const f = fixture();
    let release!: () => void;
    let started!: () => void;
    let cloudWrites = 0;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const execute = vi.fn(
      async (_credentials: unknown, _operation: unknown, context: ExecutionContext) => {
        started();
        await gate;
        await context.checkpoint("beforeMutation", { resourceId: "test-private-ip" });
        cloudWrites++;
        return { message: "Changed" };
      },
    );
    const job = f.store.enqueueOperation(op, "admin");
    const worker = f.once({ ...f.dependencies, adapter: { ...f.adapter, execute } });
    await ready;
    expect(f.store.cancelJob(job.id).state).toBe("cancel_requested");
    release();
    await worker;
    expect(cloudWrites).toBe(0);
    expect(f.store.getJob(job.id)).toMatchObject({ state: "cancelled", attempt: 1 });
  });

  it("does not execute a task cancelled while queued", async () => {
    const f = fixture();
    const job = f.store.enqueueOperation(op, "admin");
    f.store.cancelJob(job.id);
    await f.once();
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.store.getJob(job.id)).toMatchObject({ state: "cancelled", attempt: 0 });
  });

  it("marks graceful shutdown as interrupted and retains checkpoints for recovery", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const execute = vi.fn(
      async (_credentials: unknown, _operation: unknown, context: ExecutionContext) => {
        await context.checkpoint("operationIntent", { target: "test-private-ip" });
        started();
        await gate;
        await context.progress("Continue after remote read");
        return { message: "Completed" };
      },
    );
    const job = f.store.enqueueOperation(op, "admin");
    const worker = runWorker({
      signal: shutdown.signal,
      once: true,
      dependencies: { ...f.dependencies, adapter: { ...f.adapter, execute } },
    });
    await ready;
    shutdown.abort();
    release();
    await worker;
    expect(f.store.getJob(job.id)).toMatchObject({ state: "interrupted", attempt: 1 });
    const recovered = f.store.claimNext("replacement");
    expect(recovered?.needsReconcile).toBe(true);
    expect(recovered?.checkpoints.operationIntent).toEqual({ target: "test-private-ip" });
  });

  it("redacts credentials from a failed operation and does not retry permanent errors", async () => {
    const f = fixture();
    f.adapter.execute.mockRejectedValueOnce(
      new CloudError("Rejected FAKE_PRIVATE_CREDENTIAL_NEVER_PERSIST", "PERMISSION_DENIED", false),
    );
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    await f.once();
    expect(f.store.getJob(job.id)).toMatchObject({
      state: "failed",
      attempt: 1,
      lastError: "Rejected [REDACTED]",
    });
    expect(JSON.stringify(f.store.getJobEvents(job.id))).not.toContain("FAKE_PRIVATE_CREDENTIAL");
    expect(f.adapter.execute).toHaveBeenCalledTimes(1);
  });

  it("resumes only inventory refresh when cloud success was persisted before a crash", async () => {
    const f = fixture();
    const job = f.store.enqueueOperation(op, "admin");
    f.store.claimNext("crashed", 1000);
    f.store.checkpoint(job.id, "crashed", "__workerOperationResult", {
      message: "Already rotated",
      details: { publicIp: "203.0.113.3" },
    });
    f.advance(1001);
    await f.once();
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.adapter.inventory).toHaveBeenCalledOnce();
    expect(f.store.getJob(job.id)).toMatchObject({
      state: "succeeded",
      attempt: 2,
      result: { message: "Already rotated" },
    });
  });
});
