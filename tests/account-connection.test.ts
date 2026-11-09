import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import Database from "better-sqlite3";
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
  setAccountTenancyName,
  updateAccount,
  type AccountInput,
} from "@/server/accounts";
import { createAccountConnection } from "@/server/account-connection";
import { getJobStore } from "@/server/jobs";
import { saveInventory } from "@/server/inventory";
import { AppError } from "@/server/errors";
import { handleApi } from "@/server/router";
import { createConsoleStore } from "@/server/console/store";
import { createConsoleManager } from "@/server/console/manager";
import type { ConsoleTarget, ConsoleTransport } from "@/server/console/types";

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
function failedConsole(accountId: string) {
  const account = getAccount(accountId)!;
  const store = createConsoleStore();
  const now = new Date().toISOString();
  store.reserve({
    id: "11111111-1111-4111-8111-111111111111",
    instanceId: ocid("instance"),
    instanceName: "Recovery fixture",
    accountId,
    region: account.homeRegion,
    ownerUserId: "test-owner",
    ownerUsername: USERNAME,
    ownerSessionHash: "test-login",
    state: "failed",
    connectionId: ocid("instanceconsoleconnection"),
    compartmentId: account.tenancyId,
    creationState: "created",
    createdAt: now,
    expiresAt: now,
    lastActivityAt: now,
    readyAt: null,
    lastError: "API key revoked",
    cleanupPending: true,
    credentialRecoveryReady: true,
    slot: 1,
  });
  return store;
}

describe("atomic account save and background connection", () => {
  it("creates unnamed accounts with a stable temporary name and never requires a filename", async () => {
    for (const [index, name] of [undefined, "   ", "  My OCI account  "].entries()) {
      const data = input({ name, tenancyId: ocid("tenancy") + index });
      const response = await call("POST", "accounts", data);
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.account).toMatchObject({
        name: index === 2 ? "My OCI account" : `OCI-${data.tenancyId.slice(-8)}`,
        nameSource: index === 2 ? "custom" : "pending",
      });
      expect(body.job.state).toBe("queued");
    }
  });

  it("keeps legacy names custom when migrating a database without name sources", () => {
    const account = createAccount(input({ name: "oci_api_key" }), USERNAME);
    getDatabase().exec("ALTER TABLE accounts DROP COLUMN name_source");
    closeDatabase();
    expect(getAccount(account.id)).toMatchObject({ name: "oci_api_key", nameSource: "custom" });
    expect(setAccountTenancyName(account.id, "Cloud tenant", 0)).toBe(false);
    expect(getAccount(account.id)?.name).toBe("oci_api_key");
  });

  it("resets a legacy name explicitly, preserves it until verification, and reuses the queued lookup", async () => {
    const account = createAccount(input({ name: "oci_api_key" }), USERNAME);
    getDatabase()
      .prepare("UPDATE accounts SET status='connected',last_sync_at=? WHERE id=?")
      .run("2026-11-08T12:00:00.000Z", account.id);
    const response = await call("PATCH", `accounts/${account.id}`, { name: "  " });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.account).toMatchObject({
      name: "oci_api_key",
      nameSource: "pending",
      status: "connected",
    });
    expect(body.job).toMatchObject({ accountId: account.id, state: "queued" });
    const repeat = await call("PATCH", `accounts/${account.id}`, { name: "" });
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).job).toBeUndefined();
    expect(getJobStore().listJobs()).toHaveLength(1);
    expect(setAccountTenancyName(account.id, "Cloud tenant", 0)).toBe(true);
    expect(getAccount(account.id)).toMatchObject({ name: "Cloud tenant", nameSource: "tenancy" });
    expect(getJobStore().getJob(body.job.id)?.accountName).toBe("Cloud tenant");
    const noChange = await call("PATCH", `accounts/${account.id}`, { name: "" });
    expect((await noChange.json()).job).toBeUndefined();
    expect(getAccount(account.id)?.nameSource).toBe("tenancy");
  });

  it("rejects switching to automatic naming during an active sync and rolls back when enqueue fails", async () => {
    const initial = createAccountConnection(input(), USERNAME);
    const busy = await call("PATCH", `accounts/${initial.account.id}`, { name: "" });
    expect(busy.status).toBe(409);
    expect(getAccount(initial.account.id)?.nameSource).toBe("custom");
    getJobStore().cancelJob(initial.job!.id);
    const before = storedAccount(initial.account.id);
    const fail = failAfterEnqueue();
    const rejected = await call("PATCH", `accounts/${initial.account.id}`, { name: "" });
    expect(rejected.status).toBe(503);
    expect(storedAccount(initial.account.id)).toEqual(before);
    fail.mockRestore();
  });

  it("does not apply stale or invalid cloud names or overwrite a custom name edited during verification", () => {
    const account = createAccount(input({ name: undefined }), USERNAME);
    const revision = getCredentialSnapshot(account.id).revision;
    for (const name of ["", "   ", account.tenancyId])
      expect(setAccountTenancyName(account.id, name, revision)).toBe(false);
    expect(getAccount(account.id)?.nameSource).toBe("pending");
    updateAccount(account.id, replacementKey, USERNAME);
    expect(setAccountTenancyName(account.id, "Stale tenant", revision)).toBe(false);
    const current = getCredentialSnapshot(account.id).revision;
    expect(setAccountTenancyName(account.id, "Verified tenant", current)).toBe(true);
    updateAccount(account.id, { name: "My custom account" }, USERNAME);
    expect(setAccountTenancyName(account.id, "Late cloud result", current)).toBe(false);
    expect(getAccount(account.id)).toMatchObject({
      name: "My custom account",
      nameSource: "custom",
    });
  });

  it("preserves a cloud name committed while an unrelated account edit was waiting for its lock", () => {
    const account = createAccount(input({ name: undefined }), USERNAME);
    const db = getDatabase();
    const transaction = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce((operation) => {
      db.prepare("UPDATE accounts SET name='Verified tenant',name_source='tenancy' WHERE id=?").run(
        account.id,
      );
      return transaction(operation);
    });
    const updated = updateAccount(account.id, { regions: account.regions }, USERNAME);
    expect(updated).toMatchObject({ name: "Verified tenant", nameSource: "tenancy" });
  });

  it("preserves Worker state committed after an account edit starts", () => {
    const account = createAccount(input(), USERNAME);
    const db = getDatabase();
    const peer = new Database(process.env.DATABASE_PATH!);
    const revision = getCredentialSnapshot(account.id).revision;
    const transaction = db.transaction.bind(db);
    const syncedAt = "2026-11-08T12:00:00.000Z";
    try {
      // The editor already read the account, but has not acquired its write lock.
      // Background connection updates do not change the credential revision.
      vi.spyOn(db, "transaction").mockImplementationOnce((operation) => {
        peer
          .prepare("UPDATE accounts SET status=?,last_sync_at=?,last_error=? WHERE id=?")
          .run("error", syncedAt, "Synthetic background failure", account.id);
        return transaction(operation);
      });
      const updated = updateAccount(account.id, { name: "Renamed account" }, USERNAME);
      expect(updated).toMatchObject({
        name: "Renamed account",
        status: "error",
        lastSyncAt: syncedAt,
        lastError: "Synthetic background failure",
      });
      expect(getCredentialSnapshot(account.id).revision).toBe(revision);
      expect(getCredentials(account.id).fingerprint).toBe(firstKey.fingerprint);
    } finally {
      peer.close();
    }
  });

  it("recovers a revoked key through PATCH and lets the live manager clean with the replacement", async () => {
    const account = createAccount(input(), USERNAME);
    const store = createConsoleStore();
    const actor = { userId: "test-owner", username: USERNAME, sessionHash: "test-login" };
    const resolveTarget = (): ConsoleTarget => ({
      instanceId: ocid("instance"),
      instanceName: "Recovery fixture",
      accountId: account.id,
      region: account.homeRegion,
      credentials: getCredentials(account.id),
    });
    let closed!: () => void;
    const transport: ConsoleTransport = {
      start: async (request) => {
        request.onConnectionCreated(ocid("instanceconsoleconnection"));
        request.onCompartmentVerified?.(account.tenancyId);
        return {
          connectionId: ocid("instanceconsoleconnection"),
          connect: async () => new PassThrough(),
          close: async () => closed(),
          closed: new Promise<void>((resolve) => {
            closed = resolve;
          }),
        };
      },
      cleanup: vi.fn(async ({ target }) => {
        if (target.credentials.fingerprint !== replacementKey.fingerprint)
          throw new Error("API key revoked");
      }),
    };
    const manager = createConsoleManager({
      store,
      transport,
      resolveTarget,
      isActorValid: () => true,
    });
    try {
      await manager.initialize();
      const session = await manager.create(ocid("instance"), actor);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.active()?.state).toBe("ready");
      // Normal replacement must not bypass the live session lock.
      expect((await call("PATCH", `accounts/${account.id}`, replacementKey)).status).toBe(409);
      await manager.close(session.id, actor);
      expect(store.active()?.credentialRecoveryReady).toBe(true);
      const response = await call("PATCH", `accounts/${account.id}`, {
        ...replacementKey,
        recoverConsoleCleanup: true,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        consoleCleanupRecovery: true,
        account: { id: account.id },
      });
      expect(getJobStore().listJobs()).toEqual([]);
      expect(store.active()).toMatchObject({
        slot: 1,
        cleanupPending: true,
        credentialRecoveryReady: false,
      });
      await manager.close(session.id, actor);
      expect(transport.cleanup).toHaveBeenLastCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({
            credentials: expect.objectContaining({ fingerprint: replacementKey.fingerprint }),
          }),
        }),
      );
      expect(store.active()).toBeNull();
    } finally {
      await manager.shutdown();
    }
  });

  it.each([
    { tenancyId: ocid("tenancy") + "different" },
    { userId: ocid("user") + "different" },
    { homeRegion: "uk-london-1" },
    { regions: ["ap-singapore-1"] },
  ])("rejects a recovery changing OCI identity or scope: %j", async (change) => {
    const account = createAccount(input(), USERNAME),
      store = failedConsole(account.id);
    const before = storedAccount(account.id);
    const response = await call("PATCH", `accounts/${account.id}`, {
      ...replacementKey,
      ...change,
      recoverConsoleCleanup: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "CONSOLE_RECOVERY_SCOPE_MISMATCH" });
    expect(storedAccount(account.id)).toEqual(before);
    expect(store.active()?.credentialRecoveryReady).toBe(true);
    expect(getJobStore().listJobs()).toEqual([]);
  });

  it("keeps active jobs protected even when a failed console permits recovery", async () => {
    const account = createAccount(input(), USERNAME),
      store = failedConsole(account.id);
    getJobStore().enqueueAccountSync(account.id, USERNAME);
    const before = storedAccount(account.id);
    const response = await call("PATCH", `accounts/${account.id}`, {
      ...replacementKey,
      recoverConsoleCleanup: true,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_BUSY" });
    expect(storedAccount(account.id)).toEqual(before);
    expect(store.active()?.credentialRecoveryReady).toBe(true);
  });

  it("rejects mismatched replacement key material without consuming the recovery permission", async () => {
    const account = createAccount(input(), USERNAME),
      store = failedConsole(account.id);
    const before = storedAccount(account.id);
    const response = await call("PATCH", `accounts/${account.id}`, {
      privateKey: firstKey.privateKey,
      fingerprint: replacementKey.fingerprint,
      recoverConsoleCleanup: true,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "KEY_FINGERPRINT_MISMATCH" });
    expect(storedAccount(account.id)).toEqual(before);
    expect(store.active()?.credentialRecoveryReady).toBe(true);
    expect(getJobStore().listJobs()).toEqual([]);
  });

  it("does not use a different account's cleanup lock to authorize recovery", async () => {
    const account = createAccount(input(), USERNAME);
    const other = createAccount(input({ tenancyId: ocid("tenancy") + "other" }), USERNAME);
    failedConsole(other.id);
    const response = await call("PATCH", `accounts/${account.id}`, {
      ...replacementKey,
      recoverConsoleCleanup: true,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "CONSOLE_RECOVERY_NOT_READY" });
    expect(getCredentials(account.id).fingerprint).toBe(firstKey.fingerprint);
  });

  it("observes another SQLite connection starting cleanup instead of trusting stale recovery state", async () => {
    const account = createAccount(input(), USERNAME),
      store = failedConsole(account.id);
    const peer = new Database(process.env.DATABASE_PATH!);
    try {
      const peerStore = createConsoleStore(peer);
      peerStore.update(store.active()!.id, { state: "closing", credentialRecoveryReady: false });
      const before = storedAccount(account.id);
      const response = await call("PATCH", `accounts/${account.id}`, {
        ...replacementKey,
        recoverConsoleCleanup: true,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CONSOLE_RECOVERY_NOT_READY" });
      expect(storedAccount(account.id)).toEqual(before);
    } finally {
      peer.close();
    }
  });

  it.each(["preparing", "ready", "connected", "closing"] as const)(
    "rejects explicit recovery while the console is %s",
    async (state) => {
      const account = createAccount(input(), USERNAME),
        store = failedConsole(account.id);
      store.update(store.active()!.id, { state });
      const response = await call("PATCH", `accounts/${account.id}`, {
        ...replacementKey,
        recoverConsoleCleanup: true,
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "CONSOLE_RECOVERY_NOT_READY" });
      expect(getCredentials(account.id).fingerprint).toBe(firstKey.fingerprint);
    },
  );

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
