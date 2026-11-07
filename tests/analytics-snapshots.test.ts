import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/lib/contracts";
import type { CostReport } from "@/lib/analytics-contracts";
import { createAnalyticsSnapshots } from "@/server/analytics/snapshots";
import { createAnalyticsService } from "@/server/analytics/service";

const NOW = Date.parse("2026-11-08T00:00:00Z");
const handles: Database.Database[] = [];
const directories: string[] = [];
const base = resolve(".test-tmp");
const report = (expires = NOW + 3_600_000): CostReport => ({
  source: "oci",
  cached: false,
  status: "ok",
  generatedAt: new Date(NOW).toISOString(),
  cacheExpiresAt: new Date(expires).toISOString(),
  accounts: [],
  rows: [],
  warnings: [],
  totals: [{ currency: "USD", amount: "2.50" }],
  points: [],
  range: {
    startDate: "2026-11-01",
    endDate: "2026-11-06",
    startTime: "2026-11-01T00:00:00.000Z",
    endTime: "2026-11-07T00:00:00.000Z",
    granularity: "daily",
    timeZone: "UTC",
  },
});
function fixture() {
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "analytics-snapshots-"));
  directories.push(dir);
  const path = join(dir, "cache.sqlite");
  const open = () => {
    const db = new Database(path);
    handles.push(db);
    return db;
  };
  return { open, db: open() };
}
afterEach(() => {
  handles.splice(0).forEach((db) => {
    if (db.open) db.close();
  });
  for (const dir of directories.splice(0)) {
    if (dirname(resolve(dir)) !== base || !basename(dir).startsWith("analytics-snapshots-"))
      throw new Error("Unsafe snapshot test cleanup path");
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("persisted analytics snapshots", () => {
  it("survives database and service reopening without extending original freshness", () => {
    const f = fixture();
    let time = NOW;
    const first = createAnalyticsSnapshots({ database: () => f.db, now: () => time });
    first.set("report-key", report());
    f.db.close();
    const secondDb = f.open();
    const second = createAnalyticsSnapshots({ database: () => secondDb, now: () => time });
    time += 60_000;
    expect(second.get("report-key")).toEqual(report());
    const changed = second.get("report-key")!;
    changed.warnings.push("client change");
    expect(second.get("report-key")?.warnings).toEqual([]);
    time = NOW + 3_600_000;
    expect(second.get("report-key")).toBeUndefined();
    expect(secondDb.prepare("SELECT count(*) AS n FROM analytics_snapshots").get()).toEqual({
      n: 0,
    });
  });

  it("bounds entries and UTF-8 storage while retaining most recently used reports", () => {
    const { db } = fixture();
    let time = NOW;
    const bytes = Buffer.byteLength(JSON.stringify(report()));
    const cache = createAnalyticsSnapshots({
      database: () => db,
      now: () => time,
      maxEntries: 2,
      maxBytes: bytes * 2,
      maxEntryBytes: bytes,
    });
    cache.set("one", report());
    time++;
    cache.set("two", report());
    time++;
    cache.get("one");
    time++;
    cache.set("three", report());
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("one")).toBeDefined();
    expect(cache.get("three")).toBeDefined();
    const oversized = { ...report(), warnings: ["说明".repeat(100)] };
    cache.set("oversized", oversized);
    expect(cache.get("oversized")).toBeUndefined();
    expect(
      db.prepare("SELECT count(*) AS n,sum(bytes) AS bytes FROM analytics_snapshots").get(),
    ).toEqual({ n: 2, bytes: bytes * 2 });
  });

  it("discards corrupt data and tolerates an unavailable optional cache", () => {
    const { db } = fixture();
    const cache = createAnalyticsSnapshots({ database: () => db, now: () => NOW });
    cache.set("report", report());
    db.prepare("UPDATE analytics_snapshots SET report_json='invalid-json'").run();
    expect(cache.get("report")).toBeUndefined();
    db.close();
    expect(cache.get("report")).toBeUndefined();
    expect(() => cache.set("report", report())).not.toThrow();
  });

  it("reuses a persisted query after restart and still honors manual refresh and credential changes", async () => {
    const f = fixture();
    let time = NOW,
      revision = 0,
      enabled = true;
    let currentDb = f.db;
    const account: AccountSummary = {
      id: "snapshot-account",
      name: "Snapshot account",
      tenancyId: "snapshot-tenancy",
      userId: "snapshot-user",
      fingerprint: "fixture",
      homeRegion: "ap-tokyo-1",
      regions: ["ap-tokyo-1"],
      status: "connected",
      createdAt: new Date(NOW).toISOString(),
      lastSyncAt: null,
      lastError: null,
    };
    const read = vi.fn(async () => ({
      rows: [
        {
          accountId: account.id,
          accountName: account.name,
          tenancyId: account.tenancyId,
          timestamp: "2026-11-01T00:00:00.000Z",
          service: "Compute",
          region: account.homeRegion,
          resourceId: null,
          resourceName: null,
          currency: "USD",
          amount: "2.50",
        },
      ],
      totals: [{ currency: "USD", amount: "2.50" }],
      points: [],
      warnings: [],
      status: "ok" as const,
    }));
    const create = () =>
      createAnalyticsService({
        accounts: () => (enabled ? [account] : []),
        instances: () => [],
        access: () => ({
          revision,
          credentials: {
            tenancyId: account.tenancyId,
            userId: account.userId,
            fingerprint: account.fingerprint,
            region: account.homeRegion,
            privateKey: "NEVER_PERSIST_THIS_CREDENTIAL",
          },
        }),
        isCurrent: (_id, value) => enabled && value === revision,
        demo: () => false,
        now: () => time,
        costs: { read },
        snapshots: createAnalyticsSnapshots({ database: () => currentDb, now: () => time }),
      });
    const query = {
      accountId: account.id,
      startDate: "2026-11-01",
      endDate: "2026-11-06",
      granularity: "daily",
    };
    const initial = await create().costs(query);
    f.db.close();
    currentDb = f.open();
    time += 3000;
    const restarted = create();
    expect(await restarted.costs(query)).toMatchObject({
      cached: true,
      generatedAt: initial.generatedAt,
      totals: [{ currency: "USD", amount: "2.5" }],
    });
    expect(read).toHaveBeenCalledTimes(1);
    await restarted.costs(query, true);
    expect(read).toHaveBeenCalledTimes(2);
    revision++;
    await create().costs(query);
    expect(read).toHaveBeenCalledTimes(3);
    const stored = JSON.stringify(currentDb.prepare("SELECT * FROM analytics_snapshots").all());
    expect(stored).not.toContain("NEVER_PERSIST_THIS_CREDENTIAL");
    enabled = false;
    await expect(create().costs(query)).rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
  });
});
