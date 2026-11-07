import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { InstanceSummary } from "@/lib/contracts";
import { closeDatabase, getDatabase } from "@/server/db";
import { login, SESSION_COOKIE } from "@/server/auth";
import {
  createAccount,
  getAccount,
  getCredentialSnapshot,
  getCredentials,
  listAccounts,
  type AccountInput,
} from "@/server/accounts";
import { createAccountConnection } from "@/server/account-connection";
import { getJobStore } from "@/server/jobs";
import { saveInventory } from "@/server/inventory";
import { AppError } from "@/server/errors";
import { handleApi } from "@/server/router";

const cloud = vi.hoisted(() => ({
  verify: vi.fn(),
  inventory: vi.fn(),
  metrics: vi.fn(),
  createOptions: vi.fn(),
  securityGroups: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/server/oci/adapter", () => ({ ociAdapter: cloud }));

const ORIGIN = "https://connection-tests.invalid";
const USERNAME = "connection-admin";
const PASSWORD = "connection-test-password-only";
const directories: { path: string; base: string }[] = [];
const ocid = (kind: string) => `ocid1.${kind}.oc1..testconnectionresource`;
let firstKey: { privateKey: string; fingerprint: string };
let replacementKey: { privateKey: string; fingerprint: string };
let token: string;

function makeKey() {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  return {
    privateKey: pair.privateKey,
    fingerprint: createHash("md5").update(pair.publicKey).digest("hex").match(/.{2}/g)!.join(":"),
  };
}

beforeAll(() => {
  firstKey = makeKey();
  replacementKey = makeKey();
});
beforeEach(() => {
  closeDatabase();
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "oci-dash-connection-test-"));
  directories.push({ path, base });
  vi.stubEnv("DATABASE_PATH", join(path, "connections.sqlite"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 6).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", USERNAME);
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.stubEnv("DEMO_MODE", "false");
  for (const mock of Object.values(cloud)) {
    mock.mockReset();
    mock.mockRejectedValue(new Error("OCI must not run in account save requests"));
  }
  token = login(USERNAME, PASSWORD).token;
});
afterEach(() => {
  try {
    for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
    closeDatabase();
    vi.unstubAllEnvs();
    for (const { path, base } of directories.splice(0)) {
      const target = resolve(path);
      if (dirname(target) !== base || !basename(target).startsWith("oci-dash-connection-test-")) {
        throw Error("Unsafe account connection test cleanup path");
      }
      rmSync(target, { recursive: true, force: true });
    }
  }
});

function input(changes: Partial<AccountInput> = {}): AccountInput {
  return {
    name: "Account connection test",
    tenancyId: ocid("tenancy"),
    userId: ocid("user"),
    ...firstKey,
    homeRegion: "ap-singapore-1",
    regions: ["ap-singapore-1", "ap-tokyo-1"],
    ...changes,
  };
}
function call(method: string, path: string, body?: unknown) {
  return handleApi(
    new Request(`${ORIGIN}/api/${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        cookie: `${SESSION_COOKIE}=${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    path.split("/"),
  );
}
function auditCount(): number {
  return (
    getDatabase().prepare("SELECT count(*) AS total FROM audit_events").get() as { total: number }
  ).total;
}
function failAfterEnqueue() {
  const store = getJobStore();
  const original = store.enqueueAccountSync;
  return vi.spyOn(store, "enqueueAccountSync").mockImplementation((...args) => {
    original(...args);
    throw new AppError("模拟队列提交失败", 503, "QUEUE_UNAVAILABLE");
  });
}
function storedAccount(id: string) {
  return getDatabase().prepare("SELECT * FROM accounts WHERE id=?").get(id);
}

describe("atomic account save and background connection", () => {
  it("POST saves an encrypted account and a durable queued sync without contacting OCI", async () => {
    const response = await call("POST", "accounts", input());
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.account).toMatchObject({ name: "Account connection test", status: "unchecked" });
    expect(body.job).toMatchObject({
      accountId: body.account.id,
      kind: "sync-account",
      state: "queued",
      region: "ap-singapore-1",
    });
    expect(getJobStore().listJobs()).toHaveLength(1);
    const savedJob = getJobStore().getJob(body.job.id);
    expect(savedJob?.id).toBe(body.job.id);
    const record = storedAccount(body.account.id) as { credential: string };
    expect(record.credential).toMatch(/^v1\./);
    expect(record.credential).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(body.account).not.toHaveProperty("credential");
    expect(body.account).not.toHaveProperty("privateKey");
  });

  it("rolls back the account, audit and even an already-inserted job when enqueue later fails", async () => {
    const failedEnqueue = failAfterEnqueue();
    const baselineAudit = auditCount();
    const response = await call("POST", "accounts", input());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "QUEUE_UNAVAILABLE" });
    expect(failedEnqueue).toHaveBeenCalledTimes(1);
    expect(listAccounts()).toEqual([]);
    expect(getJobStore().listJobs()).toEqual([]);
    expect(auditCount()).toBe(baselineAudit);
    expect(
      (getDatabase().prepare("SELECT count(*) AS total FROM job_events").get() as { total: number })
        .total,
    ).toBe(0);
    expect(
      (
        getDatabase().prepare("SELECT count(*) AS total FROM job_resources").get() as {
          total: number;
        }
      ).total,
    ).toBe(0);
  });

  it("name-only PATCH preserves the selected regions and does not create a sync job", async () => {
    const account = createAccount(input(), USERNAME);
    const before = getCredentialSnapshot(account.id);
    const response = await call("PATCH", `accounts/${account.id}`, { name: "Renamed account" });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.account.name).toBe("Renamed account");
    expect(body.job ?? null).toBeNull();
    expect(getAccount(account.id)?.regions).toEqual(account.regions);
    expect(getCredentialSnapshot(account.id).revision).toBe(before.revision);
    expect(getJobStore().listJobs()).toEqual([]);
  });

  it("renaming while its initial sync is pending does not add a second task or block metadata editing", async () => {
    const initial = createAccountConnection(input(), USERNAME);
    const response = await call("PATCH", `accounts/${initial.account.id}`, {
      name: "Renamed while queued",
    });
    expect(response.status).toBe(200);
    expect(getAccount(initial.account.id)?.name).toBe("Renamed while queued");
    expect(
      getJobStore()
        .listJobs()
        .map((job) => job.id),
    ).toEqual([initial.job!.id]);
  });

  it("replacing a key creates a sync for the committed new revision", async () => {
    const account = createAccount(input(), USERNAME);
    const before = getCredentialSnapshot(account.id);
    const response = await call("PATCH", `accounts/${account.id}`, replacementKey);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).toMatchObject({
      kind: "sync-account",
      accountId: account.id,
      state: "queued",
    });
    expect(body.account.status).toBe("unchecked");
    expect(getCredentialSnapshot(account.id).revision).toBe(before.revision + 1);
    expect(getCredentials(account.id).privateKey).toBe(replacementKey.privateKey.trim());
    expect(getCredentials(account.id).fingerprint).toBe(replacementKey.fingerprint);
    expect(getJobStore().listJobs()).toHaveLength(1);
  });

  it("changing the actual region set or home region queues a sync", async () => {
    for (const [index, change] of [
      { regions: ["ap-singapore-1"] },
      { homeRegion: "uk-london-1" },
    ].entries()) {
      const account = createAccount(input({ tenancyId: ocid("tenancy") + index }), USERNAME);
      const response = await call("PATCH", `accounts/${account.id}`, change);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.job).toMatchObject({
        kind: "sync-account",
        accountId: account.id,
        state: "queued",
        region: change.homeRegion ?? account.homeRegion,
      });
      expect(getCredentialSnapshot(account.id).revision).toBe(1);
    }
  });

  it("reordering or repeating the same region set does not queue unnecessary verification", async () => {
    const account = createAccount(input(), USERNAME);
    const response = await call("PATCH", `accounts/${account.id}`, {
      regions: ["ap-tokyo-1", "ap-singapore-1", "ap-tokyo-1"],
    });
    expect(response.status).toBe(200);
    expect(getCredentialSnapshot(account.id).revision).toBe(0);
    expect(getAccount(account.id)?.regions.slice().sort()).toEqual(account.regions.slice().sort());
    expect(getJobStore().listJobs()).toEqual([]);
  });

  it("removes disabled-region inventory in the account transaction and restores it on enqueue failure", async () => {
    const account = createAccount(input(), USERNAME);
    const insert = getDatabase().prepare(
      "INSERT INTO resources(id,account_id,region,data,synced_at) VALUES(?,?,?,?,?)",
    );
    for (const region of account.regions)
      insert.run(ocid("instance") + region, account.id, region, "{}", new Date().toISOString());
    const before = getDatabase().prepare("SELECT * FROM resources ORDER BY id").all();
    const failure = failAfterEnqueue();
    const rejected = await call("PATCH", `accounts/${account.id}`, {
      regions: [account.homeRegion],
    });
    expect(rejected.status).toBe(503);
    expect(getDatabase().prepare("SELECT * FROM resources ORDER BY id").all()).toEqual(before);
    expect(getAccount(account.id)?.regions).toEqual(account.regions);
    failure.mockRestore();
    const accepted = await call("PATCH", `accounts/${account.id}`, {
      regions: [account.homeRegion],
    });
    expect(accepted.status).toBe(200);
    expect(
      getDatabase().prepare("SELECT region FROM resources WHERE account_id=?").all(account.id),
    ).toEqual([{ region: account.homeRegion }]);
  });

  it("restores old credentials, revision, cached resources and audit when update enqueue fails", async () => {
    const account = createAccount(input(), USERNAME);
    const resource: InstanceSummary = {
      id: ocid("instance"),
      accountId: account.id,
      accountName: account.name,
      displayName: "cached-instance",
      region: account.homeRegion,
      availabilityDomain: "TEST:AD-1",
      compartmentId: account.tenancyId,
      state: "RUNNING",
      shape: "test-shape",
      ocpus: 1,
      memoryGb: 1,
      os: "test",
      createdAt: new Date().toISOString(),
      vnics: [],
      bootVolumes: [],
      tags: {},
      syncedAt: new Date().toISOString(),
    };
    saveInventory(account.id, { instances: [resource], warnings: [], regions: account.regions });
    const beforeAccount = storedAccount(account.id);
    const beforeResources = getDatabase().prepare("SELECT * FROM resources").all();
    const baselineAudit = auditCount();
    failAfterEnqueue();
    const response = await call("PATCH", `accounts/${account.id}`, {
      ...replacementKey,
      name: "must roll back",
    });
    expect(response.status).toBe(503);
    expect(storedAccount(account.id)).toEqual(beforeAccount);
    expect(getDatabase().prepare("SELECT * FROM resources").all()).toEqual(beforeResources);
    expect(getJobStore().listJobs()).toEqual([]);
    expect(auditCount()).toBe(baselineAudit);
    expect(getCredentials(account.id).privateKey).toBe(firstKey.privateKey.trim());
  });

  it("rejects an invalid fingerprint before leaving any account, task or audit residue", async () => {
    getJobStore();
    const baselineAudit = auditCount();
    const response = await call(
      "POST",
      "accounts",
      input({ fingerprint: "00:".repeat(15) + "00" }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "KEY_FINGERPRINT_MISMATCH" });
    expect(listAccounts()).toEqual([]);
    expect(getJobStore().listJobs()).toEqual([]);
    expect(auditCount()).toBe(baselineAudit);
  });

  it("manual sync reuses the pending automatic sync, including while it is running", async () => {
    const initial = createAccountConnection(input(), USERNAME);
    for (const state of ["queued", "running", "retrying", "interrupted"]) {
      getDatabase().prepare("UPDATE jobs SET state=? WHERE id=?").run(state, initial.job!.id);
      const response = await call("POST", `accounts/${initial.account.id}/sync`);
      expect(response.status).toBe(202);
      expect((await response.json()).job.id).toBe(initial.job!.id);
      expect(getJobStore().listJobs()).toHaveLength(1);
    }
  });

  it("does not mistake a cancelled sync for a fresh connection attempt", async () => {
    const initial = createAccountConnection(input(), USERNAME);
    getJobStore().cancelJob(initial.job!.id);
    const response = await call("POST", `accounts/${initial.account.id}/sync`);
    expect(response.status).toBe(202);
    const next = (await response.json()).job;
    expect(next.id).not.toBe(initial.job!.id);
    expect(next.state).toBe("queued");
    expect(getJobStore().listJobs()).toHaveLength(2);
  });

  it("queues a fresh sync instead of reusing a running task whose cancellation was requested", async () => {
    const initial = createAccountConnection(input(), USERNAME);
    const store = getJobStore();
    expect(store.claimNext("connection-test-worker")?.summary.id).toBe(initial.job!.id);
    expect(store.cancelJob(initial.job!.id).state).toBe("cancel_requested");
    const response = await call("POST", `accounts/${initial.account.id}/sync`);
    expect(response.status).toBe(202);
    const next = (await response.json()).job;
    expect(next.id).not.toBe(initial.job!.id);
    expect(next.state).toBe("queued");
    expect(store.getJob(initial.job!.id)?.state).toBe("cancel_requested");
    expect(store.listJobs()).toHaveLength(2);
  });

  it("demo mode refuses account creation and updates without storing credentials or tasks", async () => {
    const account = createAccount(input(), USERNAME);
    const before = storedAccount(account.id);
    vi.stubEnv("DEMO_MODE", "true");
    expect((await call("POST", "accounts", input())).status).toBe(403);
    expect((await call("PATCH", `accounts/${account.id}`, replacementKey)).status).toBe(403);
    expect(listAccounts()).toHaveLength(1);
    expect(storedAccount(account.id)).toEqual(before);
    expect(getJobStore().listJobs()).toEqual([]);
  });

  it("rejects a duplicate tenancy even with another user, key or region without queue or audit residue", async () => {
    const original = createAccountConnection(input(), USERNAME);
    const auditBefore = auditCount();
    const response = await call(
      "POST",
      "accounts",
      input({
        name: "Duplicate",
        userId: ocid("user") + "other",
        ...replacementKey,
        homeRegion: "uk-london-1",
        regions: ["uk-london-1"],
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "DUPLICATE_TENANCY" });
    expect(listAccounts().map((account) => account.id)).toEqual([original.account.id]);
    expect(
      getJobStore()
        .listJobs()
        .map((job) => job.id),
    ).toEqual([original.job!.id]);
    expect(auditCount()).toBe(auditBefore);
    expect(() => createAccount(input(), USERNAME)).toThrow(
      expect.objectContaining({ code: "DUPLICATE_TENANCY" }),
    );
  });

  it("rolls back a tenancy change that conflicts with another configured account", async () => {
    const original = createAccount(input(), USERNAME);
    const other = createAccount(
      input({ name: "Other", tenancyId: ocid("tenancy") + "other" }),
      USERNAME,
    );
    const before = storedAccount(other.id);
    const auditBefore = auditCount();
    const response = await call("PATCH", `accounts/${other.id}`, {
      tenancyId: original.tenancyId,
      ...replacementKey,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "DUPLICATE_TENANCY" });
    expect(storedAccount(other.id)).toEqual(before);
    expect(getJobStore().listJobs()).toEqual([]);
    expect(auditCount()).toBe(auditBefore);
  });

  it("keeps legacy duplicates for explicit resolution and permits renaming them", async () => {
    const original = createAccount(input(), USERNAME);
    const other = createAccount(
      input({ name: "Legacy duplicate", tenancyId: ocid("tenancy") + "other" }),
      USERNAME,
    );
    getDatabase()
      .prepare("UPDATE accounts SET tenancy_id=? WHERE id=?")
      .run(original.tenancyId, other.id);
    const response = await call("PATCH", `accounts/${other.id}`, {
      name: "Resolve this duplicate",
    });
    expect(response.status).toBe(200);
    expect(listAccounts()).toHaveLength(2);
    expect(getAccount(other.id)?.name).toBe("Resolve this duplicate");
    expect(getJobStore().listJobs()).toEqual([]);
  });
});
