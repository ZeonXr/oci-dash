import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
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
import { getDatabase, isDemo } from "../db";
import { AppError } from "../errors";
import { listInstances } from "../inventory";
import { cloudError } from "../oci/sdk";
import type { OciCredentials } from "../oci/types";
import { aggregateCostRows, createCostReader } from "./costs";
import { createTrafficReader } from "./traffic";
import { demoCostReport, demoTrafficReport } from "./demo";
import { parseCostQuery, parseTrafficQuery } from "./query";

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
  demo?: () => boolean;
  now?: () => number;
  traffic?: ReturnType<typeof createTrafficReader>;
  costs?: ReturnType<typeof createCostReader>;
}

const TRAFFIC_TTL = 5 * 60_000,
  COST_TTL = 60 * 60_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024,
  MAX_ENTRY_BYTES = 4 * 1024 * 1024;
type Report = TrafficReport | CostReport;
type Cached = { value: Report; expires: number; size: number };

/** Only report data is cached. Credential revisions are checked before and after every query. */
export function createAnalyticsService(options: AnalyticsServiceOptions = {}) {
  const accounts = options.accounts ?? listAccounts;
  const instances = options.instances ?? listInstances;
  const access = options.access ?? getCredentialSnapshot;
  const demo = options.demo ?? isDemo;
  const now = options.now ?? Date.now;
  const trafficReader = options.traffic ?? createTrafficReader();
  const costReader = options.costs ?? createCostReader();
  const current =
    options.isCurrent ??
    ((id, revision) => {
      const row = getDatabase().prepare("SELECT revision FROM accounts WHERE id=?").get(id) as
        { revision: number } | undefined;
      return Boolean(row && row.revision === revision);
    });
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Report>>();
  let cachedBytes = 0;

  function select(accountId?: string): Selection[] {
    const selected = accounts().filter((account) => !accountId || account.id === accountId);
    if (accountId && !selected.length) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
    if (selected.length > 20)
      throw new AppError("账号较多，请选择一个账号后查询", 400, "ANALYTICS_SCOPE_TOO_LARGE");
    return selected
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((account) => ({ account, access: access(account.id) }));
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
  async function query<T extends Report>(
    key: string,
    selected: Selection[],
    force: boolean,
    ttl: number,
    read: () => Promise<T>,
  ): Promise<T> {
    assertCurrent(selected);
    const pending = inflight.get(key);
    if (pending) {
      const value = await pending;
      assertCurrent(selected);
      return structuredClone(value) as T;
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
    const promise = (async () => {
      const value = await read();
      assertCurrent(selected);
      const expires = now() + (value.status === "partial" ? Math.min(ttl, 30_000) : ttl);
      value.cacheExpiresAt = new Date(expires).toISOString();
      const size = Buffer.byteLength(JSON.stringify(value));
      drop(key);
      for (const [entry, item] of cache) if (item.expires <= now()) drop(entry);
      if (size <= MAX_ENTRY_BYTES) {
        while (cache.size >= 32 || cachedBytes + size > MAX_CACHE_BYTES)
          drop(cache.keys().next().value!);
        cache.set(key, { value: structuredClone(value), expires, size });
        cachedBytes += size;
      }
      return value;
    })();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      if (inflight.get(key) === promise) inflight.delete(key);
    }
  }
  async function mapAccounts<T>(
    selected: Selection[],
    read: (item: Selection) => Promise<T>,
  ): Promise<PromiseSettledResult<T>[]> {
    const results: PromiseSettledResult<T>[] = new Array(selected.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, selected.length) }, async () => {
        while (cursor < selected.length) {
          const index = cursor++;
          try {
            results[index] = { status: "fulfilled", value: await read(selected[index]) };
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
    async traffic(input: unknown, force = false): Promise<TrafficReport> {
      const parsed = parseTrafficQuery(input, now());
      if (demo()) return demoTrafficReport(parsed, now());
      const selected = select(parsed.accountId);
      const selectedIds = new Set(selected.map((item) => item.account.id));
      const inventory = instances().filter((instance) => selectedIds.has(instance.accountId));
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
      return query(key, selected, force, TRAFFIC_TTL, async () => {
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
        const results = await mapAccounts(selected, async (item) =>
          trafficReader.read(
            item.access.credentials,
            scoped.get(item.account.id) ?? [],
            parsed.range,
          ),
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
      });
    },
    async costs(input: unknown, force = false): Promise<CostReport> {
      const parsed = parseCostQuery(input, now());
      if (demo()) return demoCostReport(parsed, now());
      const selected = select(parsed.accountId);
      const key = JSON.stringify(["costs", parsed, fingerprint(selected)]);
      return query(key, selected, force, COST_TTL, async () => {
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
        const results = await mapAccounts(unique, (item) =>
          costReader.read(item.access.credentials, item.account, parsed.range, {
            region: parsed.region,
            service: parsed.service,
          }),
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
        const labels = new Map(
          instances().flatMap((instance) => [
            [instance.id, instance.displayName] as const,
            ...instance.bootVolumes.map((volume) => [volume.id, volume.name] as const),
            ...instance.vnics.map((vnic) => [vnic.id, vnic.name || instance.displayName] as const),
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
      });
    },
  };
}
export const analyticsService = createAnalyticsService();
