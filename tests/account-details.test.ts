import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import { createAccountDetailsService } from "@/server/account-details";
import { createAccount, getAccount, updateAccount } from "@/server/accounts";
import { closeDatabase, getDatabase, initializeDatabase } from "@/server/db";
import { login, SESSION_COOKIE } from "@/server/auth";
import { saveInventory } from "@/server/inventory";
import { handleApi } from "@/server/router";
import type { CloudDocument, OciClients } from "@/server/oci/sdk";

const cloud = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("@/server/oci/sdk", async (original) => ({
  ...(await original<typeof import("@/server/oci/sdk")>()),
  sdkClientFactory: cloud.factory,
}));
const origin = "https://account-details.invalid";
let base: string, directory: string, privateKey: string, fingerprint: string, token: string;
let account: AccountSummary;
let calls: string[], close: ReturnType<typeof vi.fn<() => void>>;
let reply: (operation: string, request: CloudDocument) => Promise<CloudDocument>;

function response(operation: string): CloudDocument {
  if (operation === "getTenancy")
    return {
      tenancy: {
        id: account.tenancyId,
        name: "OCI tenant",
        description: "Fixture tenant",
        homeRegionKey: "PHX",
        privateKey: "not-public",
      },
    };
  if (operation === "getUser")
    return {
      user: {
        id: account.userId,
        compartmentId: account.tenancyId,
        name: "OCI user",
        email: "fixture@example.invalid",
        lifecycleState: "ACTIVE",
        timeCreated: new Date("2026-01-01T00:00:00Z"),
        isMfaActivated: true,
        capabilities: { secret: "not-public" },
      },
    };
  return {
    items: [
      { regionName: "us-phoenix-1", regionKey: "PHX", status: "READY", isHomeRegion: true },
      { regionName: "uk-london-1", regionKey: "LHR", status: "IN_PROGRESS", isHomeRegion: false },
    ],
  };
}
function clients(): OciClients {
  const client = {
    call: async (operation: string, request: CloudDocument) => {
      calls.push(operation);
      return reply(operation, request);
    },
    close,
  };
  return {
    identity: client,
    compute: client,
    network: client,
    storage: client,
    monitoring: client,
  };
}
function deferred<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function instance(owner: AccountSummary, suffix: string, region = "us-phoenix-1"): InstanceSummary {
  return {
    id: `ocid1.instance.oc1..${suffix}`,
    accountId: owner.id,
    accountName: owner.name,
    displayName: suffix,
    region,
    compartmentId: owner.tenancyId,
    availabilityDomain: "AD",
    state: "RUNNING",
    shape: "VM.Standard.A1.Flex",
    ocpus: 2,
    memoryGb: 12,
    os: "Linux",
    createdAt: "2026-01-01T00:00:00Z",
    syncedAt: "2026-11-09T00:00:00Z",
    tags: {},
    vnics: [
      {
        id: `ocid1.vnic.oc1..${suffix}`,
        name: suffix,
        primary: true,
        subnetId: "subnet",
        nsgIds: [],
        ipv6: [],
        privateIps: [
          {
            privateIpId: "private",
            privateIp: "10.0.0.2",
            isPrimary: true,
            vnicId: `ocid1.vnic.oc1..${suffix}`,
            publicIp: "192.0.2.1",
            protected: true,
          },
        ],
      },
    ],
    bootVolumes: [
      {
        id: `ocid1.bootvolume.oc1..${suffix}`,
        accountId: owner.id,
        region,
        name: suffix,
        state: "AVAILABLE",
        sizeGb: 50,
        vpusPerGb: 10,
      },
    ],
  };
}
beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  privateKey = pair.privateKey;
  fingerprint = createHash("md5").update(pair.publicKey).digest("hex").match(/.{2}/g)!.join(":");
});
beforeEach(async () => {
  closeDatabase();
  base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "account-details-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.db"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", "details-test");
  vi.stubEnv("ADMIN_PASSWORD", "details-test-password");
  vi.stubEnv("APP_ORIGIN", origin);
  await initializeDatabase();
  token = (await login("details-test", "details-test-password")).token;
  account = createAccount(
    {
      name: "Fixture account",
      tenancyId: "ocid1.tenancy.oc1..details",
      userId: "ocid1.user.oc1..details",
      fingerprint,
      privateKey,
      homeRegion: "us-phoenix-1",
      regions: ["us-phoenix-1"],
    },
    "test",
  );
  saveInventory(account.id, {
    instances: [instance(account, "owned")],
    warnings: [],
    regions: ["us-phoenix-1"],
  });
  calls = [];
  close = vi.fn<() => void>();
  reply = async (operation) => response(operation);
  cloud.factory.mockReset().mockImplementation(clients);
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  if (dirname(directory) !== base || !basename(directory).startsWith("account-details-"))
    throw new Error("Unsafe account details test cleanup");
  rmSync(directory, { recursive: true, force: true });
});

describe("read-only account details", () => {
  it("returns only safe OCI fields with owned configured-region inventory and fresh reads", async () => {
    const foreign = createAccount(
      {
        name: "Other",
        tenancyId: "ocid1.tenancy.oc1..other",
        userId: "ocid1.user.oc1..other",
        fingerprint,
        privateKey,
        homeRegion: "us-phoenix-1",
        regions: ["us-phoenix-1"],
      },
      "test",
    );
    saveInventory(foreign.id, {
      instances: [instance(foreign, "foreign")],
      warnings: [],
      regions: ["us-phoenix-1"],
    });
    const disabled = instance(account, "legacy-disabled", "uk-london-1");
    getDatabase()
      .prepare("INSERT INTO resources(id,account_id,region,data,synced_at) VALUES(?,?,?,?,?)")
      .run(disabled.id, account.id, disabled.region, JSON.stringify(disabled), disabled.syncedAt);
    const service = createAccountDetailsService();
    const result = await service.query(account.id);
    expect(result.inventory).toMatchObject({
      instances: 1,
      running: 1,
      stopped: 0,
      ocpus: 2,
      memoryGb: 12,
      bootVolumeGb: 50,
      publicIps: 1,
      partial: false,
    });
    expect(result.cloud.tenancy?.name).toBe("OCI tenant");
    expect(result.cloud.user).toMatchObject({
      email: "fixture@example.invalid",
      state: "ACTIVE",
      mfaActivated: true,
    });
    expect(result.cloud.regions?.[1]).toEqual({
      name: "uk-london-1",
      key: "LHR",
      status: "IN_PROGRESS",
      home: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("privateKey");
    expect(serialized).not.toContain("credential");
    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain("not-public");
    expect(close).toHaveBeenCalledTimes(1);
    await service.query(account.id);
    expect(cloud.factory).toHaveBeenCalledTimes(2);
    expect(calls.filter((operation) => operation === "getTenancy")).toHaveLength(2);
  });
  it("distinguishes unknown resource sizes and missing boot-volume snapshots from an empty inventory", async () => {
    const unknown = instance(account, "unknown");
    unknown.ocpus = 0;
    unknown.memoryGb = Number.NaN;
    unknown.bootVolumes = [];
    saveInventory(account.id, { instances: [unknown], warnings: [], regions: ["us-phoenix-1"] });
    const service = createAccountDetailsService();
    expect((await service.query(account.id)).inventory).toMatchObject({
      instances: 1,
      ocpus: null,
      memoryGb: null,
      bootVolumeGb: null,
      partial: true,
    });
    const known = instance(account, "unknown");
    known.bootVolumes[0].sizeGb = 0;
    saveInventory(account.id, { instances: [known], warnings: [], regions: ["us-phoenix-1"] });
    expect((await service.query(account.id)).inventory).toMatchObject({
      ocpus: 2,
      memoryGb: 12,
      bootVolumeGb: null,
      partial: true,
    });
    saveInventory(account.id, { instances: [], warnings: [], regions: ["us-phoenix-1"] });
    expect((await service.query(account.id)).inventory).toMatchObject({
      instances: 0,
      ocpus: 0,
      memoryGb: 0,
      bootVolumeGb: 0,
      partial: false,
    });
  });
  it("keeps successful sections and local information when one permission is denied", async () => {
    reply = async (operation) => {
      if (operation === "getUser")
        throw Object.assign(new Error(`password=${privateKey}`), {
          statusCode: 403,
          serviceCode: "NotAuthorized",
        });
      return response(operation);
    };
    const before = getAccount(account.id);
    const result = await createAccountDetailsService().query(account.id);
    expect(result.cloud.user).toBeNull();
    expect(result.cloud.tenancy).not.toBeNull();
    expect(result.cloud.regions).toHaveLength(2);
    expect(result.cloud.errors).toEqual([
      { section: "user", message: "OCI 请求失败（NotAuthorized / HTTP 403）" },
    ]);
    expect(result.inventory.instances).toBe(1);
    expect(getAccount(account.id)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });
  it("rejects mismatched cloud identities without disclosing another user or tenancy", async () => {
    reply = async (operation) =>
      operation === "getUser"
        ? {
            user: {
              id: account.userId,
              compartmentId: "ocid1.tenancy.oc1..foreign",
              name: "foreign-user",
            },
          }
        : operation === "getTenancy"
          ? { tenancy: { id: "ocid1.tenancy.oc1..foreign", name: "foreign-tenancy" } }
          : response(operation);
    const result = await createAccountDetailsService().query(account.id);
    expect(result.cloud.tenancy).toBeNull();
    expect(result.cloud.user).toBeNull();
    expect(result.cloud.errors.map((error) => error.section)).toEqual(["tenancy", "user"]);
    expect(JSON.stringify(result)).not.toContain("foreign-user");
    expect(JSON.stringify(result)).not.toContain("foreign-tenancy");
  });
  it("returns partial sections by the deadline while keeping clients open until real calls settle", async () => {
    const gate = deferred<CloudDocument>();
    reply = async (operation) => (operation === "getUser" ? gate.promise : response(operation));
    try {
      const result = await createAccountDetailsService({ timeoutMs: 30 }).query(account.id);
      expect(result.cloud.tenancy).not.toBeNull();
      expect(result.cloud.regions).toHaveLength(2);
      expect(result.cloud.user).toBeNull();
      expect(result.cloud.errors).toEqual([
        { section: "user", message: "OCI 信息读取超时，请重试" },
      ]);
      expect(close).not.toHaveBeenCalled();
      gate.release(response("getUser"));
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
      expect(result.cloud.user).toBeNull();
    } finally {
      gate.release(response("getUser"));
    }
  });
  it("rejects results when account configuration changes during the read", async () => {
    const gate = deferred<CloudDocument>();
    reply = async (operation) => (operation === "getUser" ? gate.promise : response(operation));
    const pending = createAccountDetailsService().query(account.id);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    updateAccount(account.id, { regions: ["us-phoenix-1", "uk-london-1"] }, "test");
    gate.release(response("getUser"));
    await expect(pending).rejects.toMatchObject({ code: "ACCOUNT_CHANGED", status: 409 });
  });
  it("holds all three RPC slots after cancellation until the dispatched calls actually settle", async () => {
    const gate = deferred<void>();
    let active = 0,
      peak = 0;
    reply = async (operation) => {
      const wait = calls.length <= 3;
      active++;
      peak = Math.max(peak, active);
      try {
        if (wait) await gate.promise;
        return response(operation);
      } finally {
        active--;
      }
    };
    const service = createAccountDetailsService();
    const caller = new AbortController();
    const first = service.query(account.id, caller.signal);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const second = service.query(account.id);
    await vi.waitFor(() => expect(cloud.factory).toHaveBeenCalledTimes(2));
    caller.abort();
    await expect(first).rejects.toMatchObject({ code: "ACCOUNT_DETAILS_CANCELLED" });
    expect(calls).toHaveLength(3);
    expect(close).not.toHaveBeenCalled();
    gate.release();
    const result = await second;
    expect(result.cloud.errors).toEqual([]);
    expect(peak).toBe(3);
    expect(calls).toHaveLength(6);
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(2));
  });
  it("requires login, returns missing-account errors and forwards HTTP cancellation", async () => {
    const path = `accounts/${account.id}/details`;
    const request = (authenticated: boolean, signal?: AbortSignal) =>
      new Request(`${origin}/api/${path}`, {
        signal,
        headers: authenticated ? { cookie: `${SESSION_COOKIE}=${token}` } : {},
      });
    expect((await handleApi(request(false), path.split("/"))).status).toBe(401);
    expect(cloud.factory).not.toHaveBeenCalled();
    const missingPath = "accounts/missing/details";
    expect(
      (
        await handleApi(
          new Request(`${origin}/api/${missingPath}`, {
            headers: { cookie: `${SESSION_COOKIE}=${token}` },
          }),
          missingPath.split("/"),
        )
      ).status,
    ).toBe(404);
    expect(cloud.factory).not.toHaveBeenCalled();
    const gate = deferred<CloudDocument>();
    reply = async () => gate.promise;
    const caller = new AbortController();
    const pending = handleApi(request(true, caller.signal), path.split("/"));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    const signal = cloud.factory.mock.calls[0][2] as AbortSignal;
    caller.abort();
    expect((await pending).status).toBe(499);
    expect(signal.aborted).toBe(true);
    expect(close).not.toHaveBeenCalled();
    gate.release({});
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
  });
});
