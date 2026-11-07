import type {
  AnalyticsRange,
  TrafficAccountData,
  TrafficPoint,
  TrafficRow,
} from "../../lib/analytics-contracts";
import type { InstanceSummary } from "../../lib/contracts";
import { ocid, regionName } from "../oci/helpers";
import {
  closeClients,
  cloudError,
  errorStatus,
  invoke,
  sdkClientFactory,
  type CloudDocument,
  type OciClientFactory,
  type OciClients,
} from "../oci/sdk";
import { CloudError, type OciCredentials } from "../oci/types";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const MAX_RANGE = 90 * DAY;
const INVENTORY_NOTE = "按当前库存中的网卡查询，未包含已分离或删除的网卡；结果不代表完整历史账本。";
type Direction = "receivedBytes" | "sentBytes";
const metrics: Record<Direction, string> = {
  receivedBytes: "VnicFromNetworkBytes",
  sentBytes: "VnicToNetworkBytes",
};
interface Target {
  instance: InstanceSummary;
  vnicId: string;
  vnicName: string;
  uncertain: boolean;
}
interface Observation {
  target: Target;
  receivedBytes: Map<number, number | null>;
  sentBytes: Map<number, number | null>;
  incomplete: boolean;
  failed: boolean;
}
export interface TrafficReaderOptions {
  clientFactory?: OciClientFactory;
  now?: () => number;
  /** Whole read budget; SDK calls already in flight retain their own 30s deadline. */
  timeoutMs?: number;
}

function bounds(range: AnalyticsRange, now: number) {
  const start = Date.parse(range.startTime);
  const end = Date.parse(range.endTime);
  if (
    range.timeZone !== "UTC" ||
    !["hourly", "daily"].includes(range.granularity) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(now) ||
    start >= end ||
    start > now ||
    end - start > MAX_RANGE ||
    start % HOUR !== 0 ||
    end % HOUR !== 0
  )
    throw new CloudError("流量统计需要不超过 90 天的 UTC 整点时间范围", "INVALID_TRAFFIC_RANGE");
  const through = Math.min(end, Math.floor(now / HOUR) * HOUR);
  const hours: number[] = [];
  for (let time = start; time < through; time += HOUR) hours.push(time);
  return { start, end, through, hours };
}

function targets(instances: InstanceSummary[], warnings: Set<string>): Target[] {
  const accounts = new Set(instances.map((instance) => instance.accountId));
  if (accounts.size > 1)
    throw new CloudError("一次流量读取只能包含同一账号的资源", "TRAFFIC_ACCOUNT_MISMATCH");
  const unique = new Map<string, Target>();
  for (const instance of instances) {
    ocid(instance.id, "instance");
    ocid(instance.compartmentId, ["compartment", "tenancy"]);
    regionName(instance.region);
    for (const vnic of instance.vnics) {
      ocid(vnic.id, "vnic");
      const key = instance.accountId + ":" + vnic.id;
      const existing = unique.get(key);
      if (existing) {
        if (
          existing.instance.id !== instance.id ||
          existing.instance.region !== instance.region ||
          existing.instance.compartmentId !== instance.compartmentId
        ) {
          existing.uncertain = true;
          warnings.add("库存中同一网卡存在不一致的实例归属，已去重；请刷新库存确认归属。");
        }
        continue;
      }
      unique.set(key, {
        instance,
        vnicId: vnic.id,
        vnicName: vnic.name || vnic.id,
        uncertain: false,
      });
    }
  }
  return [...unique.values()];
}

/** Cap every cloud RPC at two concurrent calls, including concurrent read() invocations. */
function limitCloudCalls() {
  let active = 0;
  const queue: { take: () => void; abort: () => void }[] = [];
  return async <T>(action: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new CloudError("流量查询已取消", "TRAFFIC_TIMEOUT", true));
      const entry = {
        take() {
          signal.removeEventListener("abort", entry.abort);
          active += 1;
          resolve();
        },
        abort() {
          signal.removeEventListener("abort", entry.abort);
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(new CloudError("流量查询已取消", "TRAFFIC_TIMEOUT", true));
        },
      };
      if (active < 2) entry.take();
      else {
        queue.push(entry);
        signal.addEventListener("abort", entry.abort, { once: true });
      }
    });
    try {
      return await action();
    } finally {
      active -= 1;
      queue.shift()?.take();
    }
  };
}

function safeFailure(error: unknown): string {
  const status = errorStatus(error);
  const normalized = cloudError(error);
  if (status === 401 || status === 403 || normalized.code === "NotAuthorizedOrNotFound")
    return "权限不足或资源不可见";
  if (status === 429 || normalized.code === "TooManyRequests") return "OCI 请求限流";
  if (["OCI_TIMEOUT", "ETIMEDOUT"].includes(normalized.code)) return "OCI 请求超时";
  const code = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(normalized.code) ? normalized.code : "OCI_ERROR";
  return "读取失败（" + code + "）";
}

function label(target: Target): string {
  return (
    target.instance.displayName + " / " + target.vnicName + "（" + target.instance.region + "）"
  );
}

/**
 * OCI's aggregate timestamp denotes the END of the interval. On 2026-11-07,
 * acceptance checks in Tokyo and Singapore matched each 1h sum to the twelve
 * 5m aggregates ending within that hour, confirming the API's end-stamp semantics.
 * Convert to [timestamp-1h, timestamp), then admit only fully requested hours.
 * Repeated identical records are deduplicated; conflicting records become unknown.
 */
function hourlyValues(
  response: CloudDocument,
  target: Target,
  metric: string,
  start: number,
  through: number,
): { values: Map<number, number | null>; incomplete: boolean } {
  if (!Array.isArray(response.items))
    throw new CloudError("OCI 流量响应格式不正确", "INVALID_TRAFFIC_RESPONSE");
  const values = new Map<number, number | null>();
  let incomplete = false;
  for (const series of response.items) {
    if (
      series?.namespace !== "oci_vcn" ||
      series?.name !== metric ||
      series?.dimensions?.resourceId !== target.vnicId ||
      (series.resolution != null && !["1h", "60m"].includes(series.resolution)) ||
      (series.metadata?.unit !== undefined &&
        !["byte", "bytes"].includes(String(series.metadata.unit).toLowerCase())) ||
      !Array.isArray(series.aggregatedDatapoints)
    ) {
      incomplete = true;
      continue;
    }
    for (const point of series.aggregatedDatapoints) {
      const end =
        point.timestamp instanceof Date
          ? point.timestamp.getTime()
          : typeof point.timestamp === "string"
            ? Date.parse(point.timestamp)
            : NaN;
      if (!Number.isFinite(end) || end % HOUR !== 0) {
        incomplete = true;
        continue;
      }
      const beginning = end - HOUR;
      if (beginning < start || end > through) continue;
      const amount = point.value;
      if (!Number.isSafeInteger(amount) || amount < 0) {
        incomplete = true;
        values.set(beginning, null);
        continue;
      }
      if (values.has(beginning) && values.get(beginning) !== amount) {
        values.set(beginning, null);
        incomplete = true;
      } else values.set(beginning, amount);
    }
  }
  return { values, incomplete };
}

/** Unknown values never become zero; row totals are explicitly observed subtotals. */
function observedTotal(values: Map<number, number | null>): number | null {
  let sum = 0,
    found = false;
  for (const value of values.values()) {
    if (value === null) continue;
    sum += value;
    found = true;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return found ? sum : null;
}
/**
 * Each plotted bucket is an observed subtotal. Missing members are not zero:
 * coverage records their absence while a wholly missing direction stays null.
 * Sum raw hour/VNIC samples directly so an overflow cannot disappear in a rollup.
 */
function pointsFor(
  observations: Observation[],
  hours: number[],
  granularity: AnalyticsRange["granularity"],
): TrafficPoint[] {
  if (!observations.length) return [];
  interface Bucket {
    expected: number;
    uncertain: boolean;
    received: { total: number; count: number; overflow: boolean };
    sent: { total: number; count: number; overflow: boolean };
  }
  const buckets = new Map<number, Bucket>();
  for (const hour of hours) {
    const time = granularity === "daily" ? Math.floor(hour / DAY) * DAY : hour;
    const bucket = buckets.get(time) ?? {
      expected: 0,
      uncertain: false,
      received: { total: 0, count: 0, overflow: false },
      sent: { total: 0, count: 0, overflow: false },
    };
    bucket.expected += observations.length;
    for (const observation of observations) {
      bucket.uncertain ||= observation.incomplete || observation.failed;
      for (const [field, aggregate] of [
        ["receivedBytes", bucket.received],
        ["sentBytes", bucket.sent],
      ] as const) {
        const value = observation[field].get(hour);
        if (value == null) continue;
        aggregate.count += 1;
        const sum = aggregate.total + value;
        if (!Number.isSafeInteger(sum)) aggregate.overflow = true;
        else aggregate.total = sum;
      }
    }
    buckets.set(time, bucket);
  }
  return [...buckets].map(([time, bucket]) => {
    const known = bucket.received.count + bucket.sent.count > 0;
    const complete =
      !bucket.uncertain &&
      !bucket.received.overflow &&
      !bucket.sent.overflow &&
      bucket.received.count === bucket.expected &&
      bucket.sent.count === bucket.expected;
    const coverage: TrafficRow["coverage"] = !known
      ? "unavailable"
      : complete
        ? "complete"
        : "partial";
    return {
      timestamp: new Date(time).toISOString(),
      receivedBytes:
        bucket.received.count && !bucket.received.overflow ? bucket.received.total : null,
      sentBytes: bucket.sent.count && !bucket.sent.overflow ? bucket.sent.total : null,
      coverage,
    };
  });
}

export function createTrafficReader(options: TrafficReaderOptions = {}) {
  const clientFactory = options.clientFactory ?? sdkClientFactory;
  const clock = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 45_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid traffic timeout");
  const limited = limitCloudCalls();
  return {
    async read(
      credentials: OciCredentials,
      instances: InstanceSummary[],
      range: AnalyticsRange,
      signal?: AbortSignal,
    ): Promise<TrafficAccountData> {
      const now = clock();
      const { start, end, through, hours } = bounds(range, now);
      const warnings = new Set<string>([INVENTORY_NOTE]);
      const selected = targets(instances, warnings);
      if (through < end) warnings.add("仅统计已完成的 UTC 整点小时，当前小时未计入。");
      const clients = new Map<string, Promise<OciClients>>();
      const opened = new Set<OciClients>();
      let expired = false,
        finished = false;
      let deadlineTimer!: ReturnType<typeof setTimeout>;
      const budget = new AbortController();
      const cancel = () => budget.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      const timedOut = () => new CloudError("流量查询已达到整体时间限制", "TRAFFIC_TIMEOUT", true);
      const deadline = new Promise<never>((_resolve, reject) => {
        budget.signal.addEventListener(
          "abort",
          () => {
            expired = true;
            warnings.add("流量查询达到整体时间限制，已停止后续请求并保留已取得的数据。");
            reject(timedOut());
          },
          { once: true },
        );
        deadlineTimer = setTimeout(cancel, timeoutMs);
      });
      if (signal?.aborted) cancel();
      deadlineTimer.unref();
      void deadline.catch(() => undefined);
      const checkBudget = () => {
        if (expired || finished) throw timedOut();
      };
      const cloudCall = async <T>(action: () => Promise<T>): Promise<T> => {
        checkBudget();
        // Race outside the limiter: a timed-out SDK call still occupies its slot
        // until the real call settles, so physical RPC concurrency never exceeds two.
        return Promise.race([
          limited(async () => {
            checkBudget();
            return action();
          }, budget.signal),
          deadline,
        ]);
      };
      const forRegion = (region: string) => {
        let current = clients.get(region);
        if (!current) {
          current = cloudCall(async () => {
            const regional = await clientFactory({ ...credentials, region }, region);
            if (expired || finished) {
              await closeClients(regional);
              throw timedOut();
            }
            opened.add(regional);
            return regional;
          });
          clients.set(region, current);
        }
        return current;
      };
      const observations: Observation[] = selected.map((target) => ({
        target,
        receivedBytes: new Map(),
        sentBytes: new Map(),
        incomplete: target.uncertain,
        failed: false,
      }));
      try {
        // Two workers bound queued work and each target issues only read operations.
        let cursor = 0;
        const work = async () => {
          while (cursor < observations.length) {
            if (expired) return;
            const observation = observations[cursor++];
            if (!hours.length) continue;
            const { target } = observation;
            let regional: OciClients;
            try {
              regional = await forRegion(target.instance.region);
            } catch (error) {
              observation.failed = true;
              warnings.add(label(target) + "：" + safeFailure(error));
              continue;
            }
            let compartmentId = target.instance.compartmentId;
            try {
              const response = await cloudCall(() =>
                invoke(regional.network, "getVnic", { vnicId: target.vnicId }),
              );
              if (!response.vnic || response.vnic.id !== target.vnicId)
                throw new CloudError("OCI 返回的网卡与目标不一致", "TRAFFIC_VNIC_MISMATCH");
              compartmentId = ocid(response.vnic.compartmentId, ["compartment", "tenancy"]);
            } catch (error) {
              observation.incomplete = true;
              if (
                error instanceof CloudError &&
                ["TRAFFIC_VNIC_MISMATCH", "VALIDATION_ERROR"].includes(error.code)
              ) {
                observation.failed = true;
                warnings.add(label(target) + "：网卡信息无法验证，未查询该网卡流量。");
                continue;
              }
              warnings.add(label(target) + "：无法确认网卡所属区间，按库存实例区间尝试读取。");
            }
            for (const field of ["receivedBytes", "sentBytes"] as const) {
              if (expired) {
                observation.failed = true;
                break;
              }
              try {
                // Include the aggregate ending exactly at 'through'. At an exact current
                // hour boundary the API may not yet expose it; it remains null/partial.
                const queryEnd = Math.min(through + 1, now);
                const response = await cloudCall(() =>
                  invoke(regional.monitoring, "summarizeMetricsData", {
                    compartmentId,
                    summarizeMetricsDataDetails: {
                      namespace: "oci_vcn",
                      query: metrics[field] + '[1h]{resourceId = "' + target.vnicId + '"}.sum()',
                      startTime: new Date(start),
                      endTime: new Date(queryEnd),
                      resolution: "1h",
                    },
                  }),
                );
                const result = hourlyValues(response, target, metrics[field], start, through);
                observation[field] = result.values;
                observation.incomplete ||= result.incomplete;
              } catch (error) {
                observation.failed = true;
                warnings.add(
                  label(target) +
                    (field === "receivedBytes" ? "：接收" : "：发送") +
                    "指标" +
                    safeFailure(error),
                );
              }
            }
          }
        };
        await Promise.all([work(), work()]);
      } finally {
        finished = true;
        clearTimeout(deadlineTimer);
        signal?.removeEventListener("abort", cancel);
        // Do not await pending client construction after the budget. Its late
        // completion path closes that client itself without starting a cloud RPC.
        await Promise.all([...opened].map((regional) => closeClients(regional)));
      }
      const rows: TrafficRow[] = observations.map((observation) => {
        const { target } = observation;
        const receivedBytes = observedTotal(observation.receivedBytes);
        const sentBytes = observedTotal(observation.sentBytes);
        const overflow =
          (receivedBytes === null &&
            [...observation.receivedBytes.values()].some((value) => value !== null)) ||
          (sentBytes === null &&
            [...observation.sentBytes.values()].some((value) => value !== null));
        if (overflow) {
          observation.incomplete = true;
          warnings.add("部分流量合计超出安全数值精度，已留空而未返回四舍五入的字节数。");
        }
        const allHours =
          hours.length > 0 &&
          hours.every(
            (hour) =>
              observation.receivedBytes.get(hour) != null &&
              observation.sentBytes.get(hour) != null,
          );
        const coverage =
          receivedBytes === null && sentBytes === null
            ? "unavailable"
            : allHours && !observation.incomplete && !observation.failed
              ? "complete"
              : "partial";
        return {
          instanceId: target.instance.id,
          instanceName: target.instance.displayName,
          accountId: target.instance.accountId,
          accountName: target.instance.accountName,
          region: target.instance.region,
          vnicId: target.vnicId,
          vnicName: target.vnicName,
          receivedBytes,
          sentBytes,
          coverage,
        };
      });
      const hasData = rows.some((row) => row.receivedBytes !== null || row.sentBytes !== null);
      if (rows.some((row) => row.coverage !== "complete") && hasData)
        warnings.add("部分监控小时数据缺失；明细及趋势均为已观测小计，缺失数据未按零补齐。");
      if (!hasData)
        warnings.add(
          selected.length ? "所选范围没有可用的完整小时流量数据。" : "当前库存没有匹配的网卡。",
        );
      const points = pointsFor(observations, hours, range.granularity);
      const allComplete = rows.length > 0 && rows.every((row) => row.coverage === "complete");
      const aggregateOverflow =
        allComplete &&
        points.some((point) => point.receivedBytes === null || point.sentBytes === null);
      if (aggregateOverflow) warnings.add("汇总流量超出安全数值精度，相关趋势值已留空。");
      const status = !hasData
        ? expired || observations.some((item) => item.failed || item.incomplete)
          ? "partial"
          : "empty"
        : allComplete && !aggregateOverflow && !expired
          ? "ok"
          : "partial";
      return {
        points,
        rows,
        warnings: [...warnings],
        status,
        dataThrough: new Date(Math.max(start, through)).toISOString(),
      };
    },
  };
}

export const trafficReader = createTrafficReader();
