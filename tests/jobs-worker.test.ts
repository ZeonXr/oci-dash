import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, InventoryResult, OperationRequest } from "@/lib/contracts";
import type { ExecutionContext } from "@/server/oci/types";
import { CloudError } from "@/server/oci/types";
import { createJobStore } from "@/server/jobs/store";
import { runWorker, type WorkerDependencies } from "@/server/jobs/worker";
import { initializeTestDatabase } from "./fixtures/database";

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
    initializeTestDatabase(db);
    return {
      db,
      store: createJobStore({ db, getAccount: () => accountState, now: () => new Date(time) }),
    };
  };
  const initial = open();
  const adapter = {
    verify: vi.fn<WorkerDependencies["adapter"]["verify"]>(async () => ({
      tenancyName: account.name,
      homeRegion: account.homeRegion,
      regions: [...account.regions],
    })),
    execute: vi.fn<WorkerDependencies["adapter"]["execute"]>(async () => ({
      message: "Cloud operation complete",
      details: { publicIp: "203.0.113.2" },
    })),
    inventory: vi.fn<WorkerDependencies["adapter"]["inventory"]>(async () => emptyInventory),
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
    setAccountName: vi.fn((_accountId: string, tenancyName: string) => {
      if (accountState.nameSource === "pending" || accountState.nameSource === "tenancy") {
        accountState.name = tenancyName;
        accountState.nameSource = "tenancy";
      }
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

  it("waits for an earlier account read before writing, then queues a distinct post-write refresh", async () => {
    const f = fixture();
    const older = f.store.enqueueAccountSync(account.id, "admin");
    f.store.claimNext("earlier-reader");
    f.advance(1);
    f.adapter.inventory.mockRejectedValueOnce(new Error("Inventory read temporarily unavailable"));
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    expect(f.store.getJob(job.id)?.state).toBe("queued");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(f.store.claimNext("parallel-reader")).toBeNull();
    f.store.finish(older.id, "earlier-reader", "succeeded");
    await f.once();
    const result = f.store.getJob(job.id)!;
    expect(result.state).toBe("succeeded");
    expect(result.result?.synchronization).toMatchObject({ status: "queued" });
    const syncId = (result.result?.synchronization as { jobId: string }).jobId;
    const sync = f.store.getJob(syncId)!;
    expect(sync.id).not.toBe(older.id);
    expect(sync).toMatchObject({ state: "queued", attempt: 0 });
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

describe("accepted OCI operation completion windows", () => {
  it("reconciles more than four pending observations across a restart without repeating a write", async () => {
    const f = fixture();
    let writes = 0,
      reads = 0;
    const execute = vi.fn(
      async (_credentials: unknown, _operation: unknown, context: ExecutionContext) => {
        if (!context.checkpoints.accepted) {
          writes++;
          await context.checkpoint("accepted", { resourceId: "created-instance" });
        }
        if (++reads <= 6) throw new CloudError("Still provisioning", "RESOURCE_PENDING", true);
        return { message: "Provisioning completed", details: { instanceId: "created-instance" } };
      },
    );
    let dependencies = { ...f.dependencies, adapter: { ...f.adapter, execute } };
    const job = f.store.enqueueOperation({ ...op, kind: "instance-create" }, "admin");
    let deadline: string | null | undefined;
    for (let observation = 0; observation < 6; observation++) {
      await f.once(dependencies);
      const waiting = dependencies.store.getJob(job.id)!;
      expect(waiting).toMatchObject({
        state: "retrying",
        attempt: 1,
        maxAttempts: 4,
        waitingForCompletion: true,
        lastError: null,
      });
      deadline ??= waiting.completionDeadlineAt;
      expect(waiting.completionDeadlineAt).toBe(deadline);
      if (observation === 2) {
        f.db.close();
        dependencies = { ...dependencies, store: f.open().store };
      }
      f.advance(5000);
    }
    await f.once(dependencies);
    expect(dependencies.store.getJob(job.id)).toMatchObject({
      state: "succeeded",
      attempt: 1,
      waitingForCompletion: false,
    });
    expect(writes).toBe(1);
    expect(f.dependencies.saveInventory).toHaveBeenCalledOnce();
  });

  it("spends the normal error budget when status reads fail after acceptance", async () => {
    const f = fixture();
    f.adapter.execute.mockRejectedValueOnce(new CloudError("Processing", "RESOURCE_PENDING", true));
    f.adapter.execute.mockRejectedValue(new CloudError("Unavailable", "SERVICE_UNAVAILABLE", true));
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    f.advance(5000);
    for (let attempt = 1; attempt <= 4; attempt++) {
      await f.once();
      expect(f.store.getJob(job.id)?.attempt).toBe(attempt);
      expect(f.store.getJob(job.id)?.waitingForCompletion).toBe(false);
      f.advance(100);
    }
    expect(f.store.getJob(job.id)?.state).toBe("failed");
    expect(f.store.claimNext("extra-worker")).toBeNull();
  });

  it.each(["database restart", "expired lease"])(
    "stops at the persisted deadline after %s and retains checkpoints",
    async (recovery) => {
      const f = fixture();
      const execute = vi.fn(
        async (_credentials: unknown, _operation: unknown, context: ExecutionContext) => {
          await context.checkpoint("accepted", { resourceId: "cloud-resource" });
          throw new CloudError("Processing", "RESOURCE_PENDING", true);
        },
      );
      const dependencies = { ...f.dependencies, adapter: { ...f.adapter, execute } };
      const job = f.store.enqueueOperation(op, "admin");
      await f.once(dependencies);
      const deadline = f.store.getJob(job.id)!.completionDeadlineAt;
      expect(deadline).toBe("2026-01-01T00:30:00.000Z");
      f.advance(5000);
      if (recovery === "expired lease") {
        const claimed = f.store.claimNext("lost-worker", 1000)!;
        expect(claimed.summary.attempt).toBe(1);
        expect(claimed.summary.completionDeadlineAt).toBe(deadline);
      }
      f.db.close();
      f.advance(30 * 60_000);
      const reopened = f.open();
      await f.once({ ...dependencies, store: reopened.store });
      expect(execute).toHaveBeenCalledOnce();
      const failed = reopened.store.getJob(job.id)!;
      expect(failed).toMatchObject({
        state: "failed",
        waitingForCompletion: false,
        nextRunAt: null,
        completionDeadlineAt: deadline,
      });
      expect(failed.lastError).toContain("云端操作可能仍在继续");
      expect(reopened.store.claimNext("another-worker")).toBeNull();
      reopened.store.retryJob(job.id);
      const manual = reopened.store.claimNext("manual-worker")!;
      expect(manual.checkpoints.accepted).toEqual({ resourceId: "cloud-resource" });
      expect(Date.parse(manual.summary.completionDeadlineAt!)).toBeGreaterThan(
        Date.parse(deadline!),
      );
      reopened.store.finish(job.id, "manual-worker", "succeeded");
    },
  );

  it("does not submit a cloud request when a waiting task was cancelled", async () => {
    const f = fixture();
    f.adapter.execute.mockRejectedValue(new CloudError("Processing", "RESOURCE_PENDING", true));
    const job = f.store.enqueueOperation(op, "admin");
    await f.once();
    f.store.cancelJob(job.id);
    f.advance(5000);
    await f.once();
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    expect(f.store.getJob(job.id)?.state).toBe("cancelled");
  });
});

describe("verification during inventory refresh", () => {
  it("resolves a pending name on an already connected account without adding verification to later refreshes", async () => {
    const f = fixture();
    Object.assign(f.accountState, {
      name: "oci_api_key",
      nameSource: "pending",
      lastSyncAt: account.createdAt,
    });
    f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.adapter.verify).toHaveBeenCalledOnce();
    expect(f.dependencies.setAccountName).toHaveBeenCalledWith(account.id, account.name);
    expect(f.accountState).toMatchObject({ name: account.name, nameSource: "tenancy" });
    f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.adapter.verify).toHaveBeenCalledOnce();
    expect(f.adapter.inventory).toHaveBeenCalledTimes(2);
  });

  it.each(["cancel", "shutdown", "lease-loss"] as const)(
    "does not publish a verified name after %s",
    async (condition) => {
      const f = fixture();
      f.accountState.nameSource = "pending";
      const started = gate();
      const finish = gate();
      f.adapter.verify.mockImplementationOnce(async () => {
        started.resolve();
        await finish.promise;
        return {
          tenancyName: "Late tenant",
          homeRegion: account.homeRegion,
          regions: account.regions,
        };
      });
      const shutdown = new AbortController();
      const job = f.store.enqueueAccountSync(account.id, "admin");
      const worker = runWorker({
        signal: shutdown.signal,
        once: true,
        dependencies: f.dependencies,
      });
      await started.promise;
      if (condition === "cancel") f.store.cancelJob(job.id);
      if (condition === "shutdown") shutdown.abort();
      if (condition === "lease-loss") {
        f.advance(30_001);
        expect(f.store.claimNext("replacement")?.summary.id).toBe(job.id);
      }
      finish.resolve();
      await worker;
      expect(f.dependencies.setAccountName).not.toHaveBeenCalled();
      expect(f.accountState).toMatchObject({ name: account.name, nameSource: "pending" });
    },
  );

  it.each([
    { status: "connected" as const, lastSyncAt: "2026-01-01T00:00:00Z", checks: 0 },
    { status: "connected" as const, lastSyncAt: null, checks: 1 },
    { status: "unchecked" as const, lastSyncAt: "2026-01-01T00:00:00Z", checks: 1 },
    { status: "error" as const, lastSyncAt: "2026-01-01T00:00:00Z", checks: 1 },
  ])(
    "verifies $checks times for $status with lastSyncAt=$lastSyncAt",
    async ({ status, lastSyncAt, checks }) => {
      const f = fixture();
      Object.assign(f.accountState, { status, lastSyncAt });
      const job = f.store.enqueueAccountSync(account.id, "admin");
      await f.once();
      expect(f.adapter.verify).toHaveBeenCalledTimes(checks);
      expect(f.adapter.inventory).toHaveBeenCalledOnce();
      expect(f.store.getJob(job.id)?.state).toBe("succeeded");
    },
  );
  it("rechecks a previously connected account after its inventory request fails", async () => {
    const f = fixture();
    f.accountState.lastSyncAt = "2026-01-01T00:00:00Z";
    f.adapter.inventory.mockRejectedValueOnce(
      new CloudError("Unavailable", "OCI_UNAVAILABLE", true),
    );
    const job = f.store.enqueueAccountSync(account.id, "admin");
    await f.once();
    expect(f.adapter.verify).not.toHaveBeenCalled();
    expect(f.accountState.status).toBe("error");
    f.advance(100);
    await f.once();
    expect(f.adapter.verify).toHaveBeenCalledOnce();
    expect(f.store.getJob(job.id)?.state).toBe("succeeded");
  });
});

function schedulerFixture() {
  const f = fixture();
  const accounts = ["a", "b", "c", "d"].map((id) => ({
    ...account,
    id,
    name: id,
    lastSyncAt: account.createdAt,
  }));
  const store = createJobStore({
    db: f.db,
    getAccount: (id) => accounts.find((account) => account.id === id) ?? null,
  });
  const dependencies: WorkerDependencies = {
    ...f.dependencies,
    store,
    saveInventory: vi.fn(),
    setAccountError: vi.fn(),
  };
  const sync = (id: string) => store.enqueueAccountSync(id, "admin");
  const write = (id: string) =>
    store.enqueueOperation({ ...op, accountId: id, resourceId: id + "-instance" }, "admin");
  return { ...f, store, dependencies, sync, write };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("single-process bounded worker scheduling", () => {
  it("executes two account reads concurrently and promptly fills their freed slot", async () => {
    const f = schedulerFixture();
    const gates = new Map(["a", "b", "c"].map((id) => [id, gate()]));
    const seen: string[] = [];
    let active = 0,
      peak = 0;
    f.adapter.inventory.mockImplementation(async (_credentials, account) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(account.id);
      try {
        await gates.get(account.id)!.promise;
        return emptyInventory;
      } finally {
        active--;
      }
    });
    const jobs = [f.sync("a"), f.sync("b"), f.sync("c")];
    const shutdown = new AbortController();
    const worker = runWorker({
      signal: shutdown.signal,
      dependencies: f.dependencies,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      expect(peak).toBe(2);
      gates.get(seen[0])!.resolve();
      await vi.waitFor(() => expect(seen).toHaveLength(3));
      expect(peak).toBe(2);
      for (const value of gates.values()) value.resolve();
      await vi.waitFor(() =>
        expect(jobs.every((job) => f.store.getJob(job.id)?.state === "succeeded")).toBe(true),
      );
      expect(f.adapter.verify).not.toHaveBeenCalled();
    } finally {
      shutdown.abort();
      for (const value of gates.values()) value.resolve();
      await worker;
    }
  });

  it("runs an unrelated write alongside two reads without starting a second write", async () => {
    const f = schedulerFixture();
    const reading = gate(),
      writing = gate();
    const readIds: string[] = [],
      writeIds: string[] = [];
    f.adapter.inventory.mockImplementation(async (_credentials, account) => {
      if (["a", "b"].includes(account.id)) {
        readIds.push(account.id);
        await reading.promise;
      }
      return emptyInventory;
    });
    f.adapter.execute.mockImplementation(async (_credentials, operation) => {
      writeIds.push(operation.accountId);
      await writing.promise;
      return { message: "Done", details: {} };
    });
    f.sync("a");
    f.sync("b");
    const writes = [f.write("c"), f.write("d")];
    const shutdown = new AbortController();
    const worker = runWorker({
      signal: shutdown.signal,
      dependencies: f.dependencies,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(() => {
        expect(readIds).toHaveLength(2);
        expect(writeIds).toHaveLength(1);
      });
      // Jobs created in the same millisecond may tie-break by UUID. Either
      // account may win, but exactly one write must remain queued.
      expect(writes.map((job) => f.store.getJob(job.id)?.state).sort()).toEqual([
        "queued",
        "running",
      ]);
      writing.resolve();
      await vi.waitFor(() => expect(writeIds).toHaveLength(2));
      expect(readIds).toHaveLength(2);
    } finally {
      shutdown.abort();
      writing.resolve();
      reading.resolve();
      await worker;
    }
  });

  it("cancels one concurrent read without interrupting the other", async () => {
    const f = schedulerFixture();
    const a = gate(),
      b = gate();
    const signals = new Map<string, AbortSignal>();
    f.adapter.inventory.mockImplementation(async (_credentials, account, _regions, context) => {
      signals.set(account.id, context!.signal);
      await (account.id === "a" ? a : b).promise;
      return emptyInventory;
    });
    const first = f.sync("a"),
      second = f.sync("b");
    const shutdown = new AbortController();
    const worker = runWorker({
      signal: shutdown.signal,
      dependencies: f.dependencies,
      pollIntervalMs: 10,
    });
    try {
      await vi.waitFor(() => expect(signals.size).toBe(2));
      f.store.cancelJob(first.id);
      a.resolve();
      await vi.waitFor(() => expect(f.store.getJob(first.id)?.state).toBe("cancelled"));
      expect(signals.get("b")!.aborted).toBe(false);
      b.resolve();
      await vi.waitFor(() => expect(f.store.getJob(second.id)?.state).toBe("succeeded"));
      expect(f.dependencies.saveInventory).toHaveBeenCalledTimes(1);
      expect(f.dependencies.saveInventory).toHaveBeenCalledWith("b", emptyInventory);
    } finally {
      shutdown.abort();
      a.resolve();
      b.resolve();
      await worker;
    }
  });

  it("waits for every in-flight read on shutdown, renews leases while draining, and claims no queued work", async () => {
    const f = schedulerFixture();
    const gates = new Map(["a", "b", "c"].map((id) => [id, gate()]));
    const seen: string[] = [];
    f.adapter.inventory.mockImplementation(async (_credentials, account) => {
      seen.push(account.id);
      await gates.get(account.id)!.promise;
      return emptyInventory;
    });
    const jobs = [f.sync("a"), f.sync("b"), f.sync("c")];
    const shutdown = new AbortController();
    let stopped = false;
    const worker = runWorker({
      signal: shutdown.signal,
      dependencies: f.dependencies,
      pollIntervalMs: 10,
      leaseMs: 100,
      heartbeatIntervalMs: 10,
    }).then(() => {
      stopped = true;
    });
    try {
      await vi.waitFor(() => expect(seen).toHaveLength(2));
      shutdown.abort();
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(stopped).toBe(false);
      expect(f.store.getWorkerStatus().online).toBe(true);
      const active = f.db
        .prepare("SELECT lease_expires_at FROM jobs WHERE state='running'")
        .all() as { lease_expires_at: string }[];
      expect(active).toHaveLength(2);
      expect(active.every((row) => Date.parse(row.lease_expires_at) > Date.now())).toBe(true);
      gates.get(seen[0])!.resolve();
      await vi.waitFor(() =>
        expect(f.store.getJob(jobs.find((job) => job.accountId === seen[0])!.id)?.state).toBe(
          "interrupted",
        ),
      );
      expect(stopped).toBe(false);
      gates.get(seen[1])!.resolve();
      await worker;
      expect(seen).toHaveLength(2);
      expect(jobs.filter((job) => f.store.getJob(job.id)?.state === "queued")).toHaveLength(1);
      expect(f.dependencies.saveInventory).not.toHaveBeenCalled();
      expect(f.store.getWorkerStatus().online).toBe(false);
    } finally {
      shutdown.abort();
      for (const value of gates.values()) value.resolve();
      await worker;
    }
  });

  it("keeps once mode to exactly one claimed and completed task", async () => {
    const f = schedulerFixture();
    const jobs = [f.sync("a"), f.sync("b")];
    await runWorker({
      signal: new AbortController().signal,
      dependencies: f.dependencies,
      once: true,
    });
    expect(f.adapter.inventory).toHaveBeenCalledOnce();
    expect(jobs.filter((job) => f.store.getJob(job.id)?.state === "succeeded")).toHaveLength(1);
    expect(jobs.filter((job) => f.store.getJob(job.id)?.state === "queued")).toHaveLength(1);
  });
});
