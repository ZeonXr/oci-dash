import { describe, expect, it, vi } from "vitest";
import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import type { CostAccountData, CostRow, TrafficAccountData } from "@/lib/analytics-contracts";
import { createAnalyticsService } from "@/server/analytics/service";
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
function fixture(initial = [account("one")]) {
  let clock = NOW;
  let revision = 0;
  let available = initial;
  const costRead = vi.fn(async (_credentials, a: AccountSummary) => cost(a));
  const trafficRead = vi.fn(async (_credentials, items: InstanceSummary[]) =>
    items.length
      ? traffic(available.find((a) => a.id === items[0].accountId)!)
      : ({ points: [], rows: [], status: "empty", warnings: [] } as TrafficAccountData),
  );
  const service = createAnalyticsService({
    accounts: () => available,
    instances: () => available.map(instance),
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
    isCurrent: (id, r) => available.some((a) => a.id === id) && revision === r,
    now: () => clock,
    demo: () => false,
    costs: { read: costRead },
    traffic: { read: trafficRead },
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
  it("serves demo reports without reading stored accounts or invoking either SDK", async () => {
    const forbidden = () => {
      throw Error("Real credentials must not be accessed");
    };
    const service = createAnalyticsService({
      demo: () => true,
      now: () => NOW,
      accounts: forbidden,
      instances: forbidden,
      access: forbidden,
    });
    expect((await service.traffic(range, true)).source).toBe("demo");
    expect((await service.costs(range, true)).source).toBe("demo");
  });
});
