import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import type { CostAccountData, CostRow, TrafficAccountData } from "@/lib/analytics-contracts";
import { createAnalyticsService, type AnalyticsServiceOptions } from "@/server/analytics/service";
import { aggregateCostRows } from "@/server/analytics/costs";
import { CloudError } from "@/server/oci/types";

const NOW = Date.parse("2026-11-07T12:30:00Z");
const account = (id: string, tenancy = id): AccountSummary => ({
  id,
  name: id,
  tenancyId: `ocid1.tenancy.oc1..${tenancy}`,
  userId: `ocid1.user.oc1..${id}`,
  fingerprint: "fixture",
  homeRegion: "ap-tokyo-1",
  regions: ["ap-tokyo-1"],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00Z",
});
const instance = (a: AccountSummary): InstanceSummary => ({
  id: `ocid1.instance.oc1.ap-tokyo-1.${a.id}`,
  accountId: a.id,
  accountName: a.name,
  displayName: a.id,
  region: "ap-tokyo-1",
  availabilityDomain: "AD-1",
  compartmentId: a.tenancyId,
  state: "RUNNING",
  shape: "shape",
  ocpus: 1,
  memoryGb: 1,
  os: "Linux",
  createdAt: "2026-01-01T00:00:00Z",
  vnics: [
    {
      id: `ocid1.vnic.oc1.ap-tokyo-1.${a.id}`,
      name: "Primary",
      primary: true,
      subnetId: "subnet",
      nsgIds: [],
      privateIps: [],
      ipv6: [],
    },
  ],
  bootVolumes: [],
  tags: {},
  syncedAt: "2026-11-07T12:00:00Z",
});
const range = { startDate: "2026-11-01", endDate: "2026-11-06", granularity: "daily" };
function cost(a: AccountSummary, currency = "EUR", amount: string | null = "0.1"): CostAccountData {
  const rows: CostRow[] = [
    {
      accountId: a.id,
      accountName: a.name,
      tenancyId: a.tenancyId,
      timestamp: "2026-11-01T00:00:00.000Z",
      service: "Compute",
      region: "ap-tokyo-1",
      resourceId: instance(a).id,
      resourceName: null,
      currency,
      amount,
    },
  ];
  return {
    rows,
    ...aggregateCostRows(rows),
    status: amount === null ? "partial" : "ok",
    warnings: [],
  };
}
function traffic(a: AccountSummary): TrafficAccountData {
  return {
    points: [{ timestamp: "2026-11-01T00:00:00.000Z", receivedBytes: 10, sentBytes: 20 }],
    rows: [
      {
        instanceId: instance(a).id,
        instanceName: a.name,
        accountId: a.id,
        accountName: a.name,
        region: "ap-tokyo-1",
        vnicId: instance(a).vnics[0].id,
        vnicName: "Primary",
        receivedBytes: 10,
        sentBytes: 20,
        coverage: "complete",
      },
    ],
    status: "ok",
    warnings: [],
    dataThrough: "2026-11-07T12:00:00.000Z",
  };
}
function fixture(
  initial = [account("one")],
  options: Pick<
    AnalyticsServiceOptions,
    "timeoutMs" | "instances" | "isCurrent" | "snapshots"
  > = {},
) {
  let clock = NOW;
  let revision = 0;
  let available = initial;
  const costRead = vi.fn<NonNullable<AnalyticsServiceOptions["costs"]>["read"]>(
    async (_credentials, a) => cost(a),
  );
  const trafficRead = vi.fn<NonNullable<AnalyticsServiceOptions["traffic"]>["read"]>(
    async (_credentials, items) =>
      items.length
        ? traffic(available.find((a) => a.id === items[0].accountId)!)
        : ({ points: [], rows: [], status: "empty", warnings: [] } as TrafficAccountData),
  );
  const service = createAnalyticsService({
    accounts: () => available,
    instances: options.instances ?? (() => available.map(instance)),
    access: (id) => ({
      revision,
      credentials: {
        tenancyId: available.find((a) => a.id === id)!.tenancyId,
        userId: "user",
        fingerprint: "fixture",
        privateKey: "fixture-only",
        region: "ap-tokyo-1",
      },
    }),
    isCurrent:
      options.isCurrent ?? ((id, r) => available.some((a) => a.id === id) && revision === r),
    now: () => clock,
    costs: { read: costRead },
    traffic: { read: trafficRead },
    timeoutMs: options.timeoutMs,
    snapshots: options.snapshots,
  });
  return {
    service,
    costRead,
    trafficRead,
    advance: (ms: number) => {
      clock += ms;
    },
    changeRevision: () => {
      revision++;
    },
    removeAll: () => {
      available = [];
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("analytics report orchestration", () => {
  it("does not round cross-account traffic totals beyond safe integer precision", async () => {
    const f = fixture([account("one"), account("two")]);
    f.trafficRead.mockImplementation(async (_credentials, items) => {
      const data = traffic(account(items[0].accountId));
      data.points[0].receivedBytes = Number.MAX_SAFE_INTEGER;
      data.rows[0].receivedBytes = Number.MAX_SAFE_INTEGER;
      return data;
    });
    const result = await f.service.traffic(range);
    expect(result.status).toBe("partial");
    expect(result.totals.receivedBytes).toBeNull();
    expect(result.points[0].receivedBytes).toBeNull();
  });
  it("uses five-minute traffic cache, then refreshes; manual refresh is briefly coalesced", async () => {
    const f = fixture();
    const first = await f.service.traffic(range);
    expect(first.totals).toEqual({ receivedBytes: 10, sentBytes: 20, totalBytes: 30 });
    expect((await f.service.traffic(range)).cached).toBe(true);
    expect((await f.service.traffic(range, true)).cached).toBe(true);
    f.advance(2001);
    await f.service.traffic(range, true);
    expect(f.trafficRead).toHaveBeenCalledTimes(2);
    f.advance(5 * 60000 + 1);
    await f.service.traffic(range);
    expect(f.trafficRead).toHaveBeenCalledTimes(3);
  });
  it("uses one-hour cost cache and isolates caller mutations", async () => {
    const f = fixture();
    const first = await f.service.costs(range);
    first.rows[0].amount = "999";
    expect((await f.service.costs(range)).rows[0].amount).toBe("0.1");
    f.advance(3600001);
    await f.service.costs(range);
    expect(f.costRead).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent queries including manual refresh", async () => {
    const f = fixture();
    let release!: (value: CostAccountData) => void;
    f.costRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const a = f.service.costs(range),
      b = f.service.costs(range, true);
    await vi.waitFor(() => expect(f.costRead).toHaveBeenCalledTimes(1));
    release(cost(account("one")));
    await Promise.all([a, b]);
    expect(f.costRead).toHaveBeenCalledTimes(1);
  });
  it("rejects a result when the account revision changes while OCI is reading", async () => {
    const f = fixture();
    let release!: (value: CostAccountData) => void;
    f.costRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = f.service.costs(range);
    await vi.waitFor(() => expect(f.costRead).toHaveBeenCalledTimes(1));
    f.changeRevision();
    release(cost(account("one")));
    await expect(pending).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await f.service.costs(range);
    expect(f.costRead).toHaveBeenCalledTimes(2);
  });
  it("invalidates cached queries after credential changes and rejects removed accounts", async () => {
    const f = fixture();
    await f.service.costs({ ...range, accountId: "one" });
    f.changeRevision();
    await f.service.costs({ ...range, accountId: "one" });
    expect(f.costRead).toHaveBeenCalledTimes(2);
    f.removeAll();
    await expect(f.service.costs({ ...range, accountId: "one" })).rejects.toMatchObject({
      status: 404,
    });
  });
  it("deduplicates a tenancy and never combines different currencies", async () => {
    const f = fixture([
      account("one", "shared"),
      account("two", "shared"),
      account("three", "other"),
    ]);
    f.costRead.mockImplementation(async (_credentials, a) =>
      cost(a, a.id === "three" ? "USD" : "EUR", "0.1"),
    );
    const result = await f.service.costs(range);
    expect(f.costRead).toHaveBeenCalledTimes(2);
    expect(result.totals).toEqual([
      { currency: "EUR", amount: "0.1" },
      { currency: "USD", amount: "0.1" },
    ]);
    expect(result.accounts.filter((a) => a.status === "duplicate")).toHaveLength(1);
  });
  it("keeps a partially failed account visible without fabricating a full cost total", async () => {
    const f = fixture([account("one"), account("two")]);
    f.costRead.mockImplementation(async (_credentials, a) => {
      if (a.id === "two") throw new Error("Authorization: sensitive-header");
      return cost(a);
    });
    const result = await f.service.costs(range);
    expect(result.status).toBe("partial");
    expect(result.rows).toHaveLength(1);
    expect(result.totals[0].amount).toBeNull();
    expect(JSON.stringify(result)).not.toContain("sensitive-header");
    expect(result.accounts.find((a) => a.accountId === "two")?.status).toBe("error");
  });
  it("distinguishes empty responses, valid zero, and unreadable amounts", async () => {
    const f = fixture();
    f.costRead.mockResolvedValueOnce({
      rows: [],
      points: [],
      totals: [],
      warnings: [],
      status: "empty",
    });
    expect((await f.service.costs(range)).status).toBe("empty");
    f.advance(2001);
    f.costRead.mockResolvedValueOnce(cost(account("one"), "EUR", "0"));
    expect((await f.service.costs(range, true)).totals).toEqual([{ currency: "EUR", amount: "0" }]);
    f.advance(2001);
    f.costRead.mockResolvedValueOnce(cost(account("one"), "EUR", null));
    expect((await f.service.costs(range, true)).totals[0].amount).toBeNull();
  });
  it("validates instance and VNIC scope before contacting OCI", async () => {
    const f = fixture();
    await expect(f.service.traffic({ ...range, instanceId: "other" })).rejects.toMatchObject({
      status: 404,
    });
    await expect(f.service.traffic({ ...range, vnicId: "other" })).rejects.toMatchObject({
      status: 404,
    });
    expect(f.trafficRead).not.toHaveBeenCalled();
  });
  it("marks observed point subtotals as partial when a selected account cannot supply traffic", async () => {
    const f = fixture([account("one"), account("two")]);
    f.trafficRead.mockImplementation(async (_credentials, items) => {
      if (items[0].accountId === "two")
        throw new CloudError("无权读取指标", "NotAuthorizedOrNotFound");
      return traffic(account("one"));
    });
    const result = await f.service.traffic(range);
    expect(result.status).toBe("partial");
    expect(result.totals.totalBytes).toBe(30);
    expect(result.points[0].receivedBytes).toBe(10);
    expect(result.points[0].coverage).toBe("partial");
  });
  it("returns empty reports without credentials or OCI reads when no accounts are saved", async () => {
    const forbidden = vi.fn(() => {
      throw Error("Empty accounts must not access credentials or OCI");
    });
    const service = createAnalyticsService({
      now: () => NOW,
      accounts: () => [],
      instances: () => [],
      access: forbidden,
      isCurrent: forbidden,
      traffic: { read: forbidden },
      costs: { read: forbidden },
    });
    for (const force of [false, true]) {
      const traffic = await service.traffic(range, force);
      expect(traffic).toMatchObject({
        source: "oci",
        status: "empty",
        accounts: [],
        rows: [],
        points: [],
        totals: { receivedBytes: null, sentBytes: null, totalBytes: null },
      });
      expect(await service.costs(range, force)).toMatchObject({
        source: "oci",
        status: "empty",
        accounts: [],
        rows: [],
        points: [],
        totals: [],
      });
    }
    expect(forbidden).not.toHaveBeenCalled();
    await expect(service.traffic({ ...range, accountId: "missing" })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
    await expect(service.costs({ ...range, accountId: "missing" })).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
  });
});

describe("analytics whole-query budgets and current region scope", () => {
  it.each(["costs", "traffic"] as const)(
    "returns completed accounts before the browser deadline for %s",
    async (kind) => {
      vi.useFakeTimers();
      const selected = Array.from({ length: 8 }, (_, i) => account(`account${i}`));
      const f = fixture(selected);
      f.costRead.mockImplementation(async (_credentials, a) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
        return cost(a);
      });
      f.trafficRead.mockImplementation(async (_credentials, items) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20_000));
        return traffic(account(items[0].accountId));
      });
      const pending = f.service[kind](range);
      await vi.advanceTimersByTimeAsync(50_000);
      const result = await pending;
      expect(result.status).toBe("partial");
      expect(result.rows).toHaveLength(4);
      expect(result.accounts.filter((item) => item.status === "ok")).toHaveLength(4);
      expect(result.accounts.filter((item) => item.status === "error")).toHaveLength(4);
      expect(
        result.accounts
          .filter((item) => item.status === "error")
          .every((item) => item.message?.includes("整体时间限制")),
      ).toBe(true);
      expect(kind === "costs" ? f.costRead : f.trafficRead).toHaveBeenCalledTimes(6);
      if (kind === "costs")
        expect(
          (result as import("@/lib/analytics-contracts").CostReport).totals[0].amount,
        ).toBeNull();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(kind === "costs" ? f.costRead : f.trafficRead).toHaveBeenCalledTimes(6);
    },
  );

  it("keeps only two actual account reads after timeout and removes cancelled queue entries", async () => {
    vi.useFakeTimers();
    const f = fixture([account("one"), account("two")], { timeoutMs: 50 });
    const release: (() => void)[] = [];
    f.costRead.mockImplementation(async (_credentials, a) => {
      await new Promise<void>((resolve) => release.push(resolve));
      return cost(a);
    });
    const first = f.service.costs(range);
    await vi.advanceTimersByTimeAsync(51);
    expect((await first).status).toBe("partial");
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(3000);
      const pending = f.service.costs(range, true);
      await vi.advanceTimersByTimeAsync(51);
      expect((await pending).status).toBe("partial");
    }
    expect(f.costRead).toHaveBeenCalledTimes(2);
    release.forEach((resolve) => resolve());
    await vi.advanceTimersByTimeAsync(0);
    f.advance(3000);
    f.costRead.mockImplementation(async (_credentials, a) => cost(a));
    expect((await f.service.costs(range, true)).status).toBe("ok");
    expect(f.costRead).toHaveBeenCalledTimes(4);
  });

  it("cancels only the departing subscriber while another caller shares the same query", async () => {
    const f = fixture();
    let release!: () => void;
    f.costRead.mockImplementation(async (_credentials, a) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return cost(a);
    });
    const controller = new AbortController();
    const first = f.service.costs(range, false, controller.signal);
    const firstRejected = expect(first).rejects.toMatchObject({ code: "ANALYTICS_CANCELLED" });
    const second = f.service.costs(range);
    await vi.waitFor(() => expect(f.costRead).toHaveBeenCalledTimes(1));
    controller.abort();
    await firstRejected;
    const signal = f.costRead.mock.calls[0][4]!;
    expect(signal.aborted).toBe(false);
    release();
    expect((await second).rows).toHaveLength(1);
  });

  it("stops dispatching and avoids caching when every caller cancels", async () => {
    const f = fixture([account("one"), account("two"), account("three")]);
    f.costRead.mockImplementation(async (_credentials, _account, _range, _filters, signal) => {
      if (!signal) throw new Error("Expected shared query signal");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("mock stopped")), { once: true }),
      );
      return cost(account("one"));
    });
    const controller = new AbortController();
    const pending = f.service.costs(range, false, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ANALYTICS_CANCELLED" });
    await vi.waitFor(() => expect(f.costRead).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect(f.costRead).toHaveBeenCalledTimes(2);
    f.costRead.mockImplementation(async (_credentials, a) => cost(a));
    const next = await f.service.costs(range);
    expect(next.cached).toBe(false);
    expect(next.rows).toHaveLength(3);
  });

  it.each(["traffic", "costs"] as const)(
    "avoids database access and snapshot writes after the last %s subscriber leaves",
    async (kind) => {
      const a = account("one");
      let closed = false;
      const assertOpen = () => {
        if (closed) throw new Error("Synthetic database is closed");
      };
      const current = vi.fn(() => {
        assertOpen();
        return true;
      });
      const instances = vi.fn(() => {
        assertOpen();
        return [instance(a)];
      });
      const snapshots = {
        get: vi.fn(() => {
          assertOpen();
          return undefined;
        }),
        set: vi.fn(() => {
          assertOpen();
        }),
      };
      const f = fixture([a], { isCurrent: current, instances, snapshots });
      const first = await f.service[kind](range);
      f.advance(3000);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let readFinished = false;
      if (kind === "costs")
        f.costRead.mockImplementationOnce(async () => {
          await gate;
          readFinished = true;
          return cost(a, "EUR", "999");
        });
      else
        f.trafficRead.mockImplementationOnce(async () => {
          await gate;
          readFinished = true;
          return traffic(a);
        });
      const read = kind === "costs" ? f.costRead : f.trafficRead;
      const controller = new AbortController();
      const pending = f.service[kind](range, true, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: "ANALYTICS_CANCELLED" });
      let before: number[];
      try {
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        before = [
          current.mock.calls.length,
          instances.mock.calls.length,
          snapshots.get.mock.calls.length,
          snapshots.set.mock.calls.length,
        ];
        controller.abort();
        await rejected;
        closed = true;
      } finally {
        release();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(readFinished).toBe(true);
      expect([
        current.mock.calls.length,
        instances.mock.calls.length,
        snapshots.get.mock.calls.length,
        snapshots.set.mock.calls.length,
      ]).toEqual(before!);
      closed = false;
      const cached = await f.service[kind](range);
      expect(cached.cached).toBe(true);
      expect(cached.rows).toEqual(first.rows);
      expect(read).toHaveBeenCalledTimes(2);
      expect(snapshots.set).toHaveBeenCalledTimes(1);
    },
  );

  it("never starts a query for an already-aborted caller", async () => {
    const f = fixture();
    await expect(f.service.costs(range, false, AbortSignal.abort())).rejects.toMatchObject({
      code: "ANALYTICS_CANCELLED",
    });
    expect(f.costRead).not.toHaveBeenCalled();
  });

  it("preserves a valid cached snapshot when the caller abandons a manual refresh", async () => {
    const f = fixture();
    await f.service.costs(range);
    f.advance(3000);
    f.costRead.mockImplementationOnce(async (_credentials, _account, _range, _filters, signal) => {
      if (!signal) throw new Error("Expected shared query signal");
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("mock stopped")), { once: true }),
      );
      return cost(account("one"));
    });
    const controller = new AbortController();
    const pending = f.service.costs(range, true, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: "ANALYTICS_CANCELLED" });
    await vi.waitFor(() => expect(f.costRead).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    expect((await f.service.costs(range)).cached).toBe(true);
    expect(f.costRead).toHaveBeenCalledTimes(2);
  });

  it("excludes stale instances from disabled regions before reads and rejects explicit scope filters", async () => {
    const a = account("one");
    a.regions.push("uk-london-1");
    const stale = { ...instance(a), region: "uk-london-1" };
    const f = fixture([a], { instances: () => [stale] });
    await f.service.traffic(range);
    expect(f.trafficRead.mock.calls[0][1]).toHaveLength(1);
    a.regions = [a.homeRegion];
    f.changeRevision();
    const result = await f.service.traffic(range);
    expect(result.rows).toHaveLength(0);
    expect(f.trafficRead.mock.calls[1][1]).toHaveLength(0);
    for (const filter of [
      { region: "uk-london-1" },
      { instanceId: stale.id },
      { vnicId: stale.vnics[0].id },
    ])
      await expect(f.service.traffic({ ...range, ...filter })).rejects.toMatchObject({
        status: filter.region ? 400 : 404,
      });
    expect(f.trafficRead).toHaveBeenCalledTimes(2);
  });
});
