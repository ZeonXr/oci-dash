import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, InventoryResult } from "@/lib/contracts";
import { createJobStore } from "@/server/jobs/store";
import { runWorker, type WorkerDependencies } from "@/server/jobs/worker";
import { requestInventoryRefresh } from "@/server/inventory-refresh";
import { getDatabase, closeDatabase } from "@/server/db";
import { login, SESSION_COOKIE } from "@/server/auth";
import { handleApi } from "@/server/router";
import { getJobStore } from "@/server/jobs";

const cloud = vi.hoisted(() => ({
  verify: vi.fn(),
  inventory: vi.fn(),
  execute: vi.fn(),
  metrics: vi.fn(),
  createOptions: vi.fn(),
  securityGroups: vi.fn(),
}));
vi.mock("@/server/oci/adapter", () => ({ ociAdapter: cloud }));
const handles: Database.Database[] = [];
const directories: { path: string; base: string }[] = [];
const ORIGIN = "https://inventory-refresh-tests.invalid";
const account = (id = "account-a"): AccountSummary => ({
  id,
  name: `Account ${id}`,
  tenancyId: "test-tenancy",
  userId: "test-user",
  fingerprint: "test-fingerprint",
  homeRegion: "test-region",
  regions: ["test-region"],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function directory() {
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "inventory-refresh-test-"));
  directories.push({ path, base });
  return path;
}

function fixture() {
  const path = join(directory(), "queue.sqlite");
  const accounts = new Map([account(), account("account-b")].map((value) => [value.id, value]));
  let time = Date.parse("2026-01-01T00:00:00.000Z");
  const reads: boolean[] = [];
  const open = () => {
    const db = new Database(path);
    handles.push(db);
    db.pragma("journal_mode=WAL");
    db.pragma("foreign_keys=ON");
    db.pragma("busy_timeout=1000");
    const store = createJobStore({
      db,
      getAccount: (id) => {
        reads.push(db.inTransaction);
        return accounts.get(id) ?? null;
      },
      now: () => new Date(time),
    });
    return { db, store };
  };
  const initial = open();
  const finish = (
    id: string,
    state: "succeeded" | "failed" | "cancelled" = "succeeded",
    warnings: string[] = [],
  ) => {
    const claimed = initial.store.claimNext("test-worker");
    expect(claimed?.summary.id).toBe(id);
    const current = accounts.get(claimed!.summary.accountId)!;
    if (state === "succeeded") {
      current.lastSyncAt = new Date(time).toISOString();
      current.status = warnings.length ? "error" : "connected";
    } else if (state === "failed") current.status = "error";
    initial.store.finish(
      id,
      "test-worker",
      state,
      state === "succeeded" ? { warnings } : undefined,
      state === "failed" ? "offline simulated failure" : undefined,
    );
  };
  return {
    ...initial,
    path,
    accounts,
    reads,
    open,
    finish,
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

beforeEach(() => {
  closeDatabase();
  for (const mock of Object.values(cloud)) {
    mock.mockReset();
    mock.mockRejectedValue(new Error("Real OCI adapter must not run in refresh requests"));
  }
});
afterEach(() => {
  closeDatabase();
  for (const db of handles.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const { path, base } of directories.splice(0)) {
    if (dirname(resolve(path)) !== base || !basename(path).startsWith("inventory-refresh-test-"))
      throw new Error("Unsafe inventory refresh test cleanup path");
    rmSync(path, { recursive: true, force: true });
  }
});

describe("transactional page-triggered inventory refresh", () => {
  it("deduplicates accounts and concurrent connections under the same immediate transaction", () => {
    const f = fixture(),
      peer = f.open();
    const first = f.store.refreshInventory(["account-a", "account-a"], "auto", "first-tab");
    const second = peer.store.refreshInventory(["account-a"], "auto", "second-tab");
    expect(first.jobs).toHaveLength(1);
    expect(second.accounts[0].status).toBe("active");
    expect(second.jobs[0].id).toBe(first.jobs[0].id);
    expect(f.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 1 });
    expect(f.reads.every(Boolean)).toBe(true);
    expect(f.store.listJobs()).toHaveLength(0);
    expect(f.store.getJob(first.jobs[0].id)).not.toBeNull();
    expect(f.store.listAccountSyncJobs()[0].id).toBe(first.jobs[0].id);
  });

  it("honors the 60-second cache and reevaluates freshness in the transaction", () => {
    const f = fixture();
    f.accounts.get("account-a")!.lastSyncAt = f.now().toISOString();
    const fresh = f.store.refreshInventory(["account-a"], "auto", "admin");
    expect(fresh.jobs).toHaveLength(0);
    expect(fresh.accounts[0]).toMatchObject({
      status: "fresh",
      nextRefreshAt: "2026-01-01T00:01:00.000Z",
    });
    f.advance(59_999);
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "fresh",
    );
    f.advance(1);
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "queued",
    );
    expect(f.reads.every(Boolean)).toBe(true);
  });

  it("lets manual refresh bypass cache while coalescing a completed multi-tab request for only two seconds", () => {
    const f = fixture(),
      peer = f.open();
    f.accounts.get("account-a")!.lastSyncAt = f.now().toISOString();
    const first = f.store.refreshInventory(["account-a"], "manual", "admin");
    expect(first.accounts[0].status).toBe("queued");
    f.finish(first.jobs[0].id);
    f.advance(1_999);
    const duplicate = peer.store.refreshInventory(["account-a"], "manual", "another-tab");
    expect(duplicate.accounts[0].status).toBe("throttled");
    expect(duplicate.jobs[0].id).toBe(first.jobs[0].id);
    f.advance(1);
    const again = peer.store.refreshInventory(["account-a"], "manual", "admin");
    expect(again.accounts[0].status).toBe("queued");
    expect(again.jobs[0].id).not.toBe(first.jobs[0].id);
    expect(f.store.listJobs()).toHaveLength(2);
  });

  it("promotes a reused automatic job into user-visible history for manual refresh", () => {
    const f = fixture();
    const auto = f.store.refreshInventory(["account-a"], "auto", "admin");
    expect(f.store.listJobs()).toHaveLength(0);
    const manual = f.store.refreshInventory(["account-a"], "manual", "admin");
    expect(manual.accounts[0].status).toBe("active");
    expect(manual.jobs[0].id).toBe(auto.jobs[0].id);
    expect(f.store.listJobs().map((job) => job.id)).toEqual([auto.jobs[0].id]);
    f.finish(auto.jobs[0].id);
    f.advance(60_000);
    const next = f.store.refreshInventory(["account-a"], "auto", "admin");
    f.finish(next.jobs[0].id);
    expect(f.store.getJob(auto.jobs[0].id)).not.toBeNull();
  });

  it("backs off terminal auto failures exponentially up to 15 minutes", () => {
    const f = fixture();
    for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
      const result = f.store.refreshInventory(["account-a"], "auto", "admin");
      expect(result.accounts[0].status).toBe("queued");
      f.finish(result.jobs[0].id, "failed");
      const skipped = f.store.refreshInventory(["account-a"], "auto", "admin");
      expect(skipped.jobs).toHaveLength(0);
      expect(skipped.accounts[0].status).toBe("backoff");
      expect(Date.parse(skipped.accounts[0].nextRefreshAt!) - f.now().getTime()).toBe(delay);
      f.advance(delay);
    }
  });

  it("allows manual retry during auto backoff and clears failures after a successful refresh", () => {
    const f = fixture();
    const first = f.store.refreshInventory(["account-a"], "auto", "admin");
    f.finish(first.jobs[0].id, "failed");
    const manual = f.store.refreshInventory(["account-a"], "manual", "admin");
    expect(manual.accounts[0].status).toBe("queued");
    f.finish(manual.jobs[0].id);
    expect(
      f.db
        .prepare(
          "SELECT failure_count,retry_after FROM inventory_refresh_state WHERE account_id='account-a'",
        )
        .get(),
    ).toEqual({ failure_count: 0, retry_after: null });
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "fresh",
    );
  });

  it("recognizes a newer successful post-operation inventory publication as recovery", () => {
    const f = fixture();
    const first = f.store.refreshInventory(["account-a"], "auto", "admin");
    f.finish(first.jobs[0].id, "failed");
    f.db
      .prepare(
        "UPDATE inventory_refresh_state SET failure_count=5,retry_after=? WHERE account_id='account-a'",
      )
      .run(new Date(f.now().getTime() + 900_000).toISOString());
    f.advance(1_000);
    Object.assign(f.accounts.get("account-a")!, {
      status: "connected",
      lastSyncAt: f.now().toISOString(),
    });
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "fresh",
    );
    expect(
      f.db
        .prepare(
          "SELECT failure_count,retry_after FROM inventory_refresh_state WHERE account_id='account-a'",
        )
        .get(),
    ).toEqual({ failure_count: 0, retry_after: null });
    f.advance(60_000);
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "queued",
    );
  });

  it("also backs off partial inventory results with warnings", () => {
    const f = fixture();
    for (let i = 0; i < 2; i++) {
      const next = f.store.refreshInventory(["account-a"], "auto", "admin");
      f.finish(next.jobs[0].id, "succeeded", ["One selected region was unavailable"]);
      expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
        "backoff",
      );
      f.advance(60_000);
    }
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").accounts[0].status).toBe(
      "backoff",
    );
  });

  it("retains only the latest completed auto job and its events without pruning user history", () => {
    const f = fixture();
    const manual = f.store.enqueueOperation(
      {
        kind: "instance-rename",
        accountId: "account-a",
        region: "test-region",
        resourceId: "instance-a",
        payload: { name: "name" },
      },
      "admin",
    );
    f.store.cancelJob(manual.id);
    const completed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = f.store.refreshInventory(["account-a"], "auto", "admin").jobs[0];
      f.finish(next.id);
      completed.push(next.id);
      f.advance(60_000);
    }
    expect(f.store.getJob(completed[0])).toBeNull();
    expect(f.store.getJob(completed[1])).toBeNull();
    expect(f.store.getJob(completed[2])).not.toBeNull();
    expect(f.store.getJob(manual.id)).not.toBeNull();
    expect(f.store.listJobs(1).map((job) => job.id)).toEqual([manual.id]);
    expect(
      f.db
        .prepare(
          "SELECT count(*) AS count FROM job_events WHERE job_id NOT IN (SELECT id FROM jobs)",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      f.db
        .prepare(
          "SELECT count(*) AS count FROM job_resources WHERE job_id NOT IN (SELECT id FROM jobs)",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("reuses a recoverable interrupted sync but replaces an exhausted or cancelled one", () => {
    const f = fixture();
    const first = f.store.refreshInventory(["account-a"], "auto", "admin").jobs[0];
    f.store.claimNext("worker");
    f.store.interrupt(first.id, "worker", "restart");
    expect(f.store.refreshInventory(["account-a"], "auto", "admin").jobs[0].id).toBe(first.id);
    f.store.claimNext("worker");
    f.db.prepare("UPDATE jobs SET attempt=max_attempts WHERE id=?").run(first.id);
    f.store.interrupt(first.id, "worker", "retry budget exhausted");
    const replacement = f.store.refreshInventory(["account-a"], "manual", "admin").jobs[0];
    expect(replacement.id).not.toBe(first.id);
    f.store.cancelJob(replacement.id);
    expect(f.store.listAccountSyncJobs()[0].id).toBe(replacement.id);
    f.advance(2_000);
    expect(f.store.refreshInventory(["account-a"], "manual", "admin").jobs[0].id).not.toBe(
      replacement.id,
    );
  });

  it("does not reuse an expired exhausted lease indefinitely", () => {
    const f = fixture();
    const first = f.store.refreshInventory(["account-a"], "auto", "admin").jobs[0];
    f.db.prepare("UPDATE jobs SET max_attempts=1 WHERE id=?").run(first.id);
    f.store.claimNext("lost-worker", 100);
    f.advance(101);
    expect(f.store.claimNext("new-worker")).toBeNull();
    expect(f.store.getJob(first.id)).toMatchObject({ state: "interrupted", nextRunAt: null });
    const manual = f.store.refreshInventory(["account-a"], "manual", "admin");
    expect(manual.accounts[0].status).toBe("queued");
    expect(manual.jobs[0].id).not.toBe(first.id);
  });

  it("prioritizes queued user operations over automatic refresh", () => {
    const f = fixture();
    f.store.refreshInventory(["account-a"], "auto", "admin");
    const manual = f.store.enqueueOperation(
      {
        kind: "instance-rename",
        accountId: "account-b",
        region: "test-region",
        resourceId: "instance-b",
        payload: { name: "name" },
      },
      "admin",
    );
    expect(f.store.claimNext("worker")?.summary.id).toBe(manual.id);
  });

  it("rolls back an entire multi-account refresh if one account no longer exists", () => {
    const f = fixture();
    expect(() => f.store.refreshInventory(["account-a", "missing"], "auto", "admin")).toThrow(
      expect.objectContaining({ code: "ACCOUNT_NOT_FOUND" }),
    );
    expect(f.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 0 });
    expect(f.db.prepare("SELECT count(*) AS count FROM inventory_refresh_state").get()).toEqual({
      count: 0,
    });
  });

  it("migrates existing user jobs without hiding or deleting their history", () => {
    const db = new Database(join(directory(), "legacy-queue.sqlite"));
    handles.push(db);
    // Keep the old queue structure independent of today's indexes and migrations.
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
        region TEXT NOT NULL, resource_id TEXT, resource_lock TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued','running','retrying','succeeded','failed','cancel_requested','cancelled','interrupted')),
        attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 4,
        created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, next_run_at TEXT, last_error TEXT,
        result_json TEXT, operation_json TEXT NOT NULL, requested_by TEXT NOT NULL,
        idempotency_key TEXT, payload_hash TEXT NOT NULL, checkpoints_json TEXT NOT NULL DEFAULT '{}',
        lease_owner TEXT, lease_expires_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
        needs_reconcile INTEGER NOT NULL DEFAULT 0
      );
    `);
    const operation = {
      kind: "sync-account",
      accountId: "account-a",
      region: "test-region",
      payload: {},
    };
    db.prepare(
      `
      INSERT INTO jobs(id,kind,account_id,account_name,region,resource_lock,state,created_at,
        finished_at,operation_json,requested_by,payload_hash,result_json,checkpoints_json)
      VALUES('legacy-manual','sync-account','account-a','Account account-a','test-region',
        'account-a:sync-account','succeeded','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:01:00.000Z',?,'admin','legacy-payload','{"warnings":[]}','{"saved":true}')
    `,
    ).run(JSON.stringify(operation));
    const store = createJobStore({ db, getAccount: () => account() });
    expect(store.listJobs()).toMatchObject([
      { id: "legacy-manual", state: "succeeded", result: { warnings: [] } },
    ]);
    expect(db.prepare("SELECT background FROM jobs WHERE id='legacy-manual'").get()).toEqual({
      background: 0,
    });
    expect(db.prepare("SELECT checkpoints_json FROM jobs WHERE id='legacy-manual'").get()).toEqual({
      checkpoints_json: '{"saved":true}',
    });
  });

  it("does not schedule more work merely because time passes or the queue is opened again", () => {
    const f = fixture();
    const first = f.store.refreshInventory(["account-a"], "auto", "admin").jobs[0];
    f.finish(first.id);
    f.advance(24 * 60 * 60_000);
    const reopened = f.open();
    expect(reopened.store.claimNext("worker")).toBeNull();
    expect(reopened.db.prepare("SELECT count(*) AS count FROM jobs").get()).toEqual({ count: 1 });
  });

  it("runs a manual refresh against the worker's OCI read boundary even when the cache was fresh", async () => {
    const f = fixture();
    f.accounts.get("account-a")!.lastSyncAt = f.now().toISOString();
    const queued = f.store.refreshInventory(["account-a"], "manual", "admin").jobs[0];
    const result: InventoryResult = { instances: [], warnings: [], regions: ["test-region"] };
    const adapter = {
      verify: vi.fn(async () => ({
        tenancyName: "test",
        homeRegion: "test-region",
        regions: ["test-region"],
      })),
      inventory: vi.fn(async () => result),
      execute: vi.fn(async () => ({ message: "must not execute" })),
    };
    const dependencies: WorkerDependencies = {
      store: f.store,
      adapter,
      getCredentials: () => ({
        tenancyId: "test",
        userId: "test",
        fingerprint: "test",
        privateKey: "FAKE_TEST_CREDENTIAL",
        region: "test-region",
      }),
      saveInventory: vi.fn(),
      setAccountError: vi.fn(),
    };
    await runWorker({ dependencies, once: true, signal: new AbortController().signal });
    expect(adapter.verify).not.toHaveBeenCalled();
    expect(adapter.inventory).toHaveBeenCalledTimes(1);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(f.store.getJob(queued.id)?.state).toBe("succeeded");
  });
});

function apiFixture() {
  vi.stubEnv("DATABASE_PATH", join(directory(), "api.sqlite"));
  vi.stubEnv("ADMIN_USERNAME", "refresh-admin");
  vi.stubEnv("ADMIN_PASSWORD", "test-only-refresh-password");
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  const db = getDatabase();
  for (const id of ["account-a", "account-b"]) {
    db.prepare(
      "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      id,
      "tenancy-test",
      "user-test",
      "fingerprint-test",
      "test-region",
      '["test-region"]',
      "synthetic-private-credential-not-to-read",
      "connected",
      new Date().toISOString(),
    );
  }
  const token = login("refresh-admin", "test-only-refresh-password").token;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    handleApi(
      new Request(`${ORIGIN}/api/${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          origin: ORIGIN,
          "content-type": "application/json",
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      path.split("/"),
    );
  return { db, request };
}

describe("inventory refresh API boundaries", () => {
  it("enqueues all accounts when omitted and returns the shared response contract without cloud calls", async () => {
    const f = apiFixture();
    const response = await f.request("inventory/refresh", "POST", { mode: "auto" });
    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toMatchObject({
      accounts: [
        { accountId: "account-a", status: "queued" },
        { accountId: "account-b", status: "queued" },
      ],
    });
    expect(body.jobs).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain("synthetic-private-credential-not-to-read");
    for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
    expect(getJobStore().listJobs()).toHaveLength(0);
  });

  it("requires login, same Origin and a valid explicit mode", async () => {
    const f = apiFixture();
    expect(
      (await f.request("inventory/refresh", "POST", { mode: "auto" }, { cookie: "" })).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          "inventory/refresh",
          "POST",
          { mode: "auto" },
          { origin: "https://other.invalid" },
        )
      ).status,
    ).toBe(403);
    for (const body of [
      {},
      { mode: "surprise" },
      { mode: "auto", accountIds: [""] },
      { mode: "manual", unexpected: true },
    ])
      expect((await f.request("inventory/refresh", "POST", body)).status).toBe(400);
    expect(getJobStore().listAccountSyncJobs()).toHaveLength(0);
  });

  it("keeps GET inventory routes passive", async () => {
    const f = apiFixture();
    for (const path of ["dashboard", "accounts", "instances", "jobs"])
      expect((await f.request(path)).status).toBe(200);
    expect((await f.request("inventory/refresh")).status).toBe(404);
    expect(getJobStore().listAccountSyncJobs()).toHaveLength(0);
    for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
  });

  it("validates direct refresh requests and forwards the selected scope to the persistent queue", () => {
    const refresh = vi.fn(() => ({ jobs: [], accounts: [] }));
    const dependencies = { store: { refreshInventory: refresh }, accountIds: () => ["account-a"] };
    expect(() => requestInventoryRefresh({ mode: "unexpected" }, "admin", dependencies)).toThrow();
    expect(refresh).not.toHaveBeenCalled();
    expect(requestInventoryRefresh({ mode: "manual" }, "admin", dependencies)).toEqual({
      jobs: [],
      accounts: [],
    });
    expect(refresh).toHaveBeenCalledWith(["account-a"], "manual", "admin");
  });

  it("routes the legacy account sync through manual deduplication without repeating its audit event", async () => {
    const f = apiFixture();
    const first = await f.request("accounts/account-a/sync", "POST");
    const second = await f.request("accounts/account-a/sync", "POST");
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect((await second.json()).job.id).toBe((await first.json()).job.id);
    expect(
      f.db
        .prepare("SELECT count(*) AS count FROM audit_events WHERE action='inventory.sync'")
        .get(),
    ).toEqual({ count: 1 });
    expect(getJobStore().listJobs()).toHaveLength(1);
  });
});
