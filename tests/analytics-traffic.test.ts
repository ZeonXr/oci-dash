import { describe, expect, it, vi } from "vitest";
import type { AnalyticsRange } from "@/lib/analytics-contracts";
import type { InstanceSummary } from "@/lib/contracts";
import { createTrafficReader } from "@/server/analytics/traffic";
import type { CloudDocument, OciClientFactory, OciClients } from "@/server/oci/sdk";
import type { OciCredentials } from "@/server/oci/types";

const HOUR = 3_600_000;
const id = (kind: string, suffix = "a") => "ocid1." + kind + ".oc1..traffic" + suffix;
const start = Date.parse("2026-11-07T00:00:00.000Z");
const now = Date.parse("2026-11-09T12:30:00.000Z");
const credentials: OciCredentials = {
  tenancyId: id("tenancy"),
  userId: id("user"),
  fingerprint: "test-only",
  privateKey: "PRIVATE-TEST-ONLY",
  region: "ap-tokyo-1",
};
function range(hours = 2, granularity: "hourly" | "daily" = "hourly"): AnalyticsRange {
  return {
    startDate: "2026-11-07",
    endDate: new Date(start + hours * HOUR - 1).toISOString().slice(0, 10),
    startTime: new Date(start).toISOString(),
    endTime: new Date(start + hours * HOUR).toISOString(),
    granularity,
    timeZone: "UTC",
  };
}
function instance(suffix = "a", region = "ap-tokyo-1"): InstanceSummary {
  return {
    id: id("instance", suffix),
    accountId: "traffic-account",
    accountName: "Traffic fixture",
    displayName: "Traffic instance " + suffix,
    region,
    availabilityDomain: "TEST-AD",
    compartmentId: id("compartment", "instance"),
    state: "RUNNING",
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    createdAt: "2026-01-01T00:00:00.000Z",
    syncedAt: "2026-11-09T00:00:00.000Z",
    vnics: [
      {
        id: id("vnic", suffix),
        name: "VNIC " + suffix,
        primary: true,
        subnetId: id("subnet"),
        nsgIds: [],
        privateIps: [
          {
            privateIpId: id("privateip", "fixed"),
            privateIp: "10.0.0.2",
            isPrimary: false,
            vnicId: id("vnic", suffix),
            publicIp: "203.0.113.1",
            protected: true,
          },
          {
            privateIpId: id("privateip", "rotating"),
            privateIp: "10.0.0.3",
            isPrimary: true,
            vnicId: id("vnic", suffix),
            publicIp: "198.51.100.1",
            protected: false,
          },
        ],
        ipv6: [],
      },
    ],
    bootVolumes: [],
    tags: {},
  };
}
const incoming = "VnicFromNetworkBytes";
const outgoing = "VnicToNetworkBytes";
function values(amounts: (number | null)[], at = start) {
  return amounts.flatMap((value, index) =>
    value === null
      ? []
      : [
          {
            timestamp: new Date(at + (index + 1) * HOUR),
            value,
          },
        ],
  );
}
function series(vnicId: string, metric: string, points = values([10, 20])): CloudDocument {
  return {
    namespace: "oci_vcn",
    name: metric,
    compartmentId: id("compartment", "vnic"),
    dimensions: { resourceId: vnicId },
    metadata: { unit: "bytes" },
    resolution: "1h",
    aggregatedDatapoints: points,
  };
}
function setup(
  options: {
    now?: number;
    timeoutMs?: number;
    factoryGate?: Promise<void>;
    metric?: (
      region: string,
      vnicId: string,
      name: string,
      request: CloudDocument,
    ) => CloudDocument | Promise<CloudDocument>;
    vnic?: (region: string, vnicId: string) => CloudDocument;
    factoryError?: unknown;
  } = {},
) {
  const requests: { region: string; operation: string; request: CloudDocument }[] = [];
  const scopes: {
    region: string;
    credentials: OciCredentials;
    close: ReturnType<typeof vi.fn>[];
  }[] = [];
  let active = 0,
    peak = 0;
  const factory: OciClientFactory = vi.fn(async (supplied, region) => {
    if (options.factoryGate) await options.factoryGate;
    if (options.factoryError) throw options.factoryError;
    const closes = Array.from({ length: 5 }, () => vi.fn());
    const scope = {
      region,
      credentials: supplied,
      close: closes,
    };
    scopes.push(scope);
    const call = async (operation: string, request: CloudDocument): Promise<CloudDocument> => {
      requests.push({ region, operation, request });
      active += 1;
      peak = Math.max(peak, active);
      try {
        await Promise.resolve();
        if (operation === "getVnic")
          return (
            options.vnic?.(region, request.vnicId) ?? {
              vnic: { id: request.vnicId, compartmentId: id("compartment", "vnic") },
            }
          );
        if (operation !== "summarizeMetricsData")
          throw new Error("Unexpected cloud test operation: " + operation);
        const query = request.summarizeMetricsDataDetails.query as string;
        const match = query.match(
          /^(VnicFromNetworkBytes|VnicToNetworkBytes)\[1h\]\{resourceId = "([^"]+)"\}\.sum\(\)$/,
        );
        if (!match) throw new Error("Unexpected query in fixture");
        return await (options.metric?.(region, match[2], match[1], request) ?? {
          items: [series(match[2], match[1])],
        });
      } finally {
        active -= 1;
      }
    };
    const clients: OciClients = {
      identity: { call, close: closes[0] },
      compute: { call, close: closes[1] },
      network: { call, close: closes[2] },
      storage: { call, close: closes[3] },
      monitoring: { call, close: closes[4] },
    };
    return clients;
  });
  return {
    reader: createTrafficReader({
      clientFactory: factory,
      now: () => options.now ?? now,
      timeoutMs: options.timeoutMs,
    }),
    requests,
    scopes,
    factory,
    peak: () => peak,
  };
}
function closed(h: ReturnType<typeof setup>) {
  for (const scope of h.scopes)
    for (const close of scope.close) expect(close).toHaveBeenCalledTimes(1);
}

describe("OCI traffic reader (offline only)", () => {
  it("uses the real VNIC compartment, correct directions, equal interval/resolution and window-end timestamps", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [
          series(vnicId, metric, [
            { timestamp: new Date(start), value: 9999 }, // Previous hour must be excluded.
            ...values(metric === incoming ? [0, 20] : [30, 40]),
            { timestamp: new Date(start + 3 * HOUR), value: 8888 }, // Outside selected end.
          ]),
        ],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: 0,
        sentBytes: 30,
        coverage: "complete",
      },
      {
        timestamp: new Date(start + HOUR).toISOString(),
        receivedBytes: 20,
        sentBytes: 40,
        coverage: "complete",
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      receivedBytes: 20,
      sentBytes: 70,
      coverage: "complete",
    });
    expect(result.status).toBe("ok");
    expect(result.dataThrough).toBe(new Date(start + 2 * HOUR).toISOString());
    const reads = h.requests.filter((request) => request.operation === "summarizeMetricsData");
    expect(reads).toHaveLength(2);
    for (const { request } of reads) {
      expect(request.compartmentId).toBe(id("compartment", "vnic"));
      expect(request.summarizeMetricsDataDetails).toMatchObject({
        namespace: "oci_vcn",
        resolution: "1h",
        startTime: new Date(start),
        endTime: new Date(start + 2 * HOUR + 1),
      });
    }
    expect(result.warnings.join(" ")).toContain("未包含已分离或删除");
    closed(h);
  });

  it("accepts OCI's observed null response resolution without weakening the requested non-overlapping windows", async () => {
    const selected = instance();
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [
          {
            ...series(vnicId, metric),
            dimensions: { resourceId: vnicId, instanceId: selected.id },
            metadata: { displayName: "Bytes from Network", unit: "bytes" },
            resolution: null,
          },
        ],
      }),
    });
    const result = await h.reader.read(credentials, [selected], range());
    expect(result.status).toBe("ok");
    expect(result.rows[0]).toMatchObject({
      receivedBytes: 30,
      sentBytes: 30,
      coverage: "complete",
    });
    expect(result.points[0]).toMatchObject({ receivedBytes: 10, sentBytes: 10 });
    expect(
      h.requests
        .filter((entry) => entry.operation === "summarizeMetricsData")
        .every((entry) => entry.request.summarizeMetricsDataDetails.resolution === "1h"),
    ).toBe(true);
    closed(h);
  });

  it("rolls UTC hours into days without moving the midnight-ending bucket into the next day", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [series(vnicId, metric, values([...Array(24).fill(1), ...Array(24).fill(2)]))],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range(48, "daily"));
    expect(result.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: 24,
        sentBytes: 24,
        coverage: "complete",
      },
      {
        timestamp: new Date(start + 24 * HOUR).toISOString(),
        receivedBytes: 48,
        sentBytes: 48,
        coverage: "complete",
      },
    ]);
    expect(result.rows[0]).toMatchObject({
      receivedBytes: 72,
      sentBytes: 72,
      coverage: "complete",
    });
    closed(h);
  });

  it("aligns independent direction timestamps and preserves missing hours as null", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [series(vnicId, metric, values(metric === incoming ? [null, 25] : [10, null]))],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: null,
        sentBytes: 10,
        coverage: "partial",
      },
      {
        timestamp: new Date(start + HOUR).toISOString(),
        receivedBytes: 25,
        sentBytes: null,
        coverage: "partial",
      },
    ]);
    expect(result.rows[0]).toMatchObject({ receivedBytes: 25, sentBytes: 10, coverage: "partial" });
    expect(result.status).toBe("partial");
    closed(h);
  });

  it("does not multiply a VNIC by its two IPs or duplicate inventory entries", async () => {
    const original = instance();
    original.vnics.push(structuredClone(original.vnics[0]));
    const h = setup();
    const result = await h.reader.read(credentials, [original, structuredClone(original)], range());
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ receivedBytes: 30, sentBytes: 30 });
    expect(h.requests.filter((item) => item.operation === "getVnic")).toHaveLength(1);
    expect(h.requests.filter((item) => item.operation === "summarizeMetricsData")).toHaveLength(2);
    closed(h);
  });

  it("sums observed VNICs exactly once and marks partially covered points", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [
          series(
            vnicId,
            metric,
            values(
              vnicId === id("vnic", "a") ? [10, 20] : metric === incoming ? [5, null] : [2, 3],
            ),
          ),
        ],
      }),
    });
    const result = await h.reader.read(credentials, [instance("a"), instance("b")], range());
    expect(result.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: 15,
        sentBytes: 12,
        coverage: "complete",
      },
      {
        timestamp: new Date(start + HOUR).toISOString(),
        receivedBytes: 20,
        sentBytes: 23,
        coverage: "partial",
      },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({ receivedBytes: 5, sentBytes: 5, coverage: "partial" });
    expect(result.status).toBe("partial");
    closed(h);
  });

  it("plots known values despite missing VNICs and hours, while wholly missing hour/day buckets remain null", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [
          series(
            vnicId,
            metric,
            vnicId === id("vnic", "a") ? values([metric === incoming ? 10 : 4]) : [],
          ),
        ],
      }),
    });
    const selected = [instance("a"), instance("b")];
    const hourly = await h.reader.read(credentials, selected, range(48));
    expect(hourly.points[0]).toMatchObject({
      receivedBytes: 10,
      sentBytes: 4,
      coverage: "partial",
    });
    expect(hourly.points[1]).toMatchObject({
      receivedBytes: null,
      sentBytes: null,
      coverage: "unavailable",
    });
    const daily = await h.reader.read(credentials, selected, range(48, "daily"));
    expect(daily.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: 10,
        sentBytes: 4,
        coverage: "partial",
      },
      {
        timestamp: new Date(start + 24 * HOUR).toISOString(),
        receivedBytes: null,
        sentBytes: null,
        coverage: "unavailable",
      },
    ]);
    expect(daily.status).toBe("partial");
    closed(h);
  });

  it("distinguishes observed zero from unavailable metrics", async () => {
    for (const present of [true, false]) {
      const h = setup({
        metric: (_region, vnicId, metric) => ({
          items: present ? [series(vnicId, metric, values([0, 0]))] : [],
        }),
      });
      const result = await h.reader.read(credentials, [instance()], range());
      expect(result.rows[0]).toMatchObject({
        receivedBytes: present ? 0 : null,
        sentBytes: present ? 0 : null,
        coverage: present ? "complete" : "unavailable",
      });
      expect(result.status).toBe(present ? "ok" : "empty");
      closed(h);
    }
  });

  it("keeps successful directions when OCI denies the other one and never exposes raw errors", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => {
        if (metric === incoming)
          throw {
            statusCode: 403,
            code: "NotAuthorizedOrNotFound",
            message: "SECRET_AUTHORIZATION PRIVATE-TEST-ONLY",
          };
        return { items: [series(vnicId, metric)] };
      },
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.rows[0]).toMatchObject({
      receivedBytes: null,
      sentBytes: 30,
      coverage: "partial",
    });
    expect(result.status).toBe("partial");
    expect(result.warnings.join(" ")).toContain("权限不足");
    expect(result.warnings.join(" ")).not.toMatch(/SECRET_AUTHORIZATION|PRIVATE-TEST-ONLY/);
    closed(h);
  });

  it("falls back to the known instance compartment with an explicit partial flag if VNIC lookup fails", async () => {
    const h = setup({
      vnic: () => {
        throw { statusCode: 404, code: "NotAuthorizedOrNotFound" };
      },
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.rows[0].coverage).toBe("partial");
    expect(result.rows[0].receivedBytes).toBe(30);
    expect(result.warnings.join(" ")).toContain("按库存实例区间");
    expect(
      h.requests
        .filter((entry) => entry.operation === "summarizeMetricsData")
        .every((entry) => entry.request.compartmentId === id("compartment", "instance")),
    ).toBe(true);
    closed(h);
  });

  it("refuses to query a mismatched VNIC response", async () => {
    const h = setup({
      vnic: () => ({ vnic: { id: id("vnic", "foreign"), compartmentId: id("compartment") } }),
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.status).toBe("partial");
    expect(result.rows[0].coverage).toBe("unavailable");
    expect(h.requests.some((entry) => entry.operation === "summarizeMetricsData")).toBe(false);
    closed(h);
  });

  it("deduplicates repeated metric records and rejects contradictory or unrelated streams", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [
          series(vnicId, metric),
          series(vnicId, metric, values([10, 999])),
          series(id("vnic", "foreign"), metric, values([1000, 1000])),
        ],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.points[0]).toMatchObject({ receivedBytes: 10, sentBytes: 10 });
    expect(result.points[1]).toMatchObject({ receivedBytes: null, sentBytes: null });
    expect(result.rows[0]).toMatchObject({ receivedBytes: 10, sentBytes: 10, coverage: "partial" });
    closed(h);
  });

  it("excludes the current partial hour and exposes the last completed boundary", async () => {
    const h = setup({
      now: start + HOUR + 25 * 60_000,
      metric: (_region, vnicId, metric) => ({
        items: [series(vnicId, metric, values([10, 999]))],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range(24, "daily"));
    expect(result.dataThrough).toBe(new Date(start + HOUR).toISOString());
    expect(result.rows[0]).toMatchObject({
      receivedBytes: 10,
      sentBytes: 10,
      coverage: "complete",
    });
    expect(result.points).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        receivedBytes: 10,
        sentBytes: 10,
        coverage: "complete",
      },
    ]);
    expect(result.warnings.join(" ")).toContain("当前小时未计入");
    closed(h);
  });

  it("does not query future windows or invent data before the first completed hour", async () => {
    const h = setup({ now: start + 20 * 60_000 });
    const result = await h.reader.read(credentials, [instance()], range(24));
    expect(result.points).toEqual([]);
    expect(result.status).toBe("empty");
    expect(result.dataThrough).toBe(new Date(start).toISOString());
    expect(h.factory).not.toHaveBeenCalled();
  });

  it("creates region-scoped clients and limits cloud concurrency to two across concurrent reads", async () => {
    const h = setup();
    const supplied = { ...credentials };
    const results = await Promise.all([
      h.reader.read(
        supplied,
        [instance("a", "ap-tokyo-1"), instance("b", "us-phoenix-1")],
        range(),
      ),
      h.reader.read(supplied, [instance("c", "uk-london-1"), instance("d", "ap-tokyo-1")], range()),
    ]);
    expect(results.every((result) => result.status === "ok")).toBe(true);
    expect(h.scopes).toHaveLength(4);
    for (const scope of h.scopes) expect(scope.credentials.region).toBe(scope.region);
    expect(supplied).toEqual(credentials);
    expect(h.peak()).toBeLessThanOrEqual(2);
    expect(h.peak()).toBeGreaterThan(0);
    closed(h);
  });

  it("sanitizes client construction failures and reports unavailable observations", async () => {
    const h = setup({ factoryError: new Error("PRIVATE-TEST-ONLY token=supersecret") });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.status).toBe("partial");
    expect(result.rows[0].receivedBytes).toBeNull();
    expect(result.warnings.join(" ")).not.toMatch(/PRIVATE-TEST-ONLY|supersecret/);
    expect(h.factory).toHaveBeenCalledTimes(1);
  });

  it("does not silently round a cross-VNIC total above the safe integer range", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [series(vnicId, metric, values([Number.MAX_SAFE_INTEGER]))],
      }),
    });
    const result = await h.reader.read(credentials, [instance("a"), instance("b")], range(1));
    expect(result.rows.every((row) => row.receivedBytes === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(result.points[0]).toMatchObject({
      receivedBytes: null,
      sentBytes: null,
      coverage: "partial",
    });
    expect(result.status).toBe("partial");
    expect(result.warnings.join(" ")).toContain("安全数值精度");
    closed(h);
  });

  it("treats malformed-only samples as partial failure, never a confirmed empty/zero result", async () => {
    const h = setup({
      metric: (_region, vnicId, metric) => ({
        items: [series(vnicId, metric, values([-1, 1.5]))],
      }),
    });
    const result = await h.reader.read(credentials, [instance()], range());
    expect(result.rows[0]).toMatchObject({
      receivedBytes: null,
      sentBytes: null,
      coverage: "unavailable",
    });
    expect(result.status).toBe("partial");
    closed(h);
  });

  it("returns observed data at the whole-read deadline and never dispatches later VNIC calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({
      timeoutMs: 20,
      metric: async (_region, vnicId, metric) => {
        if (vnicId !== id("vnic", "a") || metric === outgoing) await gate;
        return { items: [series(vnicId, metric)] };
      },
    });
    try {
      const result = await h.reader.read(
        credentials,
        [instance("a"), instance("b"), instance("c")],
        range(),
      );
      expect(result.status).toBe("partial");
      expect(result.rows[0]).toMatchObject({
        receivedBytes: 30,
        sentBytes: null,
        coverage: "partial",
      });
      expect(result.warnings.join(" ")).toContain("整体时间限制");
      const issued = h.requests.length;
      expect(h.requests.some((entry) => entry.request.vnicId === id("vnic", "c"))).toBe(false);
      closed(h);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.requests).toHaveLength(issued);
      expect(h.peak()).toBeLessThanOrEqual(2);
    } finally {
      release();
    }
  });

  it("preserves observations and stops queued VNIC reads when its parent query is cancelled", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const h = setup({
      metric: async (_region, vnicId, metric) => {
        if (vnicId !== id("vnic", "a") || metric === outgoing) await gate;
        return { items: [series(vnicId, metric)] };
      },
    });
    try {
      const pending = h.reader.read(
        credentials,
        [instance("a"), instance("b"), instance("c")],
        range(),
        controller.signal,
      );
      await vi.waitFor(() =>
        expect(
          h.requests.some((entry) =>
            entry.request.summarizeMetricsDataDetails?.query?.startsWith(outgoing),
          ),
        ).toBe(true),
      );
      controller.abort();
      const result = await pending;
      expect(result.status).toBe("partial");
      expect(result.rows[0]).toMatchObject({
        receivedBytes: 30,
        sentBytes: null,
        coverage: "partial",
      });
      const count = h.requests.length;
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.requests).toHaveLength(count);
      expect(h.requests.some((entry) => entry.request.vnicId === id("vnic", "c"))).toBe(false);
      closed(h);
    } finally {
      release();
    }
  });

  it("closes clients whose construction finishes after the overall deadline without issuing RPCs", async () => {
    let release!: () => void;
    const factoryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = setup({ timeoutMs: 15, factoryGate });
    try {
      const result = await h.reader.read(credentials, [instance()], range());
      expect(result.status).toBe("partial");
      expect(result.rows[0].coverage).toBe("unavailable");
      expect(h.requests).toEqual([]);
      release();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.scopes).toHaveLength(1);
      closed(h);
      expect(h.requests).toEqual([]);
    } finally {
      release();
    }
  });

  it("rejects invalid or oversized ranges and mixed-account inputs before opening SDK clients", async () => {
    const h = setup();
    await expect(
      h.reader.read(credentials, [instance()], range(90 * 24 + 1)),
    ).rejects.toMatchObject({ code: "INVALID_TRAFFIC_RANGE" });
    await expect(
      h.reader.read(credentials, [instance()], { ...range(), granularity: "monthly" }),
    ).rejects.toMatchObject({ code: "INVALID_TRAFFIC_RANGE" });
    await expect(
      h.reader.read(credentials, [instance(), { ...instance("b"), accountId: "other" }], range()),
    ).rejects.toMatchObject({ code: "TRAFFIC_ACCOUNT_MISMATCH" });
    expect(h.factory).not.toHaveBeenCalled();
  });
});
