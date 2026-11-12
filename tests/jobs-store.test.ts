import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, OperationRequest } from "@/lib/contracts";
import { createJobStore, JobError, LeaseLostError } from "@/server/jobs/store";
import { parseJobQuery } from "@/server/jobs/query";
import { initializeTestDatabase } from "./fixtures/database";

const handles: Database.Database[] = [];
const directories: { directory: string; base: string }[] = [];
const account: AccountSummary = {
  id: "account-a",
  name: "Test account",
  tenancyId: "tenancy",
  userId: "user",
  fingerprint: "fp",
  homeRegion: "region-a",
  regions: ["region-a"],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
function fixture(extraAccounts: AccountSummary[] = []) {
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "oci-dash-jobs-test-"));
  directories.push({ directory, base });
  const path = join(directory, "jobs.sqlite");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const now = () => new Date(time);
  const open = () => {
    const db = new Database(path);
    db.pragma("journal_mode=WAL");
    db.pragma("busy_timeout=5000");
    handles.push(db);
    initializeTestDatabase(db);
    return {
      db,
      store: createJobStore({
        db,
        getAccount: (id) => [account, ...extraAccounts].find((item) => item.id === id) ?? null,
        now,
      }),
    };
  };
  return {
    path,
    open,
    advance: (ms: number) => {
      time += ms;
    },
    ...open(),
  };
}
const operation = (
  resourceId = "instance-1",
  payload: Record<string, unknown> = {},
): OperationRequest => ({
  kind: "instance-rename",
  accountId: account.id,
  region: "region-a",
  resourceId,
  payload,
});
afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const { directory, base } of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== base || !basename(target).startsWith("oci-dash-jobs-test-"))
      throw Error("Unsafe test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("durable job store", () => {
  it("reuses an unfinished account sync across connections and retry states", () => {
    const f = fixture();
    const other = f.open();
    const job = f.store.enqueueAccountSync(account.id, "admin");
    expect(other.store.enqueueAccountSync(account.id, "another-admin").id).toBe(job.id);
    expect(f.store.claimNext("a")?.operation).toEqual({
      kind: "sync-account",
      accountId: account.id,
      region: account.homeRegion,
      payload: {},
    });
    expect(other.store.enqueueAccountSync(account.id, "admin").state).toBe("running");
    f.store.retryLater(job.id, "a", "Temporary failure", 100);
    expect(other.store.enqueueAccountSync(account.id, "admin")).toMatchObject({
      id: job.id,
      state: "retrying",
    });
    f.advance(101);
    f.store.claimNext("a");
    f.store.interrupt(job.id, "a", "Restart requested");
    expect(other.store.enqueueAccountSync(account.id, "admin")).toMatchObject({
      id: job.id,
      state: "interrupted",
    });
    expect(f.store.listJobs()).toHaveLength(1);
  });

  it("queues a fresh connection after cancellation is requested without bypassing its resource lock", () => {
    const regionalAccount = { ...account, id: "multi-region", regions: ["region-a", "region-b"] };
    const f = fixture([regionalAccount]);
    const previous = f.store.enqueueOperation(
      { kind: "sync-account", accountId: regionalAccount.id, region: "region-b", payload: {} },
      "admin",
    );
    f.store.claimNext("a");
    f.store.cancelJob(previous.id);
    const fresh = f.store.enqueueAccountSync(regionalAccount.id, "admin");
    expect(fresh.id).not.toBe(previous.id);
    expect(fresh.state).toBe("queued");
    expect(fresh.region).toBe(regionalAccount.homeRegion);
    expect(f.store.enqueueAccountSync(regionalAccount.id, "admin").id).toBe(fresh.id);
    expect(f.store.claimNext("b")).toBeNull();
    f.store.finish(previous.id, "a", "cancelled");
    expect(f.store.claimNext("b")?.summary.id).toBe(fresh.id);
  });

  it("lists one sync per account, preferring active work and resolving equal timestamps by insertion order", () => {
    const secondAccount = { ...account, id: "account-b", name: "Second account" };
    const f = fixture([secondAccount]);
    const older = f.store.enqueueAccountSync(account.id, "admin");
    f.store.cancelJob(older.id);
    const latest = f.store.enqueueAccountSync(account.id, "admin");
    f.store.cancelJob(latest.id);
    const other = f.store.enqueueAccountSync(secondAccount.id, "admin");
    f.store.enqueueOperation(operation("unrelated-instance"), "admin");
    expect(f.store.listAccountSyncJobs().map((job) => job.id)).toEqual([other.id, latest.id]);
    f.store.retryJob(older.id);
    expect(f.store.listAccountSyncJobs().find((job) => job.accountId === account.id)).toMatchObject(
      {
        id: older.id,
        state: "queued",
      },
    );
    f.store.cancelJob(older.id);
    expect(f.store.listAccountSyncJobs().find((job) => job.accountId === account.id)?.id).toBe(
      latest.id,
    );
  });

  it("keeps account-sync enqueue and its events inside a caller's outer transaction", () => {
    const f = fixture();
    expect(() =>
      f.db
        .transaction(() => {
          f.store.enqueueAccountSync(account.id, "admin");
          throw new Error("Account creation must roll back");
        })
        .immediate(),
    ).toThrow("must roll back");
    expect(f.store.listJobs()).toHaveLength(0);
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM job_events").get()).toEqual({ count: 0 });
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM job_resources").get()).toEqual({ count: 0 });
  });

  it("deduplicates the same request across a database reopen and rejects different payloads", () => {
    const f = fixture();
    const first = f.store.enqueueOperation(
      {
        ...operation("instance-1", { name: "new", nested: { b: 2, a: 1 } }),
        idempotencyKey: "request-1",
      },
      "admin",
    );
    f.db.close();
    const reopened = f.open();
    const duplicate = reopened.store.enqueueOperation(
      {
        ...operation("instance-1", { nested: { a: 1, b: 2 }, name: "new" }),
        idempotencyKey: "request-1",
      },
      "admin",
    );
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.attempt).toBe(0);
    expect(reopened.store.listJobs()).toHaveLength(1);
    expect(reopened.store.getJobEvents(first.id)).toHaveLength(1);
    expect(() =>
      reopened.store.enqueueOperation(
        { ...operation("instance-1", { name: "different" }), idempotencyKey: "request-1" },
        "admin",
      ),
    ).toThrow("different request");
  });

  it("serializes writes globally across connections even for independent resources", () => {
    const f = fixture(),
      other = f.open();
    const first = f.store.enqueueOperation(operation(), "admin");
    f.advance(1);
    const blocked = f.store.enqueueOperation(operation(), "admin");
    f.advance(1);
    const independent = f.store.enqueueOperation(operation("instance-2"), "admin");
    expect(f.store.claimNext("worker-a")?.summary.id).toBe(first.id);
    expect(other.store.claimNext("worker-b")).toBeNull();
    expect(other.store.claimNext("worker-c")).toBeNull();
    expect(f.store.getJob(blocked.id)?.attempt).toBe(0);
    f.store.finish(first.id, "worker-a", "succeeded", { message: "renamed" });
    expect(other.store.claimNext("worker-c")?.summary.id).toBe(blocked.id);
    other.store.finish(blocked.id, "worker-c", "succeeded");
    expect(other.store.claimNext("worker-b")?.summary.id).toBe(independent.id);
  });

  it("serializes shared security groups even when the operations name different instances", () => {
    const f = fixture(),
      other = f.open();
    const first = f.store.enqueueOperation(
      { ...operation("instance-1", { groupId: "shared-nsg" }), kind: "security-rule-add" },
      "admin",
    );
    f.advance(1);
    const second = f.store.enqueueOperation(
      { ...operation("instance-2", { groupId: "shared-nsg" }), kind: "security-rule-delete" },
      "admin",
    );
    expect(f.store.claimNext("a")?.summary.id).toBe(first.id);
    expect(other.store.claimNext("b")).toBeNull();
    f.store.finish(first.id, "a", "succeeded");
    expect(other.store.claimNext("b")?.summary.id).toBe(second.id);
  });

  it("recovers expired leases with durable checkpoints and fences stale workers", () => {
    const f = fixture(),
      other = f.open();
    const submitted = f.store.enqueueOperation(
      { ...operation(), kind: "public-ip-rotate" },
      "admin",
    );
    f.store.claimNext("crashed-worker", 1000);
    f.store.checkpoint(submitted.id, "crashed-worker", "publicIpDeletion", {
      publicIpId: "old-ip",
      confirmed: true,
    });
    f.advance(1001);
    const recovered = other.store.claimNext("replacement-worker", 1000);
    expect(recovered?.summary.id).toBe(submitted.id);
    expect(recovered?.summary.attempt).toBe(2);
    expect(recovered?.needsReconcile).toBe(true);
    expect(recovered?.checkpoints.publicIpDeletion).toEqual({
      publicIpId: "old-ip",
      confirmed: true,
    });
    expect(() => f.store.finish(submitted.id, "crashed-worker", "succeeded")).toThrow(
      LeaseLostError,
    );
    expect(f.store.renewLease(submitted.id, "crashed-worker", 1000)).toBe(false);
    expect(
      other.store.getJobEvents(submitted.id).some((e) => e.message.includes("lease expired")),
    ).toBe(true);
  });

  it("keeps a running cancellation locked until acknowledged, while cancelling queued work immediately", () => {
    const f = fixture();
    const running = f.store.enqueueOperation(operation(), "admin");
    f.advance(1);
    const waiting = f.store.enqueueOperation(operation(), "admin");
    f.store.claimNext("a");
    expect(f.store.cancelJob(running.id).state).toBe("cancel_requested");
    expect(f.store.claimNext("b")).toBeNull();
    expect(f.store.cancelJob(waiting.id).state).toBe("cancelled");
    expect(f.store.getJob(waiting.id)?.attempt).toBe(0);
    f.store.finish(running.id, "a", "cancelled");
    expect(f.store.getJob(running.id)?.state).toBe("cancelled");
    expect(
      f.store.getJobEvents(running.id).some((e) => e.message.includes("not rolled back")),
    ).toBe(true);
  });

  it("bounds automatic retries without resetting actual attempt counts on manual retry", () => {
    const f = fixture();
    const job = f.store.enqueueOperation(operation(), "admin");
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(f.store.claimNext("a")?.summary.attempt).toBe(attempt);
      f.store.retryLater(job.id, "a", "Temporary OCI error", 100);
      if (attempt < 4) {
        expect(f.store.claimNext("a")).toBeNull();
        f.advance(100);
      }
    }
    expect(f.store.getJob(job.id)).toMatchObject({ state: "failed", attempt: 4, maxAttempts: 4 });
    expect(f.store.claimNext("a")).toBeNull();
    expect(f.store.retryJob(job.id)).toMatchObject({ state: "queued", attempt: 4, maxAttempts: 8 });
    expect(f.store.claimNext("a")?.summary.attempt).toBe(5);
  });

  it("refuses secrets in operations and checkpoints and redacts event details", () => {
    const f = fixture();
    expect(() =>
      f.store.enqueueOperation(operation("instance-1", { privateKey: "never-store-me" }), "admin"),
    ).toThrow(JobError);
    const job = f.store.enqueueOperation(operation(), "admin");
    f.store.claimNext("a");
    expect(() =>
      f.store.checkpoint(job.id, "a", "cloudResponse", { privateKey: "never-store-me" }),
    ).toThrow(JobError);
    f.store.progress(job.id, "a", "Response summary", {
      authorization: "Bearer never-store-me",
      resourceId: "public-id",
    });
    expect(JSON.stringify(f.store.getJobEvents(job.id))).not.toContain("never-store-me");
    expect(f.store.getJobEvents(job.id).at(-1)?.detail).toEqual({
      authorization: "[REDACTED]",
      resourceId: "public-id",
    });
  });

  it("reports live workers without a stopped worker hiding another heartbeat", () => {
    const f = fixture();
    f.store.heartbeat("live");
    f.advance(1);
    f.store.heartbeat("stopped");
    f.store.stopWorker("stopped");
    expect(f.store.getWorkerStatus()).toMatchObject({
      online: true,
      workerId: "live",
      activeJobs: 0,
    });
    f.advance(30_001);
    expect(f.store.getWorkerStatus().online).toBe(false);
  });
});

describe("job history queries", () => {
  const query = (text = "") => {
    const parsed = parseJobQuery(new URLSearchParams(text));
    if (parsed === "active") throw new Error("Expected a paginated query");
    return parsed;
  };

  it("paginates all history and finds the oldest active task beyond the recent 100", () => {
    const f = fixture();
    const oldest = f.store.enqueueOperation(operation("oldest"), "admin");
    f.store.claimNext("worker");
    for (let index = 1; index <= 104; index++) {
      f.advance(1);
      const next = f.store.enqueueOperation(operation(`newer-${index}`), "admin");
      f.store.cancelJob(next.id);
    }
    expect(f.store.listJobs()).toHaveLength(100);
    const last = f.store.queryJobs(query("page=11&pageSize=10"));
    expect(last).toMatchObject({ total: 105, page: 11, pageSize: 10 });
    expect(last.jobs).toHaveLength(5);
    expect(last.jobs.at(-1)?.id).toBe(oldest.id);
    expect(f.store.queryJobs(query("state=running&pageSize=10")).jobs.map((job) => job.id)).toEqual(
      [oldest.id],
    );
    expect(f.store.listActiveJobs().map((job) => job.id)).toEqual([oldest.id]);
    expect(f.store.queryJobs(query("page=999&pageSize=10")).page).toBe(11);
  });

  it("filters before counting and preserves Chinese labels, Unicode case and literal wildcard text", () => {
    const second = { ...account, id: "b", name: "ÉCOLE %_" };
    const f = fixture([second]);
    const first = f.store.enqueueOperation(operation("literal%_target"), "admin");
    const other = f.store.enqueueOperation(
      { ...operation("plain-target"), accountId: second.id },
      "admin",
    );
    f.store.cancelJob(other.id);
    expect(
      f.store
        .queryJobs(query("query=%25_"))
        .jobs.map((job) => job.id)
        .sort(),
    ).toEqual([first.id, other.id].sort());
    expect(f.store.queryJobs(query("query=école")).jobs.map((job) => job.id)).toEqual([other.id]);
    expect(
      f.store.queryJobs(
        query("query=重命名实例&state=queued&accountId=account-a&resourceId=literal%25_target"),
      ),
    ).toMatchObject({ total: 1, jobs: [{ id: first.id }] });
    expect(f.store.queryJobs(query("query=none&page=5"))).toEqual({
      jobs: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
  });

  it("uses stable ID ordering for equal timestamps and excludes automatic refresh history", () => {
    const f = fixture();
    const jobs = ["one", "two", "three"].map((name) =>
      f.store.enqueueOperation(operation(name), "admin"),
    );
    f.store.refreshInventory([account.id], "auto", "admin");
    const expected = jobs.map((job) => job.id).sort();
    expect(f.store.queryJobs(query("sort=ascending&pageSize=2")).jobs.map((job) => job.id)).toEqual(
      expected.slice(0, 2),
    );
    expect(f.store.queryJobs(query("sort=ascending&pageSize=2&page=2"))).toMatchObject({
      total: 3,
      jobs: [{ id: expected[2] }],
    });
  });

  it("retains a completed parent only while its exact same-account synchronization is pending", () => {
    const f = fixture();
    const parent = f.store.enqueueOperation(operation("parent-instance"), "admin");
    f.store.claimNext("writer");
    const sync = f.store.refreshInventory([account.id], "auto", "admin").jobs[0];
    f.store.finish(parent.id, "writer", "succeeded", {
      synchronization: { status: "queued", jobId: sync.id },
    });
    expect(f.store.listActiveJobs().map((job) => job.id)).toEqual([parent.id]);
    f.store.claimNext("reader");
    f.store.finish(sync.id, "reader", "succeeded");
    expect(f.store.listActiveJobs()).toEqual([]);
    f.db
      .prepare("UPDATE jobs SET result_json=? WHERE id=?")
      .run(JSON.stringify({ synchronization: { status: "queued", jobId: "missing" } }), parent.id);
    expect(f.store.listActiveJobs()).toEqual([]);
  });

  it("does not label an exhausted interrupted task active unless its accepted operation can resume", () => {
    const f = fixture();
    const job = f.store.enqueueOperation(operation(), "admin");
    f.db
      .prepare(
        "UPDATE jobs SET state='interrupted',attempt=max_attempts,next_run_at=NULL WHERE id=?",
      )
      .run(job.id);
    expect(f.store.listActiveJobs()).toEqual([]);
    f.db
      .prepare("UPDATE jobs SET next_run_at=?,waiting_for_completion=1 WHERE id=?")
      .run(new Date().toISOString(), job.id);
    expect(f.store.listActiveJobs().map((value) => value.id)).toEqual([job.id]);
  });

  it.each([
    "page=0",
    "page=1.5",
    "pageSize=101",
    "pageSize=0",
    "sort=anything",
    "state=anything",
    "page=1&page=2",
    "active=false",
    "active=true&page=1",
    "unknown=1",
  ])("rejects invalid or ambiguous HTTP queries: %s", (text) => {
    expect(() => parseJobQuery(new URLSearchParams(text))).toThrowError(
      expect.objectContaining({ code: "INVALID_JOB_QUERY" }),
    );
  });
});

describe("pending completion recovery", () => {
  it("keeps resource locks during transport retries and their shutdown or lease recovery", () => {
    const f = fixture();
    const peer = f.open().store;
    const first = f.store.enqueueOperation(operation(), "admin");
    f.store.claimNext("initial");
    f.store.retryLater(first.id, "initial", "Temporary transport failure", 5000);
    f.advance(1);
    const blocked = f.store.enqueueOperation(operation(), "admin");
    f.advance(1);
    const unrelated = f.store.enqueueOperation(operation("instance-2"), "admin");
    expect(peer.claimNext("unrelated")?.summary.id).toBe(unrelated.id);
    peer.finish(unrelated.id, "unrelated", "succeeded");
    expect(peer.claimNext("backoff")).toBeNull();
    f.advance(5000);
    expect(peer.claimNext("retry")?.summary).toMatchObject({ id: first.id, attempt: 2 });
    peer.interrupt(first.id, "retry", "Worker shutdown");
    expect(f.store.claimNext("restarted", 100)?.summary).toMatchObject({
      id: first.id,
      attempt: 3,
    });
    f.advance(101);
    expect(peer.claimNext("replacement")?.summary).toMatchObject({ id: first.id, attempt: 4 });
    peer.finish(first.id, "replacement", "succeeded");
    expect(f.store.claimNext("following")?.summary.id).toBe(blocked.id);
  });

  it.each(["waiting", "interrupted", "expired lease"])(
    "retains shared-resource locks through %s without blocking unrelated work or its own recovery",
    (stage) => {
      const f = fixture();
      const peer = f.open().store;
      const update = (resourceId: string) => ({
        ...operation(resourceId, { bootVolumeId: "shared-volume" }),
        kind: "boot-volume-update" as const,
      });
      const accepted = f.store.enqueueOperation(update("instance-1"), "admin");
      f.store.claimNext("initial");
      f.store.waitForCompletion(accepted.id, "initial", "OCI processing");
      f.advance(1);
      const sameInstance = f.store.enqueueOperation(operation("instance-1"), "admin");
      f.advance(1);
      const sameVolume = f.store.enqueueOperation(update("instance-2"), "admin");
      f.advance(1);
      const unrelated = f.store.enqueueOperation(operation("instance-3"), "admin");
      expect(peer.claimNext("unrelated")?.summary.id).toBe(unrelated.id);
      peer.finish(unrelated.id, "unrelated", "succeeded");
      expect(peer.claimNext("too-early")).toBeNull();
      f.advance(5000);
      if (stage !== "waiting") {
        expect(f.store.claimNext("recovering", 100)?.summary.id).toBe(accepted.id);
        if (stage === "interrupted")
          f.store.interrupt(accepted.id, "recovering", "Worker shutdown");
        else f.advance(101);
      }
      expect(peer.claimNext("replacement")?.summary).toMatchObject({
        id: accepted.id,
        attempt: 1,
        waitingForCompletion: true,
      });
      expect(peer.claimNext("still-blocked")).toBeNull();
      peer.finish(accepted.id, "replacement", "succeeded");
      expect(peer.claimNext("same-instance")?.summary.id).toBe(sameInstance.id);
      peer.finish(sameInstance.id, "same-instance", "succeeded");
      expect(peer.claimNext("same-volume")?.summary.id).toBe(sameVolume.id);
    },
  );

  it("releases a pending completion lock when the task is cancelled", () => {
    const f = fixture();
    const accepted = f.store.enqueueOperation(operation(), "admin");
    f.store.claimNext("initial");
    f.store.waitForCompletion(accepted.id, "initial", "OCI processing");
    const following = f.store.enqueueOperation(operation(), "admin");
    expect(f.store.claimNext("blocked")).toBeNull();
    f.store.cancelJob(accepted.id);
    expect(f.store.claimNext("following")?.summary.id).toBe(following.id);
  });

  it("resumes an accepted last-budget attempt and persists its deadline through lease recovery", () => {
    const f = fixture();
    const job = f.store.enqueueOperation(operation(), "admin");
    f.db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(job.id);
    const first = f.store.claimNext("first")!;
    f.store.waitForCompletion(job.id, "first", "OCI processing");
    f.advance(5000);
    const waiting = f.store.claimNext("crashed", 100)!;
    expect(waiting.summary).toMatchObject({
      attempt: 1,
      maxAttempts: 1,
      waitingForCompletion: true,
      completionDeadlineAt: first.summary.completionDeadlineAt,
    });
    f.advance(101);
    const recovered = f.open().store.claimNext("replacement")!;
    expect(recovered.summary).toMatchObject({
      id: job.id,
      attempt: 1,
      waitingForCompletion: true,
      completionDeadlineAt: first.summary.completionDeadlineAt,
    });
    f.store.retryLater(job.id, "replacement", "A genuine transport error", 100);
    expect(f.store.getJob(job.id)?.state).toBe("failed");
  });

  it("allows explicitly cancelling an exhausted interrupted task", () => {
    const f = fixture();
    const job = f.store.enqueueOperation(operation(), "admin");
    f.store.claimNext("crashed", 100);
    f.db.prepare("UPDATE jobs SET attempt=max_attempts WHERE id=?").run(job.id);
    f.advance(101);
    expect(f.store.claimNext("replacement")).toBeNull();
    expect(f.store.getJob(job.id)).toMatchObject({ state: "interrupted", nextRunAt: null });
    expect(f.store.cancelJob(job.id).state).toBe("cancelled");
    expect(f.store.claimNext("replacement")).toBeNull();
  });
});

describe("global scheduling bounds across SQLite connections", () => {
  const extra = (id: string) => ({ ...account, id, name: id });
  const sync = (accountId: string): OperationRequest => ({
    kind: "sync-account",
    accountId,
    region: "region-a",
    payload: {},
  });
  const write = (accountId: string): OperationRequest => ({
    ...operation(accountId + "-instance"),
    accountId,
  });

  it("admits two different-account reads and one unrelated write, but never a third read or second write", () => {
    const f = fixture([extra("b"), extra("c"), extra("d"), extra("e")]);
    const peer = f.open().store;
    const a = f.store.enqueueOperation(sync(account.id), "admin");
    f.advance(1);
    const b = f.store.enqueueOperation(sync("b"), "admin");
    f.advance(1);
    const c = f.store.enqueueOperation(sync("c"), "admin");
    f.advance(1);
    const d = f.store.enqueueOperation(write("d"), "admin");
    f.advance(1);
    const e = f.store.enqueueOperation(write("e"), "admin");
    expect(f.store.claimNext("read-a")?.summary.id).toBe(a.id);
    expect(peer.claimNext("read-b")?.summary.id).toBe(b.id);
    expect(peer.claimNext("write-d")?.summary.id).toBe(d.id);
    expect(f.store.claimNext("extra")).toBeNull();
    expect(f.store.getJob(c.id)?.attempt).toBe(0);
    expect(f.store.getJob(e.id)?.attempt).toBe(0);
    f.store.finish(a.id, "read-a", "succeeded");
    expect(peer.claimNext("read-c")?.summary.id).toBe(c.id);
    peer.finish(d.id, "write-d", "succeeded");
    expect(f.store.claimNext("write-e")?.summary.id).toBe(e.id);
  });

  it("blocks same-account reads behind a write and same-account writes behind a read", () => {
    const f = fixture([extra("b")]);
    const peer = f.open().store;
    const a = f.store.enqueueOperation(write(account.id), "admin");
    expect(f.store.claimNext("writer")?.summary.id).toBe(a.id);
    f.advance(1);
    const sameRead = f.store.enqueueOperation(sync(account.id), "admin");
    f.advance(1);
    const otherRead = f.store.enqueueOperation(sync("b"), "admin");
    expect(peer.claimNext("reader-b")?.summary.id).toBe(otherRead.id);
    expect(peer.claimNext("reader-a")).toBeNull();
    f.store.finish(a.id, "writer", "succeeded");
    expect(peer.claimNext("reader-a")?.summary.id).toBe(sameRead.id);
    const sameWrite = f.store.enqueueOperation(write(account.id), "admin");
    expect(f.store.claimNext("writer-again")).toBeNull();
    peer.finish(sameRead.id, "reader-a", "succeeded");
    expect(f.store.claimNext("writer-again")?.summary.id).toBe(sameWrite.id);
  });

  it("holds cancellation slots until acknowledged and gives explicit work priority over background reads", () => {
    const f = fixture([extra("b"), extra("c")]);
    const background = f.store.refreshInventory([account.id, "b"], "auto", "admin").jobs;
    f.advance(1);
    const manual = f.store.enqueueOperation(write("c"), "admin");
    expect(f.store.claimNext("writer")?.summary.id).toBe(manual.id);
    const first = f.store.claimNext("first-reader")!;
    const second = f.open().store.claimNext("second-reader")!;
    expect(background.map((job) => job.id)).toContain(first.summary.id);
    expect(background.map((job) => job.id)).toContain(second.summary.id);
    f.store.cancelJob(first.summary.id);
    const replacement = f.store.enqueueOperation(sync(first.operation.accountId), "admin");
    expect(f.store.claimNext("replacement")).toBeNull();
    f.store.finish(first.summary.id, "first-reader", "cancelled");
    expect(f.store.claimNext("replacement")?.summary.id).toBe(replacement.id);
  });
});
