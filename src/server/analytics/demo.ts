import type {
  AnalyticsAccountStatus,
  AnalyticsRange,
  CostReport,
  CostRow,
  TrafficPoint,
  TrafficReport,
  TrafficRow,
} from "../../lib/analytics-contracts";
import { normalizeDecimal } from "../../lib/decimal";
import type { AccountSummary, InstanceSummary } from "../../lib/contracts";
import { demoAccounts, demoInstances } from "../demo";
import { aggregateCostRows } from "./costs";

/** Structurally accepts the server normalizer's flat, validated query. */
export interface DemoAnalyticsQuery {
  range: AnalyticsRange;
  accountId?: string;
  region?: string;
  instanceId?: string;
  vnicId?: string;
  service?: string;
}
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

function seed(value: string): number {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619);
  return result >>> 0;
}
function scope(query: DemoAnalyticsQuery) {
  const allAccounts = demoAccounts();
  const selected = demoInstances()
    .filter(
      (instance) =>
        (!query.accountId || instance.accountId === query.accountId) &&
        (!query.region || instance.region === query.region) &&
        (!query.instanceId || instance.id === query.instanceId) &&
        (!query.vnicId || instance.vnics.some((vnic) => vnic.id === query.vnicId)),
    )
    .map((instance) => ({
      ...instance,
      vnics: instance.vnics.filter((vnic) => !query.vnicId || vnic.id === query.vnicId),
    }));
  const selectedIds = new Set(selected.map((instance) => instance.accountId));
  const accounts = allAccounts.filter(
    (account) =>
      (!query.accountId || account.id === query.accountId) &&
      (!query.region || account.regions.includes(query.region)) &&
      (!(query.instanceId || query.vnicId) || selectedIds.has(account.id)),
  );
  return { allAccounts, accounts, instances: selected };
}
function period(range: AnalyticsRange, now: number) {
  const start = Date.parse(range.startTime);
  const end = Date.parse(range.endTime);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    !Number.isFinite(now) ||
    start >= end ||
    end - start > 367 * DAY ||
    start % HOUR !== 0 ||
    end % HOUR !== 0
  )
    throw new Error("Invalid normalized demonstration analytics range.");
  return { start, through: Math.min(end, Math.floor(now / HOUR) * HOUR) };
}
function bucket(time: number, granularity: AnalyticsRange["granularity"]): number {
  if (granularity === "monthly") {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  return granularity === "daily" ? Math.floor(time / DAY) * DAY : time;
}
function metadata(query: DemoAnalyticsQuery, now: number, accounts: AnalyticsAccountStatus[]) {
  return {
    range: { ...query.range },
    generatedAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(now + 60_000).toISOString(),
    cached: false,
    source: "demo" as const,
    accounts,
  };
}
function accountStatuses(
  accounts: AccountSummary[],
  populated: Set<string>,
): AnalyticsAccountStatus[] {
  return accounts.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    status: populated.has(account.id) ? "ok" : "empty",
  }));
}
function hourlyTraffic(instance: InstanceSummary, vnicId: string, time: number) {
  const identity = seed(vnicId);
  const hour = time / HOUR;
  const wave = 0.75 + (Math.sin(((hour % 24) * Math.PI) / 12 + (identity % 7)) + 1) * 0.3;
  const weekly = 0.85 + ((Math.floor(hour / 24) + identity) % 7) * 0.05;
  const activity = instance.state === "RUNNING" ? 1 : 0.025;
  return {
    receivedBytes: Math.round((18 + (identity % 65)) * MIB * wave * weekly * activity),
    sentBytes: Math.round((35 + (identity % 140)) * MIB * (1.9 - wave) * weekly * activity),
  };
}

/** Entirely local examples; the same hour/resource always has the same byte values. */
export function demoTrafficReport(query: DemoAnalyticsQuery, now = Date.now()): TrafficReport {
  const selected = scope(query);
  const { start, through } = period(query.range, now);
  const rows: TrafficRow[] = [];
  const points = new Map<number, { receivedBytes: number; sentBytes: number }>();
  const populated = new Set<string>();
  const knownVnics = new Set<string>();
  for (const instance of selected.instances) {
    for (const vnic of instance.vnics) {
      if (knownVnics.has(vnic.id)) continue;
      knownVnics.add(vnic.id);
      let received = 0,
        sent = 0;
      for (let time = start; time < through; time += HOUR) {
        const value = hourlyTraffic(instance, vnic.id, time);
        received += value.receivedBytes;
        sent += value.sentBytes;
        const stamp = bucket(time, query.range.granularity);
        const aggregate = points.get(stamp) ?? { receivedBytes: 0, sentBytes: 0 };
        aggregate.receivedBytes += value.receivedBytes;
        aggregate.sentBytes += value.sentBytes;
        points.set(stamp, aggregate);
      }
      const hasHours = through > start;
      if (hasHours) populated.add(instance.accountId);
      rows.push({
        instanceId: instance.id,
        instanceName: instance.displayName,
        accountId: instance.accountId,
        accountName: instance.accountName,
        region: instance.region,
        vnicId: vnic.id,
        vnicName: vnic.name,
        receivedBytes: hasHours ? received : null,
        sentBytes: hasHours ? sent : null,
        coverage: hasHours ? "complete" : "unavailable",
      });
    }
  }
  const hasData = rows.length > 0 && through > start;
  const receivedBytes = hasData ? rows.reduce((sum, row) => sum + row.receivedBytes!, 0) : null;
  const sentBytes = hasData ? rows.reduce((sum, row) => sum + row.sentBytes!, 0) : null;
  const chart: TrafficPoint[] = [...points]
    .sort(([left], [right]) => left - right)
    .map(([timestamp, value]) => ({ timestamp: new Date(timestamp).toISOString(), ...value }));
  return {
    ...metadata(query, now, accountStatuses(selected.accounts, populated)),
    rows,
    points: chart,
    totals: {
      receivedBytes,
      sentBytes,
      totalBytes: receivedBytes === null || sentBytes === null ? null : receivedBytes + sentBytes,
    },
    warnings: ["演示流量用于展示统计与筛选，不代表真实服务器用量。"],
    status: hasData ? "ok" : "empty",
    dataThrough: new Date(Math.max(start, through)).toISOString(),
  };
}

function currency(account: AccountSummary, all: AccountSummary[]): "USD" | "EUR" {
  // Currency is stable for an account regardless of filters, dates or grouping.
  const index = all.findIndex((item) => item.id === account.id);
  return index === 1 || index === 4 ? "EUR" : "USD";
}
function decimalMicros(value: bigint): string {
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, "0");
  return normalizeDecimal(whole.toString() + "." + fraction)!;
}

/** Synthetic amounts are exact decimal strings; currencies are never combined. */
export function demoCostReport(query: DemoAnalyticsQuery, now = Date.now()): CostReport {
  const selected = scope(query);
  const { start, through } = period(query.range, now);
  const accounts = new Map(selected.allAccounts.map((account) => [account.id, account]));
  const grouped = new Map<string, { row: Omit<CostRow, "amount">; micros: bigint }>();
  for (const instance of selected.instances) {
    const account = accounts.get(instance.accountId)!;
    const items = [
      {
        service: "Compute",
        resourceId: instance.id,
        resourceName: instance.displayName,
        hourlyMicros:
          instance.shape === "VM.Standard.E2.1.Micro" ? 0 : 42_000 + (seed(instance.id) % 58_000),
      },
      ...instance.bootVolumes.map((volume) => ({
        service: "Block Storage",
        resourceId: volume.id,
        resourceName: volume.name,
        hourlyMicros: Math.round(volume.sizeGb * 35) + (seed(volume.id) % 800),
      })),
      ...instance.vnics.map((vnic) => ({
        service: "Network",
        resourceId: vnic.id,
        resourceName: instance.displayName + " / " + vnic.name,
        hourlyMicros: 150 + (seed(vnic.id) % 850),
      })),
    ].filter((item) => !query.service || item.service === query.service);
    for (const item of items) {
      for (let time = start; time < through; time += HOUR) {
        const timestamp = new Date(bucket(time, query.range.granularity)).toISOString();
        const code = currency(account, selected.allAccounts);
        const key = JSON.stringify([account.id, timestamp, item.service, item.resourceId, code]);
        const existing = grouped.get(key) ?? {
          row: {
            accountId: account.id,
            accountName: account.name,
            tenancyId: account.tenancyId,
            timestamp,
            service: item.service,
            region: instance.region,
            resourceId: item.resourceId,
            resourceName: item.resourceName,
            currency: code,
          },
          micros: 0n,
        };
        const variation =
          item.service === "Network" ? (Math.floor(time / HOUR) + seed(item.resourceId)) % 240 : 0;
        existing.micros += BigInt(item.hourlyMicros + variation);
        grouped.set(key, existing);
      }
    }
  }
  const rows: CostRow[] = [...grouped.values()]
    .map(({ row, micros }) => ({ ...row, amount: decimalMicros(micros) }))
    .sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.accountId.localeCompare(right.accountId) ||
        (left.service ?? "").localeCompare(right.service ?? "") ||
        (left.resourceId ?? "").localeCompare(right.resourceId ?? ""),
    );
  return {
    ...metadata(
      query,
      now,
      accountStatuses(selected.accounts, new Set(rows.map((row) => row.accountId))),
    ),
    rows,
    ...aggregateCostRows(rows),
    warnings: ["演示费用用于展示分析与筛选，不代表实际账单、资费或免费额度。"],
    status: rows.length ? "ok" : "empty",
  };
}
