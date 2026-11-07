import { describe, expect, it, vi } from "vitest";
import type { AnalyticsRange } from "@/lib/analytics-contracts";

const cloudImport = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Demonstration reports must not load an OCI SDK client.");
  }),
);
vi.mock("oci-common", () => {
  cloudImport();
  return {};
});
vi.mock("oci-core", () => {
  cloudImport();
  return {};
});
vi.mock("oci-monitoring", () => {
  cloudImport();
  return {};
});
vi.mock("oci-usageapi", () => {
  cloudImport();
  return {};
});

import { demoCostReport, demoTrafficReport } from "@/server/analytics/demo";
import { demoAccounts, demoInstances } from "@/server/demo";

const now = Date.parse("2026-11-07T12:30:00.000Z");
const range: AnalyticsRange = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  startTime: "2026-10-01T00:00:00.000Z",
  endTime: "2026-10-03T00:00:00.000Z",
  granularity: "daily",
  timeZone: "UTC",
};

describe("local analytics demonstrations", () => {
  it("honors traffic scope, retains consistent hour/day totals and produces explicit empty/demo states", () => {
    const instance = demoInstances()[1];
    const query = {
      range,
      accountId: instance.accountId,
      region: instance.region,
      instanceId: instance.id,
      vnicId: instance.vnics[0].id,
    };
    const report = demoTrafficReport(query, now);
    expect(report).toEqual(demoTrafficReport(query, now));
    expect(report).toMatchObject({
      source: "demo",
      cached: false,
      status: "ok",
      generatedAt: new Date(now).toISOString(),
      dataThrough: range.endTime,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]).toMatchObject({
      accountId: instance.accountId,
      instanceId: instance.id,
      vnicId: instance.vnics[0].id,
      region: instance.region,
      coverage: "complete",
    });
    expect(report.totals.totalBytes).toBeGreaterThan(0);
    expect(report.accounts.map((account) => account.accountId)).toEqual([instance.accountId]);
    const hourly = demoTrafficReport({ ...query, range: { ...range, granularity: "hourly" } }, now);
    expect(hourly.points).toHaveLength(48);
    expect(report.points).toHaveLength(2);
    expect(hourly.totals).toEqual(report.totals);
    expect(demoTrafficReport({ ...query, vnicId: "missing-vnic" }, now)).toMatchObject({
      source: "demo",
      status: "empty",
      rows: [],
      points: [],
      totals: { totalBytes: null },
    });
    expect(cloudImport).not.toHaveBeenCalled();
  });

  it("keeps each account currency stable, filters costs, and preserves exact daily/monthly totals without SDK calls", () => {
    const all = demoCostReport({ range }, now);
    expect(all.source).toBe("demo");
    expect(all.status).toBe("ok");
    expect(all.totals.map((total) => total.currency)).toEqual(["EUR", "USD"]);
    for (const account of demoAccounts()) {
      const currencies = new Set(
        all.rows.filter((row) => row.accountId === account.id).map((row) => row.currency),
      );
      expect(currencies.size).toBe(1);
    }
    const tokyo = demoAccounts()[1];
    const selected = demoCostReport(
      {
        range,
        accountId: tokyo.id,
        region: tokyo.homeRegion,
        service: "Compute",
      },
      now,
    );
    expect(selected.rows.length).toBeGreaterThan(0);
    expect(
      selected.rows.every(
        (row) =>
          row.accountId === tokyo.id &&
          row.region === tokyo.homeRegion &&
          row.service === "Compute",
      ),
    ).toBe(true);
    expect(selected.totals).toEqual([{ currency: "EUR", amount: "0" }]);
    expect(demoCostReport({ range: { ...range, granularity: "monthly" } }, now).totals).toEqual(
      all.totals,
    );
    expect(demoCostReport({ range, service: "Unknown fixture service" }, now)).toMatchObject({
      source: "demo",
      status: "empty",
      rows: [],
      totals: [],
      points: [],
    });
    expect(cloudImport).not.toHaveBeenCalled();
  });
});
