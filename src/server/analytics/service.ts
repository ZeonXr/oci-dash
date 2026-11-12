import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import { eq } from "drizzle-orm";
import type {
  AnalyticsAccountStatus,
  AnalyticsMetadata,
  AnalyticsRange,
  CostAccountData,
  CostReport,
  TrafficAccountData,
  TrafficPoint,
  TrafficReport,
} from "@/lib/analytics-contracts";
import { getCredentialSnapshot, listAccounts } from "../accounts";
import { getOrm } from "../db";
import { accounts as accountTable } from "../database/schema";
import { AppError } from "../errors";
import { listInstances } from "../inventory";
import { cloudError } from "../oci/sdk";
import type { OciCredentials } from "../oci/types";
import { CloudError } from "../oci/types";
import { aggregateCostRows, createCostReader } from "./costs";
import { createTrafficReader } from "./traffic";
import { parseCostQuery, parseTrafficQuery } from "./query";
import { createAnalyticsSnapshots, type AnalyticsSnapshots } from "./snapshots";

interface Access {
  credentials: OciCredentials;
  revision: number;
}
interface Selection {
  account: AccountSummary;
  access: Access;
}
export interface AnalyticsServiceOptions {
  accounts?: () => AccountSummary[];
  instances?: () => InstanceSummary[];
  access?: (id: string) => Access;
  isCurrent?: (id: string, revision: number) => boolean;
  now?: () => number;
  traffic?: ReturnType<typeof createTrafficReader>;
  costs?: ReturnType<typeof createCostReader>;
  /** Whole multi-account query budget, always shorter than the browser's 60s deadline. */
  timeoutMs?: number;
  /** Explicitly supplied by production; isolated readers default to memory only. */
  snapshots?: AnalyticsSnapshots;
}

const TRAFFIC_TTL = 5 * 60_000,
  COST_TTL = 60 * 60_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024,
  MAX_ENTRY_BYTES = 4 * 1024 * 1024;
type Report = TrafficReport | CostReport;
type Cached = { value: Report; expires: number; size: number };
type Pending = { value: Promise<Report>; controller: AbortController; waiters: number };
const cancelled = () => new AppError("统计查询已取消", 499, "ANALYTICS_CANCELLED");
const expired = () =>
  new CloudError("统计查询达到整体时间限制，未完成的账号已停止读取", "ANALYTICS_TIMEOUT", true);

function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  reason: () => Error,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(reason());
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(reason());
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
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

/** A timed-out caller cannot release the slot of a reader that has not actually stopped. */
function limitAccountReads() {
  let active = 0;
  const queue: { take: () => void; abort: () => void }[] = [];
  return async <T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(expired());
      const entry = {
        take() {
          signal.removeEventListener("abort", entry.abort);
          active++;
          resolve();
        },
        abort() {
          signal.removeEventListener("abort", entry.abort);
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          reject(expired());
        },
      };
      if (active < 2) entry.take();
      else {
        queue.push(entry);
        signal.addEventListener("abort", entry.abort, { once: true });
      }
    });
    try {
      if (signal.aborted) throw expired();
      return await read();
    } finally {
      active--;
      queue.shift()?.take();
    }
  };
}

/** Only report data is cached. Credential revisions are checked before and after every query. */
export function createAnalyticsService(options: AnalyticsServiceOptions = {}) {
  const accounts = options.accounts ?? listAccounts;
  const instances = options.instances ?? listInstances;
  const access = options.access ?? getCredentialSnapshot;
  const now = options.now ?? Date.now;
  const trafficReader = options.traffic ?? createTrafficReader();
  const costReader = options.costs ?? createCostReader();
  const timeoutMs = options.timeoutMs ?? 50_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 55_000)
    throw new Error("Analytics query timeout must be positive and at most 55 seconds");
  const limited = limitAccountReads();
  const current =
    options.isCurrent ??
    ((id, revision) => {
      const row = getOrm()
        .select({ revision: accountTable.revision })
        .from(accountTable)
        .where(eq(accountTable.id, id))
        .get();
      return Boolean(row && row.revision === revision);
    });
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Pending>();
  let cachedBytes = 0;

  function select(accountId?: string): Selection[] {
    const selected = accounts().filter((account) => !accountId || account.id === accountId);
    if (accountId && !selected.length) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
    if (selected.length > 20)
      throw new AppError("账号较多，请选择一个账号后查询", 400, "ANALYTICS_SCOPE_TOO_LARGE");
    return selected
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((account) => ({ account: structuredClone(account), access: access(account.id) }));
  }
  function assertCurrent(selected: Selection[]) {
    if (selected.some(({ account, access }) => !current(account.id, access.revision)))
      throw new AppError("账号配置已变更，请重新查询", 409, "ACCOUNT_CHANGED");
  }
  function fingerprint(selected: Selection[]) {
    return selected.map(({ account, access }) => [
      account.id,
      account.name,
      account.tenancyId,
      access.revision,
      account.homeRegion,
      account.regions,
    ]);
  }
  function metadata(
    range: AnalyticsRange,
    ttl: number,
    statuses: AnalyticsAccountStatus[],
  ): AnalyticsMetadata {
    return {
      range,
      generatedAt: new Date(now()).toISOString(),
      cacheExpiresAt: new Date(now() + ttl).toISOString(),
      cached: false,
      source: "oci",
      accounts: statuses,
    };
  }
  function drop(key: string) {
    const value = cache.get(key);
    if (value) {
      cachedBytes -= value.size;
      cache.delete(key);
    }
  }
  function remember(key: string, value: Report) {
    const size = Buffer.byteLength(JSON.stringify(value));
    drop(key);
    for (const [entry, item] of cache) if (item.expires <= now()) drop(entry);
    if (size <= MAX_ENTRY_BYTES) {
      while (cache.size >= 32 || cachedBytes + size > MAX_CACHE_BYTES)
        drop(cache.keys().next().value!);
      cache.set(key, {
        value: structuredClone(value),
        expires: Date.parse(value.cacheExpiresAt),
        size,
      });
      cachedBytes += size;
    }
  }
  async function query<T extends Report>(
    key: string,
    selected: Selection[],
    force: boolean,
    ttl: number,
    read: (signal: AbortSignal) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (callerSignal?.aborted) throw cancelled();
    assertCurrent(selected);
    const subscribe = async (entry: Pending): Promise<T> => {
      entry.waiters++;
      try {
        const value = callerSignal
          ? await untilAborted(entry.value, callerSignal, cancelled)
          : await entry.value;
        assertCurrent(selected);
        return structuredClone(value) as T;
      } finally {
        entry.waiters--;
        if (!entry.waiters) entry.controller.abort(cancelled());
      }
    };
    const pending = inflight.get(key);
    if (pending?.controller.signal.reason?.code === "ANALYTICS_CANCELLED") {
      // A new subscriber must not inherit the result of an already-abandoned query.
      await pending.value.catch(() => undefined);
      return query(key, selected, force, ttl, read, callerSignal);
    }
    if (pending) return subscribe(pending);
    if (!cache.has(key)) {
      const persisted = options.snapshots?.get(key);
      if (persisted && Date.parse(persisted.cacheExpiresAt) > now()) remember(key, persisted);
    }
    const saved = cache.get(key);
    if (
      saved &&
      saved.expires > now() &&
      (!force || now() - Date.parse(saved.value.generatedAt) < 2000)
    ) {
      cache.delete(key);
      cache.set(key, saved);
      return { ...structuredClone(saved.value), cached: true } as T;
    }
    if (inflight.size >= 4)
      throw new AppError("已有多项分析查询正在执行，请稍后重试", 429, "ANALYTICS_BUSY");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(expired()), timeoutMs);
    timer.unref();
    const promise = (async () => {
      const value = await read(controller.signal);
      // An abandoned manual refresh must not evict a still-valid earlier snapshot.
      if (controller.signal.reason?.code === "ANALYTICS_CANCELLED") return value;
      assertCurrent(selected);
      const expires = now() + (value.status === "partial" ? Math.min(ttl, 30_000) : ttl);
      value.cacheExpiresAt = new Date(expires).toISOString();
      remember(key, value);
      options.snapshots?.set(key, value);
      return value;
    })();
    const entry: Pending = { value: promise, controller, waiters: 0 };
    inflight.set(key, entry);
    void promise
      .finally(() => {
        clearTimeout(timer);
        if (inflight.get(key) === entry) inflight.delete(key);
      })
      .catch(() => undefined);
    return subscribe(entry);
  }
  async function mapAccounts<T>(
    selected: Selection[],
    read: (item: Selection, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = selected.map(() => ({
      status: "rejected",
      reason: expired(),
    }));
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, selected.length) }, async () => {
        while (!signal.aborted && cursor < selected.length) {
          const index = cursor++;
          try {
            const actual = limited(() => {
              assertCurrent([selected[index]]);
              return read(selected[index], signal);
            }, signal);
            results[index] = {
              status: "fulfilled",
              value: await untilAborted(actual, signal, expired),
            };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        }
      }),
    );
    return results;
  }
  function errorStatus(account: AccountSummary, error: unknown): AnalyticsAccountStatus {
    return {
      accountId: account.id,
      accountName: account.name,
      status: "error",
      message: cloudError(error, "OCI 分析数据读取失败").message,
    };
  }
  return {
    async traffic(input: unknown, force = false, signal?: AbortSignal): Promise<TrafficReport> {
      const parsed = parseTrafficQuery(input, now());
      const selected = select(parsed.accountId);
      const selectedIds = new Set(selected.map((item) => item.account.id));
      const scopes = new Map(
        selected.map(({ account }) => [
          account.id,
          new Set([account.homeRegion, ...account.regions]),
        ]),
      );
      if (
        parsed.region &&
        !selected.some(({ account }) => scopes.get(account.id)!.has(parsed.region!))
      )
        throw new AppError("所选账号未启用此区域", 400, "REGION_NOT_ENABLED");
      const inventory = instances().filter(
        (instance) =>
          selectedIds.has(instance.accountId) &&
          scopes.get(instance.accountId)!.has(instance.region),
      );
      if (parsed.instanceId && !inventory.some((instance) => instance.id === parsed.instanceId))
        throw new AppError("实例不属于所选账号或尚未同步", 404, "INSTANCE_NOT_FOUND");
      if (
        parsed.vnicId &&
        !inventory.some(
          (instance) =>
            (!parsed.instanceId || instance.id === parsed.instanceId) &&
            instance.vnics.some((vnic) => vnic.id === parsed.vnicId),
        )
      )
        throw new AppError("网卡不属于所选实例或尚未同步", 404, "VNIC_NOT_FOUND");
      const targets = inventory
        .filter(
          (instance) =>
            (!parsed.region || instance.region === parsed.region) &&
            (!parsed.instanceId || instance.id === parsed.instanceId),
        )
        .map((instance) => ({
          ...instance,
          vnics: instance.vnics.filter((vnic) => !parsed.vnicId || vnic.id === parsed.vnicId),
        }));
      const key = JSON.stringify([
        "traffic",
        parsed,
        fingerprint(selected),
        targets.map((i) => [
          i.id,
          i.displayName,
          i.region,
          i.compartmentId,
          i.vnics.map((v) => [v.id, v.name]),
        ]),
      ]);
      return query(
        key,
        selected,
        force,
        TRAFFIC_TTL,
        async (budget) => {
          const statuses: AnalyticsAccountStatus[] = [];
          const seen = new Set<string>();
          const scoped = new Map<string, InstanceSummary[]>();
          for (const item of selected) {
            const own = targets
              .filter((i) => i.accountId === item.account.id)
              .map((instance) => ({
                ...instance,
                vnics: instance.vnics.filter((vnic) => {
                  const unique = item.account.tenancyId + "/" + instance.region + "/" + vnic.id;
                  if (seen.has(unique)) return false;
                  seen.add(unique);
                  return true;
                }),
              }))
              .filter((instance) => instance.vnics.length > 0);
            scoped.set(item.account.id, own);
          }
          const results = await mapAccounts(
            selected,
            async (item, cancellation) =>
              trafficReader.read(
                item.access.credentials,
                scoped.get(item.account.id) ?? [],
                parsed.range,
                cancellation,
              ),
            budget,
          );
          const datasets: TrafficAccountData[] = [];
          results.forEach((result, index) => {
            const account = selected[index].account;
            if (result.status === "rejected") statuses.push(errorStatus(account, result.reason));
            else {
              datasets.push(result.value);
              statuses.push({
                accountId: account.id,
                accountName: account.name,
                status: result.value.status,
              });
            }
          });
          const rows = datasets.flatMap((data) => data.rows);
          const warnings = [...new Set(datasets.flatMap((data) => data.warnings))];
          const failures = statuses.some((item) => item.status === "error");
          const partial = failures || datasets.some((data) => data.status === "partial");
          if (failures)
            warnings.push("部分账号读取失败；汇总仅包含已返回网卡，不能视作所有账号的完整用量。");
          const stamps = [
            ...new Set(datasets.flatMap((data) => data.points.map((point) => point.timestamp))),
          ].sort();
          const maps = datasets
            .filter((data) => data.rows.length)
            .map((data) => new Map(data.points.map((point) => [point.timestamp, point])));
          let overflow = false;
          const safeTotal = (values: number[]) => {
            const total = values.reduce((a, b) => a + b, 0);
            if (!Number.isSafeInteger(total)) {
              overflow = true;
              return null;
            }
            return total;
          };
          const points: TrafficPoint[] = stamps.map((timestamp) => {
            const observations = maps.map((map) => map.get(timestamp));
            const sum = (field: "receivedBytes" | "sentBytes") => {
              const values = observations
                .map((point) => point?.[field])
                .filter((value): value is number => value != null);
              return values.length ? safeTotal(values) : null;
            };
            const receivedBytes = sum("receivedBytes"),
              sentBytes = sum("sentBytes");
            const complete =
              !failures &&
              receivedBytes !== null &&
              sentBytes !== null &&
              observations.length > 0 &&
              observations.every(
                (point) =>
                  point &&
                  point.receivedBytes !== null &&
                  point.sentBytes !== null &&
                  (!point.coverage || point.coverage === "complete"),
              );
            return {
              timestamp,
              receivedBytes,
              sentBytes,
              coverage:
                receivedBytes === null && sentBytes === null
                  ? "unavailable"
                  : complete
                    ? "complete"
                    : "partial",
            };
          });
          const sumRows = (field: "receivedBytes" | "sentBytes") => {
            const values = rows
              .map((row) => row[field])
              .filter((value): value is number => value !== null);
            return values.length ? safeTotal(values) : null;
          };
          const receivedBytes = sumRows("receivedBytes"),
            sentBytes = sumRows("sentBytes");
          const total =
            receivedBytes !== null && sentBytes !== null
              ? safeTotal([receivedBytes, sentBytes])
              : null;
          if (overflow) warnings.push("跨账号汇总超出安全字节精度，相关合计已留空。");
          const through = datasets
            .flatMap((data) => (data.dataThrough ? [data.dataThrough] : []))
            .sort()[0];
          return {
            ...metadata(parsed.range, TRAFFIC_TTL, statuses),
            rows,
            points,
            warnings,
            status:
              partial || overflow
                ? "partial"
                : rows.some((row) => row.receivedBytes !== null || row.sentBytes !== null)
                  ? "ok"
                  : "empty",
            totals: {
              receivedBytes,
              sentBytes,
              totalBytes: total !== null && Number.isSafeInteger(total) ? total : null,
            },
            ...(through ? { dataThrough: through } : {}),
          };
        },
        signal,
      );
    },
    async costs(input: unknown, force = false, signal?: AbortSignal): Promise<CostReport> {
      const parsed = parseCostQuery(input, now());
      const selected = select(parsed.accountId);
      const key = JSON.stringify(["costs", parsed, fingerprint(selected)]);
      return query(
        key,
        selected,
        force,
        COST_TTL,
        async (budget) => {
          const statuses: AnalyticsAccountStatus[] = [];
          const unique: Selection[] = [];
          const seen = new Set<string>();
          for (const item of selected) {
            if (seen.has(item.account.tenancyId))
              statuses.push({
                accountId: item.account.id,
                accountName: item.account.name,
                status: "duplicate",
                message: "同一租户已由另一账号查询，未重复累计费用。",
              });
            else {
              seen.add(item.account.tenancyId);
              unique.push(item);
            }
          }
          const results = await mapAccounts(
            unique,
            (item, cancellation) =>
              costReader.read(
                item.access.credentials,
                item.account,
                parsed.range,
                {
                  region: parsed.region,
                  service: parsed.service,
                },
                cancellation,
              ),
            budget,
          );
          const datasets: CostAccountData[] = [];
          results.forEach((result, index) => {
            const account = unique[index].account;
            if (result.status === "rejected") statuses.push(errorStatus(account, result.reason));
            else {
              datasets.push(result.value);
              statuses.push({
                accountId: account.id,
                accountName: account.name,
                status: result.value.status,
              });
            }
          });
          if (budget.reason?.code === "ANALYTICS_CANCELLED") throw cancelled();
          const labels = new Map(
            instances().flatMap((instance) => [
              [instance.id, instance.displayName] as const,
              ...instance.bootVolumes.map((volume) => [volume.id, volume.name] as const),
              ...instance.vnics.map(
                (vnic) => [vnic.id, vnic.name || instance.displayName] as const,
              ),
            ]),
          );
          const rows = datasets
            .flatMap((data) => data.rows)
            .map((row) => ({
              ...row,
              resourceName:
                row.resourceName || (row.resourceId ? (labels.get(row.resourceId) ?? null) : null),
            }));
          const partial =
            statuses.some((item) => item.status === "error") ||
            datasets.some((data) => data.status === "partial");
          const warnings = [...new Set(datasets.flatMap((data) => data.warnings))];
          if (statuses.some((item) => item.status === "error"))
            warnings.push("部分账号费用读取失败，全部账号合计暂不可确认。");
          return {
            ...metadata(parsed.range, COST_TTL, statuses),
            rows,
            ...aggregateCostRows(rows, { incomplete: partial }),
            warnings,
            status: partial ? "partial" : rows.length ? "ok" : "empty",
          };
        },
        signal,
      );
    },
  };
}
export const analyticsService = createAnalyticsService({ snapshots: createAnalyticsSnapshots() });
