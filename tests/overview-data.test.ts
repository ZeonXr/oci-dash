import { describe, expect, it } from "vitest";
import type {
  AnalyticsRange,
  CostReport,
  CostRow,
  TrafficReport,
  TrafficRow,
} from "@/lib/analytics-contracts";
import { costOverview, overviewDateRange, trafficOverview } from "@/components/overview-data";

const DAY = 86_400_000,
  HOUR = 3_600_000,
  GIB = 1024 ** 3;
const start = Date.parse("2026-11-01T00:00:00Z");
const stamp = (day = 0, hour = 0) => new Date(start + day * DAY + hour * HOUR).toISOString();
function range(days = 7, granularity: AnalyticsRange["granularity"] = "daily"): AnalyticsRange {
  return {
    startDate: "2026-11-01",
    endDate: new Date(start + days * DAY - 1).toISOString().slice(0, 10),
    startTime: stamp(),
    endTime: stamp(days),
    granularity,
    timeZone: "UTC",
  };
}
const metadata = (days = 7) => ({
  range: range(days),
  generatedAt: stamp(8),
  cacheExpiresAt: stamp(8, 1),
  cached: false,
  source: "oci" as const,
  accounts: [],
});
function row(
  instanceId: string,
  vnicId: string,
  received: number | null,
  sent: number | null,
  coverage: TrafficRow["coverage"] = "complete",
): TrafficRow {
  return {
    instanceId,
    instanceName: instanceId,
    accountId: "a",
    accountName: "Account A",
    region: "ap-tokyo-1",
    vnicId,
    vnicName: vnicId,
    receivedBytes: received === null ? null : received * GIB,
    sentBytes: sent === null ? null : sent * GIB,
    coverage,
  };
}
function traffic(patch: Partial<TrafficReport> = {}): TrafficReport {
  return {
    ...metadata(),
    points: [],
    rows: [],
    warnings: [],
    status: "ok",
    dataThrough: stamp(7),
    totals: { receivedBytes: null, sentBytes: null, totalBytes: null },
    ...patch,
  };
}
function costRow(
  service: string | null,
  amount: string | null,
  day = 0,
  currency: string | null = "USD",
  accountId = "a",
): CostRow {
  return {
    accountId,
    accountName: accountId,
    tenancyId: "tenant-" + accountId,
    timestamp: stamp(day),
    service,
    region: "ap-tokyo-1",
    resourceId: service,
    resourceName: service,
    currency,
    amount,
  };
}
function costs(patch: Partial<CostReport> = {}): CostReport {
  return { ...metadata(), rows: [], points: [], totals: [], warnings: [], status: "ok", ...patch };
}

describe("overview traffic data", () => {
  it("defaults to seven completed UTC days across local, year and leap-day boundaries", () => {
    expect(overviewDateRange(new Date("2026-11-08T00:30:00+08:00"))).toEqual({
      preset: "last7",
      startDate: "2026-10-31",
      endDate: "2026-11-06",
    });
    expect(overviewDateRange(new Date("2027-01-01T14:00:00Z"))).toEqual({
      preset: "last7",
      startDate: "2026-12-25",
      endDate: "2026-12-31",
    });
    expect(overviewDateRange(new Date("2028-03-01T00:00:00Z")).endDate).toBe("2028-02-29");
  });

  it("merges all VNICs once and keeps the summary and instance ranking on the same subtotal basis", () => {
    const first = row("instance-a", "vnic-a1", 1, 2);
    const result = trafficOverview(
      traffic({
        status: "partial",
        rows: [
          first,
          row("instance-a", "vnic-a2", 2, null, "partial"),
          { ...first },
          { ...row("instance-b", "vnic-b", 0, 0), accountId: "b", region: "uk-london-1" },
          row("instance-c", "vnic-c", null, null, "unavailable"),
        ],
        totals: { receivedBytes: 3 * GIB, sentBytes: 2 * GIB, totalBytes: 5 * GIB },
      }),
    );
    expect(result.summary).toEqual({
      receivedGiB: 3,
      sentGiB: 2,
      totalGiB: 5,
      coverage: "partial",
    });
    expect(result.ranking.map((item) => item.instanceId)).toEqual([
      "instance-a",
      "instance-b",
      "instance-c",
    ]);
    expect(result.ranking[0]).toMatchObject({
      accountId: "a",
      region: "ap-tokyo-1",
      instanceName: "instance-a",
      vnicCount: 2,
      receivedGiB: 3,
      sentGiB: 2,
      totalGiB: 5,
      coverage: "partial",
    });
    expect(result.ranking[1]).toMatchObject({ totalGiB: 0, coverage: "complete" });
    expect(result.ranking[2]).toMatchObject({ totalGiB: null, coverage: "unavailable" });
  });

  it("fills date gaps with null and excludes incomplete coverage and unfinished days from the peak", () => {
    const result = trafficOverview(
      traffic({
        ...metadata(4),
        status: "partial",
        generatedAt: stamp(3, 12),
        dataThrough: stamp(3, 12),
        points: [
          { timestamp: stamp(), receivedBytes: GIB, sentBytes: 2 * GIB, coverage: "complete" },
          {
            timestamp: stamp(2),
            receivedBytes: 12 * GIB,
            sentBytes: 14 * GIB,
            coverage: "partial",
          },
          {
            timestamp: stamp(3),
            receivedBytes: 99 * GIB,
            sentBytes: 99 * GIB,
            coverage: "complete",
          },
        ],
      }),
    );
    expect(result.points).toHaveLength(4);
    expect(result.points[1]).toMatchObject({
      timestamp: stamp(1),
      receivedGiB: null,
      sentGiB: null,
      totalGiB: null,
      coverage: "unavailable",
    });
    expect(result.points[2]).toMatchObject({
      totalGiB: 26,
      coverage: "partial",
      completeDay: true,
    });
    expect(result.points[3]).toMatchObject({
      totalGiB: 198,
      coverage: "partial",
      completeDay: false,
    });
    expect(result.peak).toMatchObject({ timestamp: stamp(), totalGiB: 3 });
  });

  it("rolls complete hours into days once and retains observed data when one hour is absent", () => {
    const points = Array.from({ length: 24 }, (_, hour) => ({
      timestamp: stamp(0, hour),
      receivedBytes: GIB,
      sentBytes: 0,
      coverage: "complete" as const,
    }));
    const report = traffic({
      range: range(1, "hourly"),
      dataThrough: stamp(1),
      rows: [row("instance", "vnic", 24, 0)],
      totals: { receivedBytes: 24 * GIB, sentBytes: 0, totalBytes: 24 * GIB },
      points: [...points, { ...points[0] }],
    });
    const complete = trafficOverview(report);
    expect(complete.points).toEqual([
      {
        timestamp: stamp(),
        receivedGiB: 24,
        sentGiB: 0,
        totalGiB: 24,
        coverage: "complete",
        completeDay: true,
      },
    ]);
    expect(complete.peak?.totalGiB).toBe(24);
    const partial = trafficOverview({
      ...report,
      points: points.filter((_, index) => index !== 5),
    });
    expect(partial.points[0]).toMatchObject({ receivedGiB: 23, sentGiB: 0, coverage: "partial" });
    expect(partial.peak).toBeNull();
  });

  it("keeps unknown directions and overflowing byte totals null", () => {
    const missing = trafficOverview(
      traffic({
        status: "partial",
        rows: [row("instance", "vnic", null, 1)],
        totals: { receivedBytes: null, sentBytes: GIB, totalBytes: null },
      }),
    );
    expect(missing.summary).toMatchObject({
      receivedGiB: null,
      sentGiB: 1,
      totalGiB: null,
      coverage: "partial",
    });
    const huge = { ...row("large", "first", 0, 0), receivedBytes: Number.MAX_SAFE_INTEGER };
    const overflow = trafficOverview(
      traffic({
        status: "partial",
        rows: [huge, { ...huge, vnicId: "second" }],
        totals: { receivedBytes: null, sentBytes: 0, totalBytes: null },
      }),
    );
    expect(overflow.ranking[0]).toMatchObject({
      receivedGiB: null,
      sentGiB: 0,
      totalGiB: null,
      coverage: "partial",
    });
    expect(overflow.summary.receivedGiB).toBeNull();
  });
});

describe("overview cost composition", () => {
  it("uses decimal service sums and preserves explicit zero, refunds, unknown service and currency separation", () => {
    const report = costs({
      ...metadata(1),
      rows: [
        costRow("Compute", "0.1"),
        costRow("Compute", "0.2", 0, "USD", "b"),
        costRow("Storage", "0"),
        costRow("Network", "-0.05"),
        costRow(null, "0.02"),
        costRow("Compute", "9", 0, "EUR", "eu"),
      ],
      points: [
        { timestamp: stamp(), currency: "USD", amount: "0.27" },
        { timestamp: stamp(), currency: "EUR", amount: "9" },
      ],
      totals: [
        { currency: "USD", amount: "0.27" },
        { currency: "EUR", amount: "9" },
      ],
    });
    const result = costOverview(report, "USD");
    const key = (name: string | null) =>
      result.services.find((service) => service.service === name)!.key;
    expect(result.points[0].amounts[key("Compute")]).toBe("0.3");
    expect(result.points[0].values[key("Compute")]).toBe(0.3);
    expect(result.points[0].values[key("Storage")]).toBe(0);
    expect(result.points[0].values[key("Network")]).toBe(-0.05);
    expect(result.services.find((service) => service.service === null)?.label).toBe("未知服务");
    expect(result.points[0].values[key(null)]).toBe(0.02);
    expect(result.summary).toEqual({ amount: "0.27", value: 0.27, coverage: "complete" });
    expect(result.partial).toBe(false);
    const euros = costOverview(report, "EUR");
    expect(euros.services).toHaveLength(1);
    expect(euros.summary.amount).toBe("9");
    expect(Object.values(euros.points[0].values)).toEqual([9]);
  });

  it("leaves missing dates and unknown amounts null, including an authoritative null total", () => {
    const result = costOverview(
      costs({
        ...metadata(3),
        status: "partial",
        rows: [costRow("Compute", "0"), costRow("Compute", null, 2), costRow("Storage", "2", 2)],
        points: [
          { timestamp: stamp(), currency: "USD", amount: "0" },
          { timestamp: stamp(2), currency: "USD", amount: null },
        ],
        totals: [{ currency: "USD", amount: null }],
      }),
      "USD",
    );
    const compute = result.services.find((service) => service.service === "Compute")!.key;
    const storage = result.services.find((service) => service.service === "Storage")!.key;
    expect(result.points[0].values[compute]).toBe(0);
    expect(result.points[1]).toMatchObject({ total: null, coverage: "unavailable" });
    expect(Object.values(result.points[1].values).every((amount) => amount === null)).toBe(true);
    expect(result.points[2].values[compute]).toBeNull();
    expect(result.points[2].values[storage]).toBe(2);
    expect(result.points[2].totalAmount).toBeNull();
    expect(result.summary.amount).toBeNull();
    expect(result.partial).toBe(true);
  });

  it("uses provider points and authoritative totals without inventing a missing service split", () => {
    const result = costOverview(
      costs({
        ...metadata(2),
        rows: [costRow("Compute", "1")],
        points: [
          { timestamp: stamp(), currency: "USD", amount: "5" },
          { timestamp: stamp(1), currency: "USD", amount: "2" },
        ],
        totals: [{ currency: "USD", amount: "7" }],
      }),
      "USD",
    );
    expect(result.services.map((service) => service.service)).toEqual(["Compute"]);
    const key = result.services[0].key;
    expect(result.points[0]).toMatchObject({ totalAmount: "5", total: 5, coverage: "partial" });
    expect(result.points[0].values[key]).toBe(1);
    expect(result.points[1]).toMatchObject({ totalAmount: "2", total: 2, coverage: "partial" });
    expect(result.points[1].values[key]).toBeNull();
    expect(result.summary).toEqual({ amount: "7", value: 7, coverage: "partial" });
    expect(result.partial).toBe(true);
  });

  it("does not assign unknown-currency amounts to a selected currency", () => {
    const result = costOverview(
      costs({
        ...metadata(1),
        rows: [costRow("Compute", "1"), costRow("Unknown billing source", "99", 0, null)],
        points: [{ timestamp: stamp(), currency: "USD", amount: "1" }],
        totals: [{ currency: "USD", amount: "1" }],
      }),
      "USD",
    );
    expect(result.summary.amount).toBe("1");
    expect(result.services.map((service) => service.service)).toEqual(["Compute"]);
    expect(result.partial).toBe(true);
  });

  it("never spreads monthly amounts over daily chart buckets", () => {
    const result = costOverview(
      costs({
        range: range(7, "monthly"),
        rows: [costRow("Compute", "70")],
        points: [{ timestamp: stamp(), currency: "USD", amount: "70" }],
        totals: [{ currency: "USD", amount: "70" }],
      }),
      "USD",
    );
    expect(result.points).toHaveLength(7);
    expect(
      result.points.every(
        (point) =>
          point.total === null && Object.values(point.values).every((amount) => amount === null),
      ),
    ).toBe(true);
    expect(result.summary.amount).toBe("70");
    expect(result.partial).toBe(true);
  });

  it("retains an exact decimal total when its plotting number would overflow", () => {
    const result = costOverview(
      costs({
        ...metadata(1),
        rows: [costRow("Compute", "1e400")],
        points: [{ timestamp: stamp(), currency: "USD", amount: "1e400" }],
        totals: [{ currency: "USD", amount: "1e400" }],
      }),
      "USD",
    );
    expect(result.summary.amount).toBe("1" + "0".repeat(400));
    expect(result.summary.value).toBeNull();
    expect(result.points[0].values[result.services[0].key]).toBeNull();
    expect(result.partial).toBe(true);
  });
});
