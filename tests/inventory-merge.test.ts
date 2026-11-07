import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { InstanceSummary, InventoryDetailCoverage, InventoryResult } from "@/lib/contracts";
import { closeDatabase, getDatabase } from "@/server/db";
import { getInstance, listInstances, saveInventory } from "@/server/inventory";

const region = "ap-tokyo-1";
const compartment = "ocid1.compartment.oc1..inventory";
const timestamp = "2026-11-07T00:00:00.000Z";
let directory: string;
let base: string;

beforeEach(() => {
  closeDatabase();
  base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "oci-dash-inventory-merge-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "inventory.sqlite"));
  vi.stubEnv("ADMIN_PASSWORD", "");
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 5).toString("base64"));
  const insert = getDatabase().prepare(
    "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  for (const id of ["a", "b"])
    insert.run(
      id,
      "Account " + id,
      "ocid1.tenancy.oc1..legacyduplicate",
      "test",
      "test",
      region,
      JSON.stringify([region, "uk-london-1"]),
      "unused-test-credential",
      "connected",
      timestamp,
    );
});

afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  const target = resolve(directory);
  if (dirname(target) !== base || !basename(target).startsWith("oci-dash-inventory-merge-"))
    throw Error("Unsafe inventory test cleanup");
  rmSync(target, { recursive: true, force: true });
});

function instance(id = "one", patch: Partial<InstanceSummary> = {}): InstanceSummary {
  return {
    id: "ocid1.instance.oc1.." + id,
    accountId: "a",
    accountName: "Account a",
    displayName: id,
    region,
    compartmentId: compartment,
    availabilityDomain: "TEST:AD-1",
    state: "RUNNING",
    shape: "test",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu 24.04",
    createdAt: timestamp,
    vnics: [
      {
        id: "vnic-one",
        name: "NIC",
        primary: true,
        subnetId: "subnet",
        nsgIds: ["nsg"],
        ipv6: ["2001:db8::1"],
        privateIps: [
          {
            privateIpId: "private-one",
            privateIp: "10.0.0.1",
            isPrimary: true,
            vnicId: "vnic-one",
            publicIpId: "public-fixed",
            publicIp: "192.0.2.1",
            lifetime: "RESERVED",
            protected: true,
          },
        ],
      },
    ],
    bootVolumes: [
      {
        id: "boot-one",
        accountId: "a",
        region,
        name: "Boot",
        state: "AVAILABLE",
        sizeGb: 50,
        vpusPerGb: 10,
      },
    ],
    tags: {},
    syncedAt: timestamp,
    ...patch,
  };
}
function complete(row: InstanceSummary): InventoryDetailCoverage {
  return {
    vnics: true,
    bootVolumes: true,
    os: true,
    vnicDetails: Object.fromEntries(
      row.vnics.map((vnic) => [
        vnic.id,
        {
          privateIps: true,
          ipv6: true,
          publicBindings: vnic.privateIps.map((ip) => ip.privateIpId),
        },
      ]),
    ),
  };
}
function result(rows: InstanceSummary[], patch: Partial<InventoryResult> = {}): InventoryResult {
  return {
    instances: rows,
    warnings: [],
    regions: [region],
    completedScopes: [{ region, compartmentId: compartment }],
    details: Object.fromEntries(rows.map((row) => [row.id, complete(row)])),
    ...patch,
  };
}

describe("inventory detail coverage and scoped reconciliation", () => {
  it("retains failed VNIC, disk and OS details while updating base state and marking old fields", () => {
    const old = instance();
    saveInventory("a", result([old]));
    const fresh = instance("one", {
      state: "STOPPED",
      vnics: [],
      bootVolumes: [],
      os: "未知",
      syncedAt: "2026-11-08T00:00:00.000Z",
    });
    saveInventory(
      "a",
      result([fresh], {
        warnings: ["detail reads failed"],
        details: { [fresh.id]: { vnics: false, bootVolumes: false, os: false, vnicDetails: {} } },
      }),
    );
    const retained = getInstance(old.id);
    expect(retained).toMatchObject({
      state: "STOPPED",
      syncedAt: fresh.syncedAt,
      os: old.os,
      vnics: old.vnics,
      bootVolumes: old.bootVolumes,
    });
    expect(retained.staleFields).toEqual(["网卡", "启动卷", "系统镜像"]);
    saveInventory("a", result([fresh]));
    expect(getInstance(old.id)).toMatchObject({ vnics: [], bootVolumes: [], os: "未知" });
    expect(getInstance(old.id).staleFields).toBeUndefined();
  });

  it("merges successful nested reads without losing a failed public binding or IPv6 list", () => {
    const old = instance();
    saveInventory("a", result([old]));
    const fresh = instance();
    fresh.vnics[0].name = "Renamed NIC";
    fresh.vnics[0].ipv6 = [];
    fresh.vnics[0].privateIps = [
      {
        privateIpId: "private-one",
        privateIp: "10.0.0.9",
        isPrimary: true,
        vnicId: "vnic-one",
        protected: true,
      },
    ];
    const reads = complete(fresh);
    reads.vnicDetails["vnic-one"] = { privateIps: true, ipv6: false, publicBindings: [] };
    saveInventory(
      "a",
      result([fresh], {
        warnings: ["public binding and IPv6 unavailable"],
        details: { [fresh.id]: reads },
      }),
    );
    expect(getInstance(old.id).vnics[0]).toMatchObject({
      name: "Renamed NIC",
      ipv6: ["2001:db8::1"],
      privateIps: [
        {
          privateIp: "10.0.0.9",
          publicIp: "192.0.2.1",
          publicIpId: "public-fixed",
          lifetime: "RESERVED",
          protected: true,
        },
      ],
    });
    expect(getInstance(old.id).staleFields).toEqual(["公网 IP", "IPv6"]);
    reads.vnicDetails["vnic-one"] = { privateIps: false, ipv6: true, publicBindings: [] };
    fresh.vnics[0].privateIps = [];
    saveInventory(
      "a",
      result([fresh], { warnings: ["private list unavailable"], details: { [fresh.id]: reads } }),
    );
    expect(getInstance(old.id).vnics[0].privateIps[0].publicIp).toBe("192.0.2.1");
    expect(getInstance(old.id).vnics[0].ipv6).toEqual([]);
    expect(getInstance(old.id).staleFields).toEqual(["私网 IP"]);
    saveInventory("a", result([fresh]));
    expect(getInstance(old.id).vnics[0].privateIps).toEqual([]);
    expect(getInstance(old.id).staleFields).toBeUndefined();
  });

  it("clears a previously bound public IP when its successful read confirms no binding", () => {
    const old = instance();
    saveInventory("a", result([old]));
    const fresh = instance();
    fresh.vnics[0].privateIps = [
      {
        privateIpId: "private-one",
        privateIp: "10.0.0.1",
        isPrimary: true,
        vnicId: "vnic-one",
        protected: true,
      },
    ];
    saveInventory("a", result([fresh]));
    expect(getInstance(old.id).vnics[0].privateIps[0]).not.toHaveProperty("publicIp");
    expect(getInstance(old.id).staleFields).toBeUndefined();
  });

  it("prunes disappeared instances only in enumerated compartments despite detail warnings", () => {
    const current = instance("current");
    const removed = instance("removed");
    const failedCompartment = instance("unread", {
      compartmentId: "ocid1.compartment.oc1..unread",
    });
    const failedRegion = instance("london", { region: "uk-london-1" });
    saveInventory("a", result([current, removed, failedCompartment, failedRegion]));
    const fresh = { ...current, bootVolumes: [] };
    saveInventory(
      "a",
      result([fresh], {
        warnings: ["other compartment and boot read failed"],
        details: { [fresh.id]: { ...complete(fresh), bootVolumes: false } },
      }),
    );
    expect(
      listInstances()
        .map((row) => row.id)
        .sort(),
    ).toEqual([current.id, failedCompartment.id, failedRegion.id].sort());
    expect(getInstance(current.id).bootVolumes).toEqual(current.bootVolumes);
    expect(getInstance(failedCompartment.id).syncedAt).toBe(timestamp);
    saveInventory("a", result([], { warnings: ["another region failed"] }));
    expect(
      listInstances()
        .map((row) => row.id)
        .sort(),
    ).toEqual([failedCompartment.id, failedRegion.id].sort());
  });

  it("a successful empty compartment removes its old rows without erasing unqueried scopes", () => {
    const removed = instance();
    const unqueried = instance("unqueried", { compartmentId: "other-compartment" });
    saveInventory("a", result([removed, unqueried]));
    saveInventory("a", result([], { warnings: ["other compartment unread"] }));
    expect(listInstances().map((row) => row.id)).toEqual([unqueried.id]);
  });
});

describe("canonical resource ownership", () => {
  it("returns SQL identity and account ownership even when legacy JSON points elsewhere", () => {
    const row = instance();
    saveInventory("a", result([row]));
    const corrupt = {
      ...row,
      id: "wrong-id",
      accountId: "b",
      accountName: "wrong name",
      region: "wrong-region",
      bootVolumes: row.bootVolumes.map((volume) => ({
        ...volume,
        accountId: "b",
        region: "wrong-region",
      })),
    };
    getDatabase()
      .prepare("UPDATE resources SET data=? WHERE id=?")
      .run(JSON.stringify(corrupt), row.id);
    for (const actual of [getInstance(row.id), listInstances()[0]]) {
      expect(actual).toMatchObject({
        id: row.id,
        accountId: "a",
        accountName: "Account a",
        region,
      });
      expect(actual.bootVolumes[0]).toMatchObject({ accountId: "a", region });
    }
  });

  it("rejects a legacy duplicate account's conflicting snapshot atomically", () => {
    const ownedA = instance();
    const ownedB = instance("b-only", { accountId: "b" });
    saveInventory("a", result([ownedA]));
    saveInventory("b", result([ownedB]));
    const before = getDatabase().prepare("SELECT * FROM resources ORDER BY id").all();
    expect(() =>
      saveInventory("b", result([{ ...ownedA, accountId: "b", displayName: "overwrite" }])),
    ).toThrow(expect.objectContaining({ status: 409, code: "RESOURCE_ACCOUNT_CONFLICT" }));
    expect(getDatabase().prepare("SELECT * FROM resources ORDER BY id").all()).toEqual(before);
    expect(getInstance(ownedA.id).accountId).toBe("a");
    expect(getInstance(ownedB.id).accountId).toBe("b");
    expect(
      (getDatabase().prepare("SELECT count(*) AS n FROM accounts").get() as { n: number }).n,
    ).toBe(2);
  });
});
