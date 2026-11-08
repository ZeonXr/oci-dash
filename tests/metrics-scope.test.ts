import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, InstanceSummary, MetricsResult } from "@/lib/contracts";
import { closeDatabase, getDatabase } from "@/server/db";
import { createAccount, deleteAccount, updateAccount } from "@/server/accounts";
import { login, SESSION_COOKIE } from "@/server/auth";
import { saveInventory } from "@/server/inventory";
import { handleApi } from "@/server/router";

const cloud = vi.hoisted(() => ({ metrics: vi.fn() }));
vi.mock("@/server/oci/adapter", () => ({ ociAdapter: cloud }));
const origin = "https://metrics-scope.invalid";
let directory: string, base: string, token: string;
let privateKey: string, fingerprint: string;
let account: AccountSummary, instance: InstanceSummary;
const result = (cpu: number): MetricsResult => ({
  intervalSeconds: 60,
  points: [{ timestamp: "2026-11-08T01:00:00Z", cpu, receivedBytes: 1, sentBytes: 2 }],
  available: true,
  source: "oci",
});
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  privateKey = pair.privateKey;
  fingerprint = createHash("md5").update(pair.publicKey).digest("hex").match(/.{2}/g)!.join(":");
});
beforeEach(() => {
  closeDatabase();
  base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "metrics-scope-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.db"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 5).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", "metrics-test");
  vi.stubEnv("ADMIN_PASSWORD", "metrics-test-password");
  vi.stubEnv("APP_ORIGIN", origin);
  getDatabase();
  token = login("metrics-test", "metrics-test-password").token;
  account = createAccount(
    {
      name: "fixture",
      tenancyId: "ocid1.tenancy.oc1..fixture",
      userId: "ocid1.user.oc1..fixture",
      fingerprint,
      privateKey,
      homeRegion: "ap-tokyo-1",
      regions: ["ap-tokyo-1", "uk-london-1"],
    },
    "test",
  );
  instance = {
    id: `ocid1.instance.oc1..${account.id}`,
    displayName: "fixture",
    accountId: account.id,
    accountName: account.name,
    region: "uk-london-1",
    compartmentId: account.tenancyId,
    availabilityDomain: "AD",
    state: "RUNNING",
    shape: "shape",
    ocpus: 1,
    memoryGb: 1,
    os: "Linux",
    createdAt: "2026-01-01T00:00:00Z",
    syncedAt: "2026-11-08T00:00:00Z",
    bootVolumes: [],
    tags: {},
    vnics: [
      {
        id: "ocid1.vnic.oc1..one",
        name: "one",
        primary: true,
        subnetId: "subnet",
        nsgIds: [],
        privateIps: [],
        ipv6: [],
      },
    ],
  };
  persist();
  cloud.metrics.mockReset().mockResolvedValue(result(10));
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  if (dirname(directory) !== base || !basename(directory).startsWith("metrics-scope-"))
    throw new Error("Unsafe metrics test cleanup target");
  rmSync(directory, { recursive: true, force: true });
});
function persist() {
  saveInventory(account.id, { instances: [instance], warnings: [], regions: ["uk-london-1"] });
}
function read(signal?: AbortSignal) {
  const path = `instances/${instance.id}/metrics`;
  return handleApi(
    new Request(`${origin}/api/${path}`, {
      signal,
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    path.split("/"),
  );
}
async function delayed(signal?: AbortSignal) {
  let release!: (value: MetricsResult) => void;
  cloud.metrics.mockReturnValueOnce(
    new Promise<MetricsResult>((resolve) => {
      release = resolve;
    }),
  );
  const response = read(signal);
  await vi.waitFor(() => expect(cloud.metrics).toHaveBeenCalledTimes(1));
  return { response, release };
}

describe("single-instance metrics credential and inventory scope", () => {
  it("forwards HTTP cancellation to the sole underlying metrics subscriber", async () => {
    const caller = new AbortController();
    const pending = await delayed(caller.signal);
    const signal = cloud.metrics.mock.calls[0][3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    caller.abort();
    const response = await pending.response;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "METRICS_CANCELLED" });
    expect(signal.aborted).toBe(true);
    pending.release(result(99));
    cloud.metrics.mockResolvedValue(result(12));
    expect((await (await read()).json()).points[0].cpu).toBe(12);
    expect(cloud.metrics).toHaveBeenCalledTimes(2);
  });
  it("checks enabled region before serving a cache hit", async () => {
    expect((await read()).status).toBe(200);
    updateAccount(account.id, { regions: ["ap-tokyo-1"] }, "test");
    // New updates purge disabled-region rows. Keep this explicit legacy/corrupt
    // inventory fixture to verify that a cache hit still enforces current scope.
    getDatabase()
      .prepare("INSERT INTO resources(id,account_id,region,data,synced_at) VALUES(?,?,?,?,?)")
      .run(instance.id, account.id, instance.region, JSON.stringify(instance), instance.syncedAt);
    const response = await read();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "REGION_NOT_ENABLED" });
    expect(cloud.metrics).toHaveBeenCalledTimes(1);
  });
  it("does not reuse metrics collected with an earlier credential revision", async () => {
    expect((await read()).status).toBe(200);
    updateAccount(account.id, { privateKey }, "test");
    persist();
    cloud.metrics.mockResolvedValue(result(22));
    const response = await read();
    expect((await response.json()).points[0].cpu).toBe(22);
    expect(cloud.metrics).toHaveBeenCalledTimes(2);
  });
  it("does not reuse network metrics after the inventory's VNIC scope changes", async () => {
    await read();
    instance.vnics[0].id = "ocid1.vnic.oc1..two";
    persist();
    await read();
    expect(cloud.metrics).toHaveBeenCalledTimes(2);
  });
  it("rejects a result if the region is disabled while the SDK call is pending", async () => {
    const pending = await delayed();
    updateAccount(account.id, { regions: ["ap-tokyo-1"] }, "test");
    pending.release(result(10));
    const response = await pending.response;
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "REGION_NOT_ENABLED" });
  });
  it("rejects an asynchronous result after credentials are rotated", async () => {
    const pending = await delayed();
    updateAccount(account.id, { privateKey }, "test");
    persist();
    pending.release(result(10));
    const response = await pending.response;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_CHANGED" });
  });
  it("rejects an asynchronous result after the resource scope changes", async () => {
    const pending = await delayed();
    instance.vnics[0].id = "ocid1.vnic.oc1..two";
    persist();
    pending.release(result(10));
    const response = await pending.response;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "RESOURCE_CHANGED" });
  });
  it("does not return a result for an account removed while the SDK call is pending", async () => {
    const pending = await delayed();
    deleteAccount(account.id, "test");
    pending.release(result(10));
    expect((await pending.response).status).toBe(404);
  });
});
