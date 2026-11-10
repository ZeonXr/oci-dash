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

  it("marks a missing compartment's retained inventory without making fresh rows or other accounts stale", () => {
    const root = "ocid1.tenancy.oc1..legacyduplicate";
    const retained = instance("missing-compartment");
    const current = instance("root-current", { compartmentId: root });
    const other = instance("other-account", { accountId: "b", accountName: "Account b" });
    saveInventory(
      "a",
      result([retained, current], {
        completedScopes: [
          { region, compartmentId: compartment },
          { region, compartmentId: root },
        ],
      }),
    );
    saveInventory("b", result([other]));
    const otherRows = getDatabase().prepare("SELECT * FROM resources WHERE account_id=?").all("b");
    const otherAccount = getDatabase().prepare("SELECT * FROM accounts WHERE id=?").get("b");
    const fresh = instance("root-current", {
      compartmentId: root,
      state: "STOPPED",
      os: "Oracle Linux",
      vnics: [],
      bootVolumes: [],
      syncedAt: "2026-11-08T12:00:00.000Z",
    });
    const snapshot = result([fresh], { completedScopes: [{ region, compartmentId: root }] });
    expect(snapshot.warnings).toEqual([]);
    saveInventory("a", snapshot);

    expect(getInstance(retained.id)).toMatchObject(retained);
    expect(getInstance(retained.id).staleFields).toEqual(
      expect.arrayContaining(["实例状态", "网卡", "启动卷", "系统镜像"]),
    );
    expect(getInstance(fresh.id)).toMatchObject(fresh);
    expect(getInstance(fresh.id).staleFields).toBeUndefined();
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toMatch(/未.*(?:覆盖|更新|读取|确认)/u);
    expect(
      getDatabase().prepare("SELECT status,last_error FROM accounts WHERE id=?").get("a"),
    ).toEqual({ status: "error", last_error: expect.stringContaining(snapshot.warnings[0]) });
    expect(getDatabase().prepare("SELECT * FROM resources WHERE account_id=?").all("b")).toEqual(
      otherRows,
    );
    expect(getDatabase().prepare("SELECT * FROM accounts WHERE id=?").get("b")).toEqual(
      otherAccount,
    );
  });

  it("marks an unqueried region while retaining old values and existing detail warnings", () => {
    const london = "uk-london-1";
    const current = instance("tokyo-current");
    const old = instance("london-retained", { region: london });
    old.bootVolumes = old.bootVolumes.map((volume) => ({ ...volume, region: london }));
    const coverage = complete(old);
    coverage.vnicDetails[old.vnics[0].id].ipv6 = false;
    saveInventory(
      "a",
      result([current, old], {
        regions: [region, london],
        completedScopes: [
          { region, compartmentId: compartment },
          { region: london, compartmentId: compartment },
        ],
        warnings: ["IPv6 read failed"],
        details: { [current.id]: complete(current), [old.id]: coverage },
      }),
    );
    expect(getInstance(old.id).staleFields).toContain("IPv6");
    for (let sync = 0; sync < 2; sync++) {
      const snapshot = result([current]);
      saveInventory("a", snapshot);
      const actual = getInstance(old.id);
      expect(actual).toMatchObject(old);
      expect(actual.staleFields).toEqual(expect.arrayContaining(["实例状态", "网卡", "IPv6"]));
      expect(actual.staleFields!.length).toBe(new Set(actual.staleFields).size);
      expect(snapshot.warnings).toHaveLength(1);
    }
  });

  it("clears lost-scope warnings after recovery and prunes only a confirmed empty scope", () => {
    const old = instance("recoverable");
    const missing = () =>
      result([], {
        completedScopes: [{ region, compartmentId: "ocid1.tenancy.oc1..legacyduplicate" }],
      });
    saveInventory("a", result([old]));
    saveInventory("a", missing());
    expect(getInstance(old.id).staleFields).toContain("实例状态");

    const fresh = instance("recoverable", {
      state: "STOPPED",
      syncedAt: "2026-11-08T12:00:00.000Z",
    });
    const recovered = result([fresh]);
    saveInventory("a", recovered);
    expect(getInstance(fresh.id)).toMatchObject(fresh);
    expect(getInstance(fresh.id).staleFields).toBeUndefined();
    expect(recovered.warnings).toEqual([]);
    expect(
      getDatabase().prepare("SELECT status,last_error FROM accounts WHERE id=?").get("a"),
    ).toEqual({ status: "connected", last_error: null });

    saveInventory("a", missing());
    expect(getInstance(old.id).syncedAt).toBe(fresh.syncedAt);
    const empty = result([]);
    saveInventory("a", empty);
    expect(listInstances()).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(
      getDatabase().prepare("SELECT status,last_error FROM accounts WHERE id=?").get("a"),
    ).toEqual({ status: "connected", last_error: null });
  });
});

describe("inventory transaction boundaries", () => {
  it("rolls ORM inventory writes and coverage warnings back when the account update fails", () => {
    const current = instance("current");
    const unqueried = instance("unqueried", { compartmentId: "other-compartment" });
    saveInventory("a", result([current, unqueried]));
    const db = getDatabase();
    const beforeResources = db.prepare("SELECT * FROM resources ORDER BY id").all();
    const beforeAccount = db.prepare("SELECT * FROM accounts WHERE id='a'").get();
    db.exec(`CREATE TRIGGER reject_inventory_update BEFORE UPDATE OF last_sync_at ON accounts
      WHEN NEW.id='a' BEGIN SELECT RAISE(ABORT, 'Synthetic inventory failure'); END`);
    const snapshot = result([instance("replacement")]);
    expect(() => saveInventory("a", snapshot)).toThrow();
    expect(db.prepare("SELECT * FROM resources ORDER BY id").all()).toEqual(beforeResources);
    expect(db.prepare("SELECT * FROM accounts WHERE id='a'").get()).toEqual(beforeAccount);
    expect(snapshot.warnings).toEqual([]);
    db.exec("DROP TRIGGER reject_inventory_update");
    saveInventory("a", snapshot);
    expect(getInstance("ocid1.instance.oc1..replacement").displayName).toBe("replacement");
    expect(snapshot.warnings).toHaveLength(1);
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
