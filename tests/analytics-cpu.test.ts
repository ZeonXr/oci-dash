import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import { createCpuService, type CpuServiceOptions } from "@/server/analytics/cpu";
import type { CloudDocument } from "@/server/oci/sdk";

const HOUR = 3_600_000;
const SAMPLE = 300_000;
const NOW = Date.parse("2026-11-08T12:34:00.000Z");
const END = Math.floor(NOW / HOUR) * HOUR;
const START = END - 24 * HOUR;
const id = (kind: string, suffix: string) => `ocid1.${kind}.oc1..${suffix}`;

function account(name = "one", tenancy = name): AccountSummary {
  return {
    id: name,
    name,
    tenancyId: id("tenancy", tenancy),
    userId: id("user", name),
    fingerprint: "fixture",
    homeRegion: "ap-tokyo-1",
    regions: ["ap-tokyo-1"],
    status: "connected",
    lastSyncAt: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function instance(a = account(), suffix = a.id, region = a.homeRegion): InstanceSummary {
  return {
    id: id("instance", suffix),
    displayName: suffix,
    accountId: a.id,
    accountName: a.name,
    region,
    compartmentId: id("compartment", suffix),
    availabilityDomain: "TEST-AD",
    state: "RUNNING",
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    vnics: [],
    bootVolumes: [],
    tags: {},
    createdAt: "2026-01-01T00:00:00Z",
    syncedAt: "2026-11-08T12:00:00Z",
  };
}
function series(resourceId: string, values: (number | null)[], start = START): CloudDocument {
  return {
    namespace: "oci_computeagent",
    name: "CpuUtilization",
    dimensions: { resourceId },
    resolution: "5m",
    metadata: { unit: "Percent" },
    aggregatedDatapoints: values.flatMap((value, index) =>
      value === null
        ? []
        : [
            {
              timestamp: new Date(start + (index + 1) * SAMPLE),
              value,
            },
          ],
    ),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  initial = [account()],
  options: { timeoutMs?: number; items?: InstanceSummary[]; factoryGate?: Promise<void> } = {},
) {
  let clock = NOW,
    revision = 1,
    available = initial;
  let current = true;
  let active = 0,
    peak = 0;
  const inventory = options.items ?? initial.map((a) => instance(a));
  const requests: { region: string; operation: string; request: CloudDocument }[] = [];
  const close = vi.fn();
  const metric = vi.fn(
    async (resourceId: string, _request: CloudDocument): Promise<CloudDocument> => ({
      items: [series(resourceId, Array(288).fill(20))],
    }),
  );
  const access = vi.fn((name: string) => {
    const a = available.find((item) => item.id === name)!;
    return {
      revision,
      credentials: {
        tenancyId: a.tenancyId,
        userId: a.userId,
        fingerprint: a.fingerprint,
        privateKey: "SECRET-CPU-FIXTURE",
        region: a.homeRegion,
      },
    };
  });
  const factory = vi.fn(async (_credentials, region: string) => {
    if (options.factoryGate) await options.factoryGate;
    return {
      close,
      async call(operation: string, request: CloudDocument) {
        requests.push({ region, operation, request });
        active++;
        peak = Math.max(peak, active);
        try {
          const query = request.summarizeMetricsDataDetails.query as string;
          const match = query.match(/^CpuUtilization\[5m\]\{resourceId = "([^"]+)"\}\.mean\(\)$/);
          if (operation !== "summarizeMetricsData" || !match)
            throw new Error("Unexpected OCI call");
          return await metric(match[1], request);
        } finally {
          active--;
        }
      },
    };
  });
  const service = createCpuService({
    accounts: () => available,
    instances: () => inventory,
    access,
    isCurrent: (name, value) =>
      current && available.some((a) => a.id === name) && value === revision,
    now: () => clock,
    demo: () => false,
    clientFactory: factory,
    timeoutMs: options.timeoutMs,
  });
  return {
    service,
    metric,
    factory,
    access,
    requests,
    close,
    inventory,
    advance: (ms: number) => {
      clock += ms;
    },
    changeRevision: () => {
      revision++;
    },
    revoke: () => {
      current = false;
    },
    removeAll: () => {
      available = [];
    },
    active: () => active,
    peak: () => peak,
  };
}
afterEach(() => vi.useRealTimers());

describe("CPU hourly analytics", () => {
  it("returns exactly 24 completed UTC hours and retains zero, including historically stopped instances", async () => {
    const f = fixture();
    f.inventory[0].state = "STOPPED";
    f.metric.mockImplementation(async (resource) => ({
      items: [series(resource, Array(288).fill(0))],
    }));
    const report = await f.service.query({});
    expect(report.range).toEqual({
      startTime: new Date(START).toISOString(),
      endTime: new Date(END).toISOString(),
      granularity: "hourly",
      timeZone: "UTC",
    });
    expect(report.rows[0].points).toHaveLength(24);
    expect(report.points).toHaveLength(24);
    expect(
      report.rows[0].points.every(
        (point) =>
          point.cpuPercent === 0 && point.sampleCount === 12 && point.coverage === "complete",
      ),
    ).toBe(true);
    expect(report.rows[0].state).toBe("STOPPED");
    expect(report.summary).toEqual({
      averageCpuPercent: 0,
      peakCpuPercent: 0,
      totalInstances: 1,
      instancesWithSamples: 1,
      observedHours: 24,
      totalSamples: 288,
    });
    expect(report.status).toBe("ok");
    expect(f.requests[0].request.summarizeMetricsDataDetails.endTime).toEqual(new Date(END + 1));
  });

  it("places end-stamped samples in the preceding interval and excludes current-hour samples", async () => {
    const f = fixture();
    f.metric.mockImplementation(async (resource) => {
      const data = series(resource, []);
      data.aggregatedDatapoints = [
        { timestamp: new Date(START), value: 99 },
        { timestamp: new Date(START + HOUR), value: 10 },
        { timestamp: new Date(START + HOUR + SAMPLE), value: 20 },
        { timestamp: new Date(END), value: 30 },
        { timestamp: new Date(END + SAMPLE), value: 99 },
      ];
      return { items: [data] };
    });
    const report = await f.service.query({});
    expect(report.rows[0].points.map((p) => p.cpuPercent)).toEqual([
      10,
      20,
      ...Array(21).fill(null),
      30,
    ]);
    expect(report.summary.totalSamples).toBe(3);
    expect(report.rows[0].points[2]).toMatchObject({
      cpuPercent: null,
      sampleCount: 0,
      expectedSamples: 12,
      coverage: "unavailable",
    });
    expect(report.rows[0].points[0].coverage).toBe("partial");
  });

  it("averages instances within each hour, then hours, without weighting by sample counts", async () => {
    const f = fixture([account("one"), account("two")]);
    f.metric.mockImplementation(async (resource) => ({
      items: [series(resource, resource.endsWith("one") ? [...Array(12).fill(0), 20] : [100])],
    }));
    const report = await f.service.query({});
    expect(report.points[0]).toMatchObject({ cpuPercent: 50, instanceCount: 2, sampleCount: 13 });
    expect(report.points[1]).toMatchObject({ cpuPercent: 20, instanceCount: 1 });
    expect(report.summary.averageCpuPercent).toBe(35);
    expect(report.summary.peakCpuPercent).toBe(100);
    expect(report.summary.totalSamples).toBe(14);
    expect(report.status).toBe("partial");
  });

  it("deduplicates exact samples and invalidates conflicts, malformed samples and wrong resource series", async () => {
    const f = fixture();
    f.metric.mockImplementation(async (resource) => {
      const data = series(resource, [10, 20, NaN, -1, 101, 40]);
      data.aggregatedDatapoints.push(
        { timestamp: new Date(START + SAMPLE), value: 10 },
        { timestamp: new Date(START + 2 * SAMPLE), value: 21 },
        { timestamp: new Date(START + 2 * SAMPLE), value: 20 },
        { timestamp: new Date(START + 7 * SAMPLE + 1), value: 90 },
        { timestamp: "invalid", value: 90 },
      );
      return {
        items: [
          data,
          series(id("instance", "unrelated"), [99]),
          { ...series(resource, [99]), compartmentId: id("compartment", "wrong") },
          { ...series(resource, [99]), namespace: "other" },
        ],
      };
    });
    const report = await f.service.query({});
    expect(report.rows[0].points[0]).toMatchObject({ cpuPercent: 25, sampleCount: 2 });
    expect(report.status).toBe("partial");
    expect(report.warnings.join(" ")).toContain("已排除");
  });

  it("keeps successful empty monitoring responses unknown instead of zero or offline", async () => {
    const f = fixture();
    f.metric.mockResolvedValue({ items: [] });
    const report = await f.service.query({});
    expect(report.status).toBe("empty");
    expect(report.rows[0].state).toBe("RUNNING");
    expect(report.summary.averageCpuPercent).toBeNull();
    expect(report.summary.peakCpuPercent).toBeNull();
    expect(report.points.every((p) => p.cpuPercent === null)).toBe(true);
    expect(report.warnings.join(" ")).toContain("不代表实例离线或零负载");
  });

  it("uses only CPU Monitoring RPCs with the exact account, region and compartment", async () => {
    const a = account("one"),
      b = account("two");
    b.regions.push("uk-london-1");
    const items = [instance(a), instance(b, "two", "uk-london-1")];
    const f = fixture([a, b], { items });
    await f.service.query({});
    expect(f.requests).toHaveLength(2);
    for (const item of items) {
      expect(f.requests).toContainEqual({
        region: item.region,
        operation: "summarizeMetricsData",
        request: {
          compartmentId: item.compartmentId,
          summarizeMetricsDataDetails: {
            namespace: "oci_computeagent",
            query: `CpuUtilization[5m]{resourceId = "${item.id}"}.mean()`,
            startTime: new Date(START),
            endTime: new Date(END + 1),
            resolution: "5m",
          },
        },
      });
      expect(
        f.factory.mock.calls.some(
          ([credentials, region]) =>
            credentials.tenancyId === (item.accountId === a.id ? a : b).tenancyId &&
            region === item.region,
        ),
      ).toBe(true);
    }
    expect(f.close).toHaveBeenCalledTimes(2);
  });

  it("does not double-weight one tenancy resource registered under two accounts", async () => {
    const a = account("one", "same"),
      b = account("two", "same");
    const f = fixture([a, b], { items: [instance(a, "same"), instance(b, "same")] });
    const report = await f.service.query({});
    expect(report.rows).toHaveLength(1);
    expect(report.summary.totalInstances).toBe(1);
    expect(report.accounts[1].status).toBe("duplicate");
    expect(f.metric).toHaveBeenCalledTimes(1);
  });

  it("returns successful accounts while sanitizing monitoring permission errors", async () => {
    const f = fixture([account("one"), account("two")]);
    f.metric.mockImplementation(async (resource) => {
      if (resource.endsWith("one"))
        throw {
          statusCode: 403,
          code: "NotAuthorizedOrNotFound",
          message: "SECRET-CPU-FIXTURE",
          request: { privateKey: "SECRET-CPU-FIXTURE" },
        };
      return { items: [series(resource, Array(288).fill(30))] };
    });
    const report = await f.service.query({});
    expect(report.status).toBe("partial");
    expect(report.accounts.map((a) => a.status)).toEqual(["error", "ok"]);
    expect(report.summary.averageCpuPercent).toBe(30);
    expect(JSON.stringify(report)).not.toContain("SECRET-CPU-FIXTURE");
    expect(report.warnings.join(" ")).toContain("权限不足");
  });
});

describe("CPU refresh and isolation", () => {
  it("caches for 60 seconds, debounces manual reads, and isolates caller mutations", async () => {
    const f = fixture();
    const report = await f.service.query({});
    report.rows[0].points[0].cpuPercent = 99;
    expect((await f.service.query({})).rows[0].points[0].cpuPercent).toBe(20);
    expect((await f.service.query({}, true)).cached).toBe(true);
    f.advance(2001);
    expect((await f.service.query({}, true)).cached).toBe(false);
    f.advance(60_001);
    expect((await f.service.query({})).cached).toBe(false);
    expect(f.metric).toHaveBeenCalledTimes(3);
  });

  it("uses a shorter 30-second partial cache and invalidates on completed-hour rollover", async () => {
    const f = fixture();
    f.metric.mockImplementation(async (resource) => ({ items: [series(resource, [5])] }));
    const report = await f.service.query({});
    expect(Date.parse(report.cacheExpiresAt) - Date.parse(report.generatedAt)).toBe(30_000);
    f.advance(30_001);
    expect((await f.service.query({})).cached).toBe(false);
    f.advance(HOUR);
    const next = await f.service.query({});
    expect(next.range.startTime).toBe(new Date(START + HOUR).toISOString());
    expect(f.metric).toHaveBeenCalledTimes(3);
  });

  it("coalesces in-flight reads, including refresh, and copies their results", async () => {
    const f = fixture();
    const gate = deferred<CloudDocument>();
    f.metric.mockReturnValue(gate.promise);
    const first = f.service.query({}),
      second = f.service.query({}, true);
    await vi.waitFor(() => expect(f.metric).toHaveBeenCalledTimes(1));
    gate.resolve({ items: [series(f.inventory[0].id, [20])] });
    const [a, b] = await Promise.all([first, second]);
    a.rows[0].points[0].cpuPercent = 100;
    expect(b.rows[0].points[0].cpuPercent).toBe(20);
  });

  it("does not reuse old credential cache and rejects revoked cached access", async () => {
    const f = fixture();
    await f.service.query({});
    f.changeRevision();
    expect((await f.service.query({})).cached).toBe(false);
    expect(f.metric).toHaveBeenCalledTimes(2);
    f.revoke();
    await expect(f.service.query({})).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
  });

  it("rejects a report if credentials change while it is running", async () => {
    const f = fixture();
    const gate = deferred<CloudDocument>();
    f.metric.mockReturnValue(gate.promise);
    const result = f.service.query({});
    const rejection = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await vi.waitFor(() => expect(f.metric).toHaveBeenCalledTimes(1));
    f.changeRevision();
    gate.resolve({ items: [series(f.inventory[0].id, [20])] });
    await rejection;
  });

  it("checks credentials again after factory initialization before sending an RPC", async () => {
    const gate = deferred<void>();
    const f = fixture(undefined, { factoryGate: gate.promise });
    const result = f.service.query({});
    const rejection = expect(result).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalledTimes(1));
    f.changeRevision();
    gate.resolve();
    await rejection;
    expect(f.requests).toHaveLength(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("returns partial data at one overall deadline and stops dispatching queued instances", async () => {
    vi.useFakeTimers();
    const a = account();
    const f = fixture([a], {
      timeoutMs: 50,
      items: [
        instance(a, "first"),
        instance(a, "slow"),
        instance(a, "queued"),
        instance(a, "never"),
      ],
    });
    const gate = deferred<CloudDocument>();
    f.metric.mockImplementation(async (resource) =>
      resource.endsWith("first") ? { items: [series(resource, [25])] } : gate.promise,
    );
    const result = f.service.query({});
    await vi.advanceTimersByTimeAsync(51);
    const report = await result;
    expect(report.status).toBe("partial");
    expect(report.rows).toHaveLength(4);
    expect(report.rows[0].sampleCount).toBe(1);
    expect(report.rows.slice(1).every((row) => row.sampleCount === 0)).toBe(true);
    expect(f.requests).toHaveLength(3);
    expect(f.peak()).toBe(2);
    gate.resolve({ items: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.close).toHaveBeenCalledTimes(3);
  });

  it("retains concurrency slots for real RPCs still running after their deadline", async () => {
    vi.useFakeTimers();
    const a = account();
    const f = fixture([a], { timeoutMs: 50, items: [instance(a, "a"), instance(a, "b")] });
    const gate = deferred<CloudDocument>();
    f.metric.mockReturnValue(gate.promise);
    const first = f.service.query({});
    await vi.advanceTimersByTimeAsync(51);
    await first;
    expect(f.active()).toBe(2);
    f.advance(3000);
    const second = f.service.query({}, true);
    await vi.advanceTimersByTimeAsync(51);
    expect((await second).status).toBe("partial");
    expect(f.requests).toHaveLength(2);
    expect(f.peak()).toBe(2);
    gate.resolve({ items: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.active()).toBe(0);
    expect(f.close).toHaveBeenCalledTimes(2);
    f.advance(3000);
    f.metric.mockImplementation(async (resource) => ({ items: [series(resource, [10])] }));
    expect((await f.service.query({}, true)).summary.instancesWithSamples).toBe(2);
    expect(f.requests).toHaveLength(4);
    expect(f.peak()).toBe(2);
  });

  it("closes late-initializing clients without dispatching after the deadline", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const f = fixture(undefined, { timeoutMs: 50, factoryGate: gate.promise });
    const result = f.service.query({});
    await vi.advanceTimersByTimeAsync(51);
    expect((await result).status).toBe("partial");
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.requests).toHaveLength(0);
    expect(f.close).toHaveBeenCalledTimes(1);
  });
});

describe("CPU query boundaries", () => {
  it("filters by account and rejects unknown accounts, fields and malformed input", async () => {
    const f = fixture([account("one"), account("two")]);
    expect((await f.service.query({ accountId: "two" })).rows.map((r) => r.accountId)).toEqual([
      "two",
    ]);
    for (const input of [
      null,
      [],
      "one",
      { accountId: 1 },
      { accountId: "\u0000" },
      { accountId: "x".repeat(201) },
      { startTime: "2026-01-01" },
      JSON.parse('{"__proto__":"other"}'),
    ]) {
      await expect(f.service.query(input)).rejects.toMatchObject({ code: "INVALID_CPU_QUERY" });
    }
    await expect(f.service.query({ accountId: "missing" })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
  });

  it("rejects oversized scope before decrypting credentials", async () => {
    const f = fixture(Array.from({ length: 21 }, (_, index) => account(`account${index}`)));
    await expect(f.service.query({})).rejects.toMatchObject({ code: "CPU_SCOPE_TOO_LARGE" });
    expect(f.access).not.toHaveBeenCalled();
    const a = account();
    const many = fixture([a], {
      items: Array.from({ length: 201 }, (_, index) => instance(a, `instance${index}`)),
    });
    await expect(many.service.query({})).rejects.toMatchObject({ code: "CPU_SCOPE_TOO_LARGE" });
    expect(many.factory).not.toHaveBeenCalled();
  });

  it("rejects credential identity mismatch and does not dispatch out-of-scope or malformed targets", async () => {
    const f = fixture();
    const original = f.access.getMockImplementation()!;
    f.access.mockImplementation((name) => {
      const value = original(name);
      value.credentials.tenancyId = id("tenancy", "other");
      return value;
    });
    await expect(f.service.query({})).rejects.toMatchObject({ code: "CPU_SCOPE_MISMATCH" });
    const invalid = fixture([account()], {
      items: [
        instance(account(), "bad", "uk-london-1"),
        { ...instance(account(), "other"), id: 'invalid"}.mean()' },
      ],
    });
    expect((await invalid.service.query({})).status).toBe("partial");
    expect(invalid.factory).not.toHaveBeenCalled();
  });

  it("returns labeled demo samples without accessing any real account, credential or SDK source", async () => {
    const forbidden = vi.fn(() => {
      throw new Error("Real source must not be touched");
    });
    const options: CpuServiceOptions = {
      demo: () => true,
      now: () => NOW,
      accounts: forbidden,
      instances: forbidden,
      access: forbidden,
      isCurrent: forbidden,
      clientFactory: forbidden,
    };
    const report = await createCpuService(options).query({}, true);
    expect(report.source).toBe("demo");
    expect(report.points).toHaveLength(24);
    expect(report.rows.length).toBeGreaterThan(0);
    expect(report.warnings.join(" ")).toContain("演示样本");
    expect(forbidden).not.toHaveBeenCalled();
  });
});
