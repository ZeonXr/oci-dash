import type { requests } from "oci-usageapi";
import type { AccountSummary } from "@/lib/contracts";
import type {
  AnalyticsRange,
  CostAccountData,
  CostPoint,
  CostRow,
  CostTotal,
} from "@/lib/analytics-contracts";
import { cloudError, errorStatus, type ClientPort, type CloudDocument } from "../oci/sdk";
import { CloudError, type OciCredentials } from "../oci/types";
import { normalizeDecimal, sumDecimalAmounts } from "@/lib/decimal";

export type UsageClientFactory = (
  credentials: OciCredentials,
  region: string,
  signal?: AbortSignal,
) => ClientPort | Promise<ClientPort>;
export interface CostReaderOptions {
  clientFactory?: UsageClientFactory;
  now?: () => Date;
  /** Includes client acquisition and every page; injectable for offline deadline tests. */
  timeoutMs?: number;
}
export interface CostFilters {
  region?: string;
  service?: string;
}
const PAGE_SIZE = 1_000,
  MAX_PAGES = 100,
  MAX_ROWS = 100_000;

const defaultUsageClientFactory: UsageClientFactory = async (credentials, region, signal) => {
  const [common, usage] = await Promise.all([import("oci-common"), import("oci-usageapi")]);
  const selectedRegion = common.Region.fromRegionId(region);
  const provider = new common.SimpleAuthenticationDetailsProvider(
    credentials.tenancyId,
    credentials.userId,
    credentials.fingerprint,
    credentials.privateKey,
    null,
    selectedRegion,
  );
  const client = new usage.UsageapiClient(
    { authenticationDetailsProvider: provider },
    {
      retryConfiguration: common.NoRetryConfigurationDetails,
      httpOptions: {
        get signal() {
          const rpc = AbortSignal.timeout(30_000);
          return signal ? AbortSignal.any([signal, rpc]) : rpc;
        },
      },
    },
  );
  client.region = selectedRegion;
  return {
    async call(operation, request) {
      if (operation !== "requestSummarizedUsages")
        throw new CloudError("不支持的费用查询操作", "COST_OPERATION_UNSUPPORTED");
      return await client.requestSummarizedUsages({
        ...request,
        retryConfiguration: common.NoRetryConfigurationDetails,
      } as requests.RequestSummarizedUsagesRequest);
    },
    close() {
      client.close();
    },
  };
};

/** Strip SDK request/response bodies even when a boundary throws an Error named CloudError. */
async function safeCall<T>(call: () => T | Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const value = error as {
      code?: unknown;
      serviceCode?: unknown;
      name?: unknown;
      message?: unknown;
      opcRequestId?: unknown;
    } | null;
    throw cloudError(
      {
        code: value?.code,
        serviceCode: value?.serviceCode,
        statusCode: errorStatus(error),
        name: value?.name,
        message: value?.message,
        opcRequestId: value?.opcRequestId,
      },
      "OCI 费用查询失败",
    );
  }
}
const deadlineError = () =>
  new CloudError("费用查询超过时间上限，请缩短范围后重试", "COST_QUERY_TIMEOUT", true);
async function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    throw deadlineError();
  }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(deadlineError());
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function timestamp(value: unknown): string | null {
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** The caller must flag missing pages/accounts: those cannot be inferred from retained rows. */
export function aggregateCostRows(
  rows: readonly CostRow[],
  options: { incomplete?: boolean } = {},
): { totals: CostTotal[]; points: CostPoint[] } {
  const amounts = new Map<string | null, (string | null)[]>();
  const buckets = new Map<
    string,
    { timestamp: string; currency: string | null; amounts: (string | null)[] }
  >();
  const incomplete = options.incomplete || rows.some((row) => row.currency === null);
  for (const row of rows) {
    const values = amounts.get(row.currency) ?? [];
    values.push(row.amount);
    amounts.set(row.currency, values);
    const key = JSON.stringify([row.timestamp, row.currency]);
    const bucket = buckets.get(key) ?? {
      timestamp: row.timestamp,
      currency: row.currency,
      amounts: [],
    };
    bucket.amounts.push(row.amount);
    buckets.set(key, bucket);
  }
  const totals = [...amounts].map(([currency, values]) => ({
    currency,
    amount: incomplete ? null : sumDecimalAmounts(values),
  }));
  const points = [...buckets.values()].map((bucket) => ({
    timestamp: bucket.timestamp,
    currency: bucket.currency,
    amount: incomplete ? null : sumDecimalAmounts(bucket.amounts),
  }));
  totals.sort((a, b) => (a.currency ?? "").localeCompare(b.currency ?? ""));
  points.sort(
    (a, b) =>
      a.timestamp.localeCompare(b.timestamp) || (a.currency ?? "").localeCompare(b.currency ?? ""),
  );
  return { totals, points };
}

/** A query is scoped by tenancy. Its service endpoint region is separate from a billing-region filter. */
export function createCostReader({
  clientFactory = defaultUsageClientFactory,
  now = () => new Date(),
  timeoutMs = 45_000,
}: CostReaderOptions = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Cost query timeout must be positive");
  return {
    async read(
      credentials: OciCredentials,
      account: AccountSummary,
      range: AnalyticsRange,
      filters: CostFilters = {},
    ): Promise<CostAccountData> {
      if (credentials.tenancyId !== account.tenancyId || credentials.userId !== account.userId)
        throw new CloudError("费用查询凭据与账号不一致", "COST_SCOPE_MISMATCH");
      const start = Date.parse(range.startTime),
        end = Date.parse(range.endTime);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        range.timeZone !== "UTC" ||
        !["hourly", "daily", "monthly"].includes(range.granularity)
      )
        throw new CloudError("费用查询时间范围无效", "COST_INVALID_RANGE");
      const dimensions: { key: string; value: string }[] = [];
      for (const key of ["region", "service"] as const) {
        const value = filters[key];
        if (value !== undefined) {
          if (typeof value !== "string" || !value.trim() || value.length > 256)
            throw new CloudError("费用查询筛选条件无效", "COST_INVALID_FILTER");
          dimensions.push({ key, value: value.trim() });
        }
      }
      const details: CloudDocument = {
        tenantId: credentials.tenancyId,
        timeUsageStarted: new Date(start),
        timeUsageEnded: new Date(end),
        granularity: range.granularity.toUpperCase(),
        queryType: "COST",
        isAggregateByTime: false,
        groupBy: ["currency", "service", "region", "resourceId"],
        ...(dimensions.length ? { filter: { operator: "AND", dimensions } } : {}),
      };
      const warnings = new Set<string>(),
        rows: CostRow[] = [];
      let incomplete = false,
        invalidCurrency = false,
        missingAmount = false;
      let scannedRows = 0;
      let client: ClientPort | undefined, page: string | undefined;
      const visited = new Set<string>();
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), timeoutMs);
      timer.unref();
      let clientClosed = false;
      const closeClient = (target: ClientPort) => {
        if (clientClosed) return Promise.resolve();
        clientClosed = true;
        return Promise.resolve()
          .then(() => target.close())
          .catch(() => undefined);
      };
      try {
        const acquiring = safeCall(() =>
          clientFactory(credentials, credentials.region, budget.signal),
        );
        void acquiring
          .then((lateClient) => {
            if (budget.signal.aborted) void closeClient(lateClient);
          })
          .catch(() => undefined);
        client = await beforeDeadline(acquiring, budget.signal);
        for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
          if (budget.signal.aborted) throw deadlineError();
          const response = await beforeDeadline(
            safeCall(() =>
              client!.call("requestSummarizedUsages", {
                requestSummarizedUsagesDetails: details,
                limit: PAGE_SIZE,
                ...(page ? { page } : {}),
              }),
            ),
            budget.signal,
          );
          if (!response || !Array.isArray(response.usageAggregation?.items))
            throw new CloudError("OCI 费用响应缺少有效数据列表", "COST_INVALID_RESPONSE");
          const next = response.opcNextPage;
          if (next !== null && next !== undefined && typeof next !== "string")
            throw new CloudError("OCI 费用响应包含无效分页标记", "COST_INVALID_RESPONSE");
          const nextPage = typeof next === "string" ? next.trim() || undefined : undefined;
          if (nextPage && (visited.has(nextPage) || nextPage.length > 4096)) {
            incomplete = true;
            warnings.add("费用分页标记异常，结果不完整，请稍后重试。");
            break;
          }
          for (const item of response.usageAggregation.items as unknown[]) {
            if (scannedRows >= MAX_ROWS) {
              incomplete = true;
              warnings.add("费用明细达到查询上限，请缩短时间范围或增加筛选条件。");
              break;
            }
            scannedRows++;
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              incomplete = true;
              warnings.add("部分费用记录格式不正确，无法完整统计。");
              continue;
            }
            const source = item as Record<string, unknown>;
            const time = timestamp(source.timeUsageStarted);
            if (
              !time ||
              Date.parse(time) < start ||
              Date.parse(time) >= end ||
              source.isForecast === true
            ) {
              incomplete = true;
              warnings.add("部分费用记录不属于所选实际费用时间范围，已排除。");
              continue;
            }
            const region = text(source.region),
              service = text(source.service);
            if (
              dimensions.some(
                (dimension) => (dimension.key === "region" ? region : service) !== dimension.value,
              )
            ) {
              incomplete = true;
              warnings.add("OCI 返回了不符合筛选条件的费用记录，已排除。");
              continue;
            }
            const rawCurrency = text(source.currency);
            const currency =
              rawCurrency && /^[a-z]{3}$/i.test(rawCurrency) ? rawCurrency.toUpperCase() : null;
            const amount = normalizeDecimal(source.computedAmount);
            if (!currency) {
              invalidCurrency = true;
              warnings.add("部分费用记录缺少有效币种，无法确认完整金额合计。");
            }
            if (amount === null) {
              missingAmount = true;
              warnings.add("部分费用金额缺失或精度无法确认，未按零费用处理。");
            }
            rows.push({
              accountId: account.id,
              accountName: account.name,
              tenancyId: credentials.tenancyId,
              timestamp: time,
              service,
              region,
              resourceId: text(source.resourceId),
              resourceName: text(source.resourceName),
              currency,
              amount,
            });
          }
          if (!nextPage || scannedRows >= MAX_ROWS) {
            if (nextPage) {
              incomplete = true;
              warnings.add("费用明细达到查询上限，请缩短时间范围或增加筛选条件。");
            }
            break;
          }
          if (pageNumber + 1 === MAX_PAGES) {
            incomplete = true;
            warnings.add("费用分页达到查询上限，请缩短时间范围或增加筛选条件。");
          }
          visited.add(nextPage);
          page = nextPage;
        }
      } finally {
        try {
          if (client)
            await beforeDeadline(closeClient(client), budget.signal).catch(() => undefined);
        } finally {
          clearTimeout(timer);
        }
      }
      rows.sort(
        (left, right) =>
          left.timestamp.localeCompare(right.timestamp) ||
          (left.currency ?? "").localeCompare(right.currency ?? "") ||
          (left.service ?? "").localeCompare(right.service ?? "") ||
          (left.resourceId ?? "").localeCompare(right.resourceId ?? ""),
      );
      if (end > now().getTime() - 48 * 60 * 60_000)
        warnings.add("OCI 费用数据可能延迟最多 48 小时，最近两日金额仍可能更新。");
      return {
        rows,
        ...aggregateCostRows(rows, { incomplete }),
        warnings: [...warnings],
        status:
          incomplete || invalidCurrency || missingAmount ? "partial" : rows.length ? "ok" : "empty",
      };
    },
  };
}
