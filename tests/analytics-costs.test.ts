import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/lib/contracts";
import type { AnalyticsRange, CostRow } from "@/lib/analytics-contracts";
import { normalizeDecimal, sumDecimalAmounts } from "@/lib/decimal";
import { aggregateCostRows, createCostReader } from "@/server/analytics/costs";
import type { ClientPort, CloudDocument } from "@/server/oci/sdk";
import { CloudError, type OciCredentials } from "@/server/oci/types";

const credentials: OciCredentials = {
  tenancyId: "tenancy-test",
  userId: "oci-user-test",
  fingerprint: "test-fingerprint",
  privateKey: "SYNTHETIC_PRIVATE_KEY_NEVER_RETURN",
  region: "us-phoenix-1",
};
const account: AccountSummary = {
  id: "account-a",
  name: "Test account",
  tenancyId: credentials.tenancyId,
  userId: credentials.userId,
  fingerprint: credentials.fingerprint,
  homeRegion: credentials.region,
  regions: [credentials.region],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const range: AnalyticsRange = {
  startTime: "2026-11-01T00:00:00.000Z",
  endTime: "2026-11-04T00:00:00.000Z",
  startDate: "2026-11-01",
  endDate: "2026-11-03",
  granularity: "daily",
  timeZone: "UTC",
};
const item = (overrides: CloudDocument = {}) => ({
  timeUsageStarted: new Date("2026-11-01T00:00:00.000Z"),
  timeUsageEnded: new Date("2026-11-02T00:00:00.000Z"),
  currency: "USD",
  computedAmount: 0.1,
  service: "COMPUTE",
  region: "us-phoenix-1",
  resourceId: "ocid1.instance.test",
  resourceName: "Node A",
  ...overrides,
});
const page = (items: unknown[], next?: string | null): CloudDocument => ({
  usageAggregation: { items },
  ...(next !== undefined ? { opcNextPage: next } : {}),
});
function fixture(pages: CloudDocument[] = [page([item()])]) {
  let index = 0;
  const call = vi.fn<ClientPort["call"]>(async () => pages[index++]);
  const close = vi.fn(async () => {});
  const clientFactory = vi.fn(() => ({ call, close }));
  const reader = createCostReader({
    clientFactory,
    now: () => new Date("2026-11-07T00:00:00.000Z"),
  });
  return { reader, call, close, clientFactory };
}

afterEach(() => vi.useRealTimers());

describe("decimal cost arithmetic", () => {
  it.each([
    ["001.23000", "1.23"],
    ["-0.000", "0"],
    ["1e-7", "0.0000001"],
    ["12.50e2", "1250"],
    [".5", "0.5"],
    ["-5.2E-3", "-0.0052"],
  ])("normalizes %s without exponent notation", (value, normalized) => {
    expect(normalizeDecimal(value)).toBe(normalized);
  });
  it("sums decimals exactly across signs, scales and large string amounts", () => {
    expect(sumDecimalAmounts([0.1, 0.2, "-0.05"])).toBe("0.25");
    expect(sumDecimalAmounts(["999999999999999999.999999999999", "0.000000000001"])).toBe(
      "1000000000000000000",
    );
    expect(sumDecimalAmounts(["1e-7", "2e-7"])).toBe("0.0000003");
    expect(sumDecimalAmounts(["10", "-10"])).toBe("0");
  });
  it("keeps absent or unsafe numeric amounts unknown", () => {
    for (const value of [
      undefined,
      null,
      "",
      " ",
      "NaN",
      Infinity,
      NaN,
      true,
      {},
      "1e99999",
      Number.MAX_SAFE_INTEGER + 1,
    ])
      expect(normalizeDecimal(value)).toBeNull();
    expect(sumDecimalAmounts([])).toBeNull();
    expect(sumDecimalAmounts(["1", null, "2"])).toBeNull();
    expect(sumDecimalAmounts(["0", "0.0"])).toBe("0");
  });
});

describe("read-only OCI cost reader", () => {
  it("uses the Usage API nested response, all pages and exactly four grouping dimensions", async () => {
    const f = fixture([
      page([item({ computedAmount: 0.1 })], "next-page"),
      page([item({ computedAmount: 0.2, resourceId: "ocid1.instance.other" })], null),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(result.status).toBe("ok");
    expect(result.rows).toHaveLength(2);
    expect(result.totals).toEqual([{ currency: "USD", amount: "0.3" }]);
    expect(result.points).toEqual([{ timestamp: range.startTime, currency: "USD", amount: "0.3" }]);
    expect(f.clientFactory).toHaveBeenCalledWith(
      credentials,
      "us-phoenix-1",
      expect.any(AbortSignal),
    );
    expect(f.call.mock.calls[0]).toEqual([
      "requestSummarizedUsages",
      {
        limit: 1000,
        requestSummarizedUsagesDetails: {
          tenantId: credentials.tenancyId,
          timeUsageStarted: new Date(range.startTime),
          timeUsageEnded: new Date(range.endTime),
          granularity: "DAILY",
          queryType: "COST",
          isAggregateByTime: false,
          groupBy: ["currency", "service", "region", "resourceId"],
        },
      },
    ]);
    expect(f.call.mock.calls[1][1].page).toBe("next-page");
    expect(f.call.mock.calls[1][1].requestSummarizedUsagesDetails).toEqual(
      f.call.mock.calls[0][1].requestSummarizedUsagesDetails,
    );
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("does not confuse the billing region filter with the service endpoint region", async () => {
    const f = fixture([page([item({ region: "uk-london-1", service: "BLOCK_STORAGE" })])]);
    const result = await f.reader.read(credentials, account, range, {
      region: "uk-london-1",
      service: "BLOCK_STORAGE",
    });
    expect(result.rows).toHaveLength(1);
    expect(f.clientFactory).toHaveBeenCalledWith(
      credentials,
      "us-phoenix-1",
      expect.any(AbortSignal),
    );
    expect(f.call.mock.calls[0][1].requestSummarizedUsagesDetails.filter).toEqual({
      operator: "AND",
      dimensions: [
        { key: "region", value: "uk-london-1" },
        { key: "service", value: "BLOCK_STORAGE" },
      ],
    });
  });

  it("separates currencies, retains signed adjustments and ignores attributed cost", async () => {
    const f = fixture([
      page([
        item({ currency: "SGD", computedAmount: "2.30" }),
        item({ currency: " USD ", computedAmount: "0.10", attributedCost: "999999" }),
        item({
          currency: "USD",
          computedAmount: "-0.02",
          timeUsageStarted: "2026-11-02T00:00:00Z",
        }),
      ]),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(result.totals).toEqual([
      { currency: "SGD", amount: "2.3" },
      { currency: "USD", amount: "0.08" },
    ]);
    expect(result.points).toHaveLength(3);
    expect(
      result.rows.every(
        (row) => row.accountId === account.id && row.tenancyId === account.tenancyId,
      ),
    ).toBe(true);
  });

  it("distinguishes a confirmed zero from empty data and a missing amount", async () => {
    const zero = await fixture([page([item({ computedAmount: 0 })])]).reader.read(
      credentials,
      account,
      range,
    );
    expect(zero).toMatchObject({ status: "ok", totals: [{ currency: "USD", amount: "0" }] });
    const empty = await fixture([page([])]).reader.read(credentials, account, range);
    expect(empty).toMatchObject({ status: "empty", rows: [], totals: [], points: [] });
    const missing = await fixture([
      page([item({ computedAmount: null }), item({ computedAmount: "10", currency: "SGD" })]),
    ]).reader.read(credentials, account, range);
    expect(missing.status).toBe("partial");
    expect(missing.totals).toEqual([
      { currency: "SGD", amount: "10" },
      { currency: "USD", amount: null },
    ]);
    expect(missing.rows.find((row) => row.currency === "USD")?.amount).toBeNull();
  });

  it("never invents USD or merges unknown currency amounts into known currency totals", async () => {
    const f = fixture([
      page([
        item({ currency: "   ", computedAmount: "7" }),
        item({ currency: "EUR", computedAmount: "3" }),
      ]),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(result.status).toBe("partial");
    expect(result.rows[0].currency).toBeNull();
    expect(result.rows[0].amount).toBe("7");
    expect(result.totals).toEqual([
      { currency: null, amount: null },
      { currency: "EUR", amount: null },
    ]);
    expect(JSON.stringify(result)).not.toContain("USD");
  });

  it("preserves unassigned or deleted-resource charges without guessing inventory names", async () => {
    const f = fixture([
      page([
        item({ resourceId: null, resourceName: undefined, computedAmount: "1.50" }),
        item({
          resourceId: "ocid1.bootvolume.deleted",
          resourceName: null,
          computedAmount: "2.50",
          privateKey: credentials.privateKey,
        }),
      ]),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(result.totals).toEqual([{ currency: "USD", amount: "4" }]);
    expect(result.rows.some((row) => row.resourceId === null)).toBe(true);
    expect(
      result.rows.find((row) => row.resourceId === "ocid1.bootvolume.deleted")?.resourceName,
    ).toBeNull();
    expect(JSON.stringify(result)).not.toContain(credentials.privateKey);
  });

  it("stops cyclic pagination without counting the repeated page or publishing a complete total", async () => {
    const f = fixture([
      page([item()], "repeated-secret-token"),
      page([item()], "repeated-secret-token"),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(f.call).toHaveBeenCalledTimes(2);
    expect(result.rows).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.totals).toEqual([{ currency: "USD", amount: null }]);
    expect(JSON.stringify(result)).not.toContain("repeated-secret-token");
  });

  it("stops at the page cap even when a server keeps issuing new tokens", async () => {
    const f = fixture();
    let index = 0;
    f.call.mockImplementation(async () => page([item()], `page-${++index}`));
    const result = await f.reader.read(credentials, account, range);
    expect(f.call).toHaveBeenCalledTimes(100);
    expect(result.rows).toHaveLength(100);
    expect(result.status).toBe("partial");
    expect(result.totals[0].amount).toBeNull();
  });

  it("caps raw records as well as accepted rows", async () => {
    const f = fixture([page([item(), ...Array(100_000).fill(null)], "must-not-request")]);
    const result = await f.reader.read(credentials, account, range);
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.totals[0].amount).toBeNull();
  });

  it("rejects a structurally incomplete response instead of treating it as empty", async () => {
    const f = fixture([{ items: [item()] }]);
    await expect(f.reader.read(credentials, account, range)).rejects.toMatchObject({
      code: "COST_INVALID_RESPONSE",
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("excludes invalid timestamps, forecast rows and end-exclusive records", async () => {
    const f = fixture([
      page([
        item(),
        item({ timeUsageStarted: "bad-date" }),
        item({ isForecast: true }),
        item({ timeUsageStarted: range.endTime }),
      ]),
    ]);
    const result = await f.reader.read(credentials, account, range);
    expect(result.rows).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.totals[0].amount).toBeNull();
  });

  it("rejects out-of-filter billing data instead of silently including it", async () => {
    const f = fixture([page([item({ region: "uk-london-1" }), item()])]);
    const result = await f.reader.read(credentials, account, range, { region: "uk-london-1" });
    expect(result.rows).toHaveLength(1);
    expect(result.status).toBe("partial");
    expect(result.totals[0].amount).toBeNull();
  });

  it("keeps authorization failures distinct from free usage and removes raw SDK error material", async () => {
    const f = fixture();
    f.call.mockRejectedValue({
      statusCode: 403,
      serviceCode: "NotAuthorizedOrNotFound",
      message: `SDK request contained ${credentials.privateKey}`,
      request: { authorization: "secret-signature" },
    });
    const error = await f.reader.read(credentials, account, range).catch((value: unknown) => value);
    expect(error).toMatchObject({ name: "CloudError", code: "NotAuthorizedOrNotFound" });
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain(credentials.privateKey);
    expect(String(error)).not.toContain("secret-signature");
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("sanitizes factory errors and even externally supplied CloudError messages", async () => {
    const reader = createCostReader({
      clientFactory: () => {
        throw new CloudError(credentials.privateKey, "PRIVATE_SDK_FAILURE");
      },
    });
    const error = await reader.read(credentials, account, range).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "PRIVATE_SDK_FAILURE" });
    expect(String(error)).not.toContain(credentials.privateKey);
  });

  it("does not return a partially downloaded report after a later page fails", async () => {
    const f = fixture([page([item()], "next")]);
    f.call
      .mockImplementationOnce(async () => page([item()], "next"))
      .mockRejectedValueOnce({
        statusCode: 429,
        code: "TooManyRequests",
        message: "sensitive server body",
      });
    await expect(f.reader.read(credentials, account, range)).rejects.toMatchObject({
      code: "TooManyRequests",
      retryable: true,
    });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it("rejects mixed account credentials before touching the SDK", async () => {
    const f = fixture();
    await expect(
      f.reader.read({ ...credentials, tenancyId: "different-tenancy" }, account, range),
    ).rejects.toMatchObject({ code: "COST_SCOPE_MISMATCH" });
    expect(f.clientFactory).not.toHaveBeenCalled();
  });

  it("warns that recent billing may still change without replacing actual reported zero", async () => {
    const f = fixture([page([item({ computedAmount: 0 })])]);
    const reader = createCostReader({
      clientFactory: f.clientFactory,
      now: () => new Date("2026-11-04T12:00:00Z"),
    });
    const result = await reader.read(credentials, account, range);
    expect(result.totals[0].amount).toBe("0");
    expect(result.warnings.join(" ")).toContain("48");
  });

  it("shares exact cross-account aggregation and propagates missing-account completeness", () => {
    const base: CostRow = {
      accountId: "a",
      accountName: "A",
      tenancyId: "tenancy-a",
      timestamp: range.startTime,
      service: "COMPUTE",
      region: "us-phoenix-1",
      resourceId: null,
      resourceName: null,
      currency: "USD",
      amount: "0.1",
    };
    const rows = [base, { ...base, accountId: "b", tenancyId: "tenancy-b", amount: "0.2" }];
    expect(aggregateCostRows(rows).totals).toEqual([{ currency: "USD", amount: "0.3" }]);
    expect(aggregateCostRows(rows, { incomplete: true }).totals).toEqual([
      { currency: "USD", amount: null },
    ]);
    expect(aggregateCostRows([])).toEqual({ totals: [], points: [] });
  });

  it("shares one deadline across pages and aborts an in-progress RPC without returning a partial report", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let calls = 0,
      signal: AbortSignal | undefined;
    f.call.mockImplementation(async () => {
      const index = ++calls;
      await new Promise((resolve) => setTimeout(resolve, 8));
      return page([item()], `next-${index}`);
    });
    const reader = createCostReader({
      timeoutMs: 20,
      clientFactory: (_credentials, _region, requestSignal) => {
        signal = requestSignal;
        return { call: f.call, close: f.close };
      },
    });
    const reading = reader.read(credentials, account, range);
    const rejected = expect(reading).rejects.toMatchObject({
      code: "COST_QUERY_TIMEOUT",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(f.call).toHaveBeenCalledTimes(3);
    expect(f.close).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.call).toHaveBeenCalledTimes(3);
  });

  it("bounds client acquisition and closes a client that arrives after the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    let resolve!: (client: ClientPort) => void;
    const reader = createCostReader({
      timeoutMs: 10,
      clientFactory: () =>
        new Promise<ClientPort>((done) => {
          resolve = done;
        }),
    });
    const reading = reader.read(credentials, account, range);
    const rejected = expect(reading).rejects.toMatchObject({ code: "COST_QUERY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    resolve({ call: f.call, close: f.close });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.call).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
