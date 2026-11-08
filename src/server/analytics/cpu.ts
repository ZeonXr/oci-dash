import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import type { AnalyticsAccountStatus } from "@/lib/analytics-contracts";
import type { CpuCoverage, CpuHour, CpuInstanceRow, CpuReport } from "@/lib/cpu-contracts";
import { getCredentialSnapshot, listAccounts } from "../accounts";
import { getDatabase } from "../db";
import { AppError } from "../errors";
import { listInstances } from "../inventory";
import { ocid, regionName } from "../oci/helpers";
import { cloudError, errorStatus, type ClientPort, type CloudDocument } from "../oci/sdk";
import type { OciCredentials } from "../oci/types";

const HOUR = 3_600_000;
const SAMPLE = 300_000;
const TTL = 60_000;
const PARTIAL_TTL = 30_000;
const MAX_INSTANCES = 200;
interface Access {
  credentials: OciCredentials;
  revision: number;
}
interface Selection {
  account: AccountSummary;
  access: Access;
}
export type CpuClientFactory = (
  credentials: OciCredentials,
  region: string,
  signal: AbortSignal,
) => ClientPort | Promise<ClientPort>;
export interface CpuServiceOptions {
  accounts?: () => AccountSummary[];
  instances?: () => InstanceSummary[];
  access?: (id: string) => Access;
  isCurrent?: (id: string, revision: number) => boolean;
  now?: () => number;
  clientFactory?: CpuClientFactory;
  timeoutMs?: number;
}

/** Only the Monitoring client is created: no Compute, VNIC or identity RPCs. */
const defaultCpuClientFactory: CpuClientFactory = async (credentials, region, signal) => {
  const [common, monitoring] = await Promise.all([import("oci-common"), import("oci-monitoring")]);
  const selected = common.Region.fromRegionId(region);
  const provider = new common.SimpleAuthenticationDetailsProvider(
    credentials.tenancyId,
    credentials.userId,
    credentials.fingerprint,
    credentials.privateKey,
    null,
    selected,
  );
  const client = new monitoring.MonitoringClient(
    { authenticationDetailsProvider: provider },
    {
      retryConfiguration: common.NoRetryConfigurationDetails,
      httpOptions: {
        get signal() {
          return AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
        },
      },
    },
  );
  client.region = selected;
  return {
    async call(operation, request) {
      if (operation !== "summarizeMetricsData") throw new Error("Unsupported CPU read operation");
      return await client.summarizeMetricsData({
        ...request,
        retryConfiguration: common.NoRetryConfigurationDetails,
      } as Parameters<typeof client.summarizeMetricsData>[0]);
    },
    close: () => client.close(),
  };
};

function accountFilter(input: unknown): string | undefined {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw new AppError("CPU 查询参数必须是文本字段对象", 400, "INVALID_CPU_QUERY");
  for (const key of Reflect.ownKeys(input))
    if (key !== "accountId")
      throw new AppError(
        "CPU 查询仅支持 accountId，时间范围固定为近 24 个完整 UTC 小时",
        400,
        "INVALID_CPU_QUERY",
      );
  const value = (input as { accountId?: unknown }).accountId;
  if (value === undefined) return;
  if (typeof value !== "string" || value.length > 200 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw new AppError("CPU 查询账号不正确", 400, "INVALID_CPU_QUERY");
  return value.trim() || undefined;
}
function stopError() {
  return new Error("CPU query deadline reached");
}
function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(stopError());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(stopError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** Slots remain occupied until the actual RPC settles, even after its caller times out. */
function rpcLimiter() {
  let active = 0;
  const queue: { take: () => void; cancel: () => void }[] = [];
  return async <T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(stopError());
        return;
      }
      const entry = {
        take() {
          signal.removeEventListener("abort", entry.cancel);
          active++;
          resolve();
        },
        cancel() {
          signal.removeEventListener("abort", entry.cancel);
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          reject(stopError());
        },
      };
      if (active < 2) entry.take();
      else {
        queue.push(entry);
        signal.addEventListener("abort", entry.cancel, { once: true });
      }
    });
    try {
      if (signal.aborted) throw stopError();
      return await action();
    } finally {
      active--;
      queue.shift()?.take();
    }
  };
}
function safeFailure(error: unknown): string {
  const status = errorStatus(error),
    code = cloudError(error).code;
  if (status === 401 || status === 403 || code === "NotAuthorizedOrNotFound")
    return "CPU 监控权限不足或资源不可见";
  if (status === 429 || code === "TooManyRequests") return "OCI 监控请求限流";
  if (["OCI_TIMEOUT", "ETIMEDOUT"].includes(code)) return "OCI CPU 指标读取超时";
  return "OCI CPU 指标读取失败";
}
const average = (values: number[]): number | null =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const present = (value: number | null): value is number => value !== null;
function rowFor(
  instance: InstanceSummary,
  start: number,
  observations = new Map<number, number | null>(),
): CpuInstanceRow {
  const points: CpuHour[] = Array.from({ length: 24 }, (_, hour) => {
    const beginning = start + hour * HOUR;
    const values = Array.from(
      { length: 12 },
      (_, sample) => observations.get(beginning + sample * SAMPLE) ?? null,
    ).filter(present);
    return {
      timestamp: new Date(beginning).toISOString(),
      cpuPercent: average(values),
      sampleCount: values.length,
      expectedSamples: 12,
      coverage: values.length === 12 ? "complete" : values.length ? "partial" : "unavailable",
    };
  });
  const values = points.map((point) => point.cpuPercent).filter(present);
  return {
    instanceId: instance.id,
    instanceName: instance.displayName,
    accountId: instance.accountId,
    accountName: instance.accountName,
    region: instance.region,
    state: instance.state,
    points,
    averageCpuPercent: average(values),
    peakCpuPercent: values.length ? Math.max(...values) : null,
    sampleCount: points.reduce((sum, point) => sum + point.sampleCount, 0),
    coverage: points.every((point) => point.coverage === "complete")
      ? "complete"
      : values.length
        ? "partial"
        : "unavailable",
  };
}

function samples(response: CloudDocument, instance: InstanceSummary, start: number, end: number) {
  if (!response || !Array.isArray(response.items)) throw new Error("CPU response missing series");
  const observations = new Map<number, number | null>();
  let malformed = false;
  for (const series of response.items) {
    if (
      series?.namespace !== "oci_computeagent" ||
      series.name !== "CpuUtilization" ||
      series.dimensions?.resourceId !== instance.id ||
      (series.compartmentId != null && series.compartmentId !== instance.compartmentId) ||
      (series.resolution != null && !["5m", "300s"].includes(series.resolution)) ||
      (series.metadata?.unit != null &&
        !["percent", "percentage", "%"].includes(String(series.metadata.unit).toLowerCase())) ||
      !Array.isArray(series.aggregatedDatapoints)
    ) {
      malformed = true;
      continue;
    }
    for (const sample of series.aggregatedDatapoints) {
      const time =
        sample?.timestamp instanceof Date
          ? sample.timestamp.getTime()
          : typeof sample?.timestamp === "string"
            ? Date.parse(sample.timestamp)
            : NaN;
      if (!Number.isFinite(time) || time % SAMPLE !== 0) {
        malformed = true;
        continue;
      }
      // OCI aggregate timestamps mark the interval end. The sample ending at HH:00
      // belongs to the previous hour; the present, incomplete hour is never included.
      const beginning = time - SAMPLE;
      if (beginning < start || time > end) continue;
      const value = sample.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
        observations.set(beginning, null);
        malformed = true;
        continue;
      }
      if (observations.has(beginning) && observations.get(beginning) !== value) {
        observations.set(beginning, null);
        malformed = true;
      } else observations.set(beginning, value);
    }
  }
  return { observations, malformed };
}
function reportFrom(
  rows: CpuInstanceRow[],
  start: number,
  end: number,
  accounts: AnalyticsAccountStatus[],
  warnings: string[],
  timestamp: number,
): CpuReport {
  const points = Array.from({ length: 24 }, (_, hour) => {
    const observed = rows.map((row) => row.points[hour]);
    const values = observed.map((point) => point.cpuPercent).filter(present);
    const coverage: CpuCoverage =
      values.length === 0
        ? "unavailable"
        : values.length === rows.length && observed.every((point) => point.coverage === "complete")
          ? "complete"
          : "partial";
    return {
      timestamp: new Date(start + hour * HOUR).toISOString(),
      cpuPercent: average(values),
      instanceCount: values.length,
      totalInstances: rows.length,
      sampleCount: observed.reduce((sum, point) => sum + point.sampleCount, 0),
      coverage,
    };
  });
  const values = points.map((point) => point.cpuPercent).filter(present);
  const peaks = rows.map((row) => row.peakCpuPercent).filter(present);
  const partial =
    accounts.some((account) => account.status === "error" || account.status === "partial") ||
    (values.length > 0 && rows.some((row) => row.coverage !== "complete"));
  return {
    range: {
      startTime: new Date(start).toISOString(),
      endTime: new Date(end).toISOString(),
      granularity: "hourly",
      timeZone: "UTC",
    },
    rows,
    points,
    summary: {
      averageCpuPercent: average(values),
      peakCpuPercent: peaks.length ? Math.max(...peaks) : null,
      instancesWithSamples: rows.filter((row) => row.sampleCount > 0).length,
      totalInstances: rows.length,
      observedHours: values.length,
      totalSamples: rows.reduce((sum, row) => sum + row.sampleCount, 0),
    },
    status: partial ? "partial" : values.length ? "ok" : "empty",
    accounts,
    warnings,
    generatedAt: new Date(timestamp).toISOString(),
    cacheExpiresAt: new Date(timestamp + (partial ? PARTIAL_TTL : TTL)).toISOString(),
    cached: false,
    source: "oci",
  };
}

export function createCpuService(options: CpuServiceOptions = {}) {
  const accounts = options.accounts ?? listAccounts,
    instances = options.instances ?? listInstances;
  const access = options.access ?? getCredentialSnapshot,
    now = options.now ?? Date.now;
  const current =
    options.isCurrent ??
    ((id: string, revision: number) => {
      const row = getDatabase().prepare("SELECT revision FROM accounts WHERE id=?").get(id) as
        { revision: number } | undefined;
      return row?.revision === revision;
    });
  const factory = options.clientFactory ?? defaultCpuClientFactory;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("CPU deadline must be positive");
  const limited = rpcLimiter();
  const cache = new Map<string, CpuReport>();
  const inflight = new Map<string, Promise<CpuReport>>();
  function assertCurrent(selected: Selection[]) {
    if (selected.some((item) => !current(item.account.id, item.access.revision)))
      throw new AppError("账号配置已变更，请重新查询", 409, "ACCOUNT_CHANGED");
  }
  return {
    async query(input: unknown, force = false): Promise<CpuReport> {
      const accountId = accountFilter(input),
        time = now();
      if (!Number.isFinite(time) || !Number.isFinite(new Date(time).getTime()))
        throw new AppError("CPU 查询时钟无效", 400, "INVALID_CPU_QUERY");
      const end = Math.floor(time / HOUR) * HOUR,
        start = end - 24 * HOUR;
      const matching = accounts().filter((account) => !accountId || account.id === accountId);
      if (accountId && !matching.length) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
      if (matching.length > 20)
        throw new AppError("账号较多，请选择一个账号后查询", 400, "CPU_SCOPE_TOO_LARGE");
      const selected: Selection[] = matching
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((account) => ({ account: structuredClone(account), access: access(account.id) }));
      for (const item of selected)
        if (
          item.access.credentials.tenancyId !== item.account.tenancyId ||
          item.access.credentials.userId !== item.account.userId
        )
          throw new AppError("账号凭据与查询范围不一致", 409, "CPU_SCOPE_MISMATCH");
      const selectedIds = new Set(selected.map((item) => item.account.id));
      const inventory = instances().filter((instance) => selectedIds.has(instance.accountId));
      if (inventory.length > MAX_INSTANCES)
        throw new AppError("实例较多，请选择一个账号后查询", 400, "CPU_SCOPE_TOO_LARGE");
      const seen = new Set<string>(),
        duplicates = new Set<string>();
      const targets: { instance: InstanceSummary; selection: Selection }[] = [];
      for (const selection of selected)
        for (const raw of inventory.filter(
          (instance) => instance.accountId === selection.account.id,
        )) {
          const identity = `${selection.account.tenancyId}/${raw.region}/${raw.id}`;
          if (seen.has(identity)) {
            duplicates.add(selection.account.id);
            continue;
          }
          seen.add(identity);
          targets.push({
            instance: { ...structuredClone(raw), accountName: selection.account.name },
            selection,
          });
        }
      const key = JSON.stringify([
        end,
        selected.map((item) => [
          item.account.id,
          item.account.name,
          item.account.tenancyId,
          item.access.revision,
          item.account.homeRegion,
          item.account.regions,
        ]),
        targets.map(({ instance }) => [
          instance.id,
          instance.displayName,
          instance.accountId,
          instance.region,
          instance.compartmentId,
          instance.state,
        ]),
      ]);
      assertCurrent(selected);
      const pending = inflight.get(key);
      if (pending) {
        const value = await pending;
        assertCurrent(selected);
        return structuredClone(value);
      }
      const cached = cache.get(key);
      if (
        cached &&
        Date.parse(cached.cacheExpiresAt) > now() &&
        (!force || now() - Date.parse(cached.generatedAt) < 2000)
      )
        return { ...structuredClone(cached), cached: true };
      if (inflight.size >= 4)
        throw new AppError("已有 CPU 查询正在执行，请稍后重试", 429, "CPU_BUSY");
      const promise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        timer.unref();
        const rows = targets.map(({ instance }) => rowFor(instance, start));
        const failures = new Set<number>(),
          warnings = new Set<string>();
        let cursor = 0;
        try {
          await Promise.all(
            Array.from({ length: Math.min(2, targets.length) }, async () => {
              while (!controller.signal.aborted && cursor < targets.length) {
                const index = cursor++,
                  { instance, selection } = targets[index];
                try {
                  const id = ocid(instance.id, "instance"),
                    compartment = ocid(instance.compartmentId, ["compartment", "tenancy"]),
                    region = regionName(instance.region);
                  if (
                    region !== selection.account.homeRegion &&
                    !selection.account.regions.includes(region)
                  )
                    throw new Error("Region outside current account scope");
                  const actual = limited(async () => {
                    let client: ClientPort | undefined;
                    try {
                      assertCurrent([selection]);
                      client = await factory(
                        { ...selection.access.credentials, region },
                        region,
                        controller.signal,
                      );
                      if (controller.signal.aborted) throw stopError();
                      assertCurrent([selection]);
                      return await client.call("summarizeMetricsData", {
                        compartmentId: compartment,
                        summarizeMetricsDataDetails: {
                          namespace: "oci_computeagent",
                          query: `CpuUtilization[5m]{resourceId = "${id}"}.mean()`,
                          startTime: new Date(start),
                          endTime: new Date(Math.min(end + 1, time)),
                          resolution: "5m",
                        },
                      });
                    } finally {
                      if (client)
                        await Promise.resolve()
                          .then(() => client!.close())
                          .catch(() => undefined);
                    }
                  }, controller.signal);
                  const response = await bounded(actual, controller.signal);
                  if (controller.signal.aborted) throw stopError();
                  const values = samples(response, instance, start, end);
                  rows[index] = rowFor(instance, start, values.observations);
                  if (values.malformed) {
                    failures.add(index);
                    warnings.add(
                      `${instance.displayName}：部分 CPU 样本或归属信息不正确，已排除。`,
                    );
                  }
                } catch (error) {
                  failures.add(index);
                  warnings.add(
                    `${instance.displayName}：${controller.signal.aborted ? "查询达到整体时间限制，已保留先前取得的数据" : safeFailure(error)}。`,
                  );
                }
              }
            }),
          );
          if (controller.signal.aborted)
            for (let index = cursor; index < targets.length; index++) failures.add(index);
          if (controller.signal.aborted)
            warnings.add("CPU 查询达到整体时间限制，未完成的实例保留为无样本。");
        } finally {
          clearTimeout(timer);
        }
        const statuses: AnalyticsAccountStatus[] = selected.map(({ account }) => {
          const indices = targets.flatMap((target, index) =>
            target.instance.accountId === account.id ? [index] : [],
          );
          const own = indices.map((index) => rows[index]);
          const failed = indices.some((index) => failures.has(index));
          const observed = own.some((row) => row.sampleCount > 0);
          return {
            accountId: account.id,
            accountName: account.name,
            status:
              !indices.length && duplicates.has(account.id)
                ? "duplicate"
                : failed && !observed
                  ? "error"
                  : failed || (observed && own.some((row) => row.coverage !== "complete"))
                    ? "partial"
                    : observed
                      ? "ok"
                      : "empty",
          };
        });
        if (rows.some((row) => row.coverage !== "complete"))
          warnings.add(
            "缺失 CPU 样本保留为空；采集依赖 OCI 监控代理和相应权限，不代表实例离线或零负载。",
          );
        const result = reportFrom(rows, start, end, statuses, [...warnings], now());
        assertCurrent(selected);
        for (const [oldKey, old] of cache)
          if (Date.parse(old.cacheExpiresAt) <= now()) cache.delete(oldKey);
        if (cache.size >= 16) cache.delete(cache.keys().next().value!);
        cache.set(key, structuredClone(result));
        return result;
      })();
      inflight.set(key, promise);
      try {
        return structuredClone(await promise);
      } finally {
        if (inflight.get(key) === promise) inflight.delete(key);
      }
    },
  };
}

export const cpuService = createCpuService();
