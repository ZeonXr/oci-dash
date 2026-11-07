import type {
  CostReport,
  CostRow,
  TrafficPoint,
  TrafficReport,
  TrafficRow,
} from "../lib/analytics-contracts";
import { normalizeDecimal, sumDecimalAmounts } from "../lib/decimal";
import type { AnalyticsDateRange } from "./analytics-range";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
export type OverviewCoverage = "complete" | "partial" | "unavailable";
export interface TrafficOverviewSummary {
  receivedGiB: number | null;
  sentGiB: number | null;
  totalGiB: number | null;
  coverage: OverviewCoverage;
}
export interface TrafficOverviewDay extends TrafficOverviewSummary {
  timestamp: string;
  completeDay: boolean;
}
export interface TrafficOverviewRank extends TrafficOverviewSummary {
  instanceId: string;
  instanceName: string;
  accountId: string;
  accountName: string;
  region: string;
  vnicCount: number;
}
export interface TrafficOverviewData {
  points: TrafficOverviewDay[];
  summary: TrafficOverviewSummary;
  ranking: TrafficOverviewRank[];
  peak: TrafficOverviewDay | null;
}
export interface CostOverviewService {
  key: string;
  service: string | null;
  label: string;
}
export interface CostOverviewDay {
  timestamp: string;
  values: Record<string, number | null>;
  amounts: Record<string, string | null>;
  totalAmount: string | null;
  total: number | null;
  coverage: OverviewCoverage;
}
export interface CostOverviewData {
  currency: string;
  services: CostOverviewService[];
  points: CostOverviewDay[];
  summary: { amount: string | null; value: number | null; coverage: OverviewCoverage };
  partial: boolean;
}

/** Includes yesterday and the six preceding UTC dates; today's partial day is excluded. */
export function overviewDateRange(now = new Date()): AnalyticsDateRange {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (!Number.isFinite(today)) throw new Error("Invalid overview date");
  return {
    preset: "last7",
    startDate: new Date(today - 7 * DAY).toISOString().slice(0, 10),
    endDate: new Date(today - DAY).toISOString().slice(0, 10),
  };
}
function dayStart(time: number) {
  return Math.floor(time / DAY) * DAY;
}
function calendar(startTime: string, endTime: string): number[] {
  const start = Date.parse(startTime),
    end = Date.parse(endTime);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 740 * DAY)
    return [];
  const days: number[] = [];
  for (let time = dayStart(start); time < end; time += DAY) days.push(time);
  return days;
}
function byteValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function bytes(values: readonly (number | null | undefined)[]) {
  const observed = values.map(byteValue).filter((value): value is number => value !== null);
  const total = observed.reduce((sum, value) => sum + value, 0);
  const overflow = !Number.isSafeInteger(total);
  return {
    value: observed.length && !overflow ? total : null,
    complete: values.length > 0 && observed.length === values.length && !overflow,
    overflow,
  };
}
function combined(received: number | null, sent: number | null): number | null {
  return received === null || sent === null ? null : bytes([received, sent]).value;
}
const gib = (value: number | null) => (value === null ? null : value / GIB);
function trafficValues(
  received: number | null,
  sent: number | null,
  complete: boolean,
): TrafficOverviewSummary {
  const total = combined(received, sent);
  return {
    receivedGiB: gib(received),
    sentGiB: gib(sent),
    totalGiB: gib(total),
    coverage:
      received === null && sent === null
        ? "unavailable"
        : complete && total !== null
          ? "complete"
          : "partial",
  };
}
function consistentPoint(first: TrafficPoint, next: TrafficPoint): TrafficPoint {
  return {
    timestamp: first.timestamp,
    receivedBytes: first.receivedBytes === next.receivedBytes ? first.receivedBytes : null,
    sentBytes: first.sentBytes === next.sentBytes ? first.sentBytes : null,
    coverage:
      first.receivedBytes === next.receivedBytes &&
      first.sentBytes === next.sentBytes &&
      first.coverage !== "partial" &&
      next.coverage !== "partial" &&
      first.coverage !== "unavailable" &&
      next.coverage !== "unavailable"
        ? (first.coverage ?? next.coverage)
        : "partial",
  };
}

/** Traffic summaries and ranking use the same deduplicated current-VNIC observed subtotals. */
export function trafficOverview(report: TrafficReport): TrafficOverviewData {
  const unique = new Map<string, TrafficRow>();
  for (const row of report.rows) {
    const key = JSON.stringify([row.instanceId, row.vnicId]);
    const prior = unique.get(key);
    if (!prior) unique.set(key, { ...row });
    else {
      unique.set(key, {
        ...prior,
        receivedBytes: prior.receivedBytes === row.receivedBytes ? prior.receivedBytes : null,
        sentBytes: prior.sentBytes === row.sentBytes ? prior.sentBytes : null,
        coverage:
          prior.coverage === "complete" &&
          row.coverage === "complete" &&
          prior.receivedBytes === row.receivedBytes &&
          prior.sentBytes === row.sentBytes &&
          prior.accountId === row.accountId &&
          prior.region === row.region
            ? "complete"
            : "partial",
      });
    }
  }
  const groups = new Map<string, TrafficRow[]>();
  for (const row of unique.values()) {
    const group = groups.get(row.instanceId) ?? [];
    group.push(row);
    groups.set(row.instanceId, group);
  }
  const grouped = [...groups.values()].map((rows) => {
    const first = rows[0];
    const received = bytes(rows.map((row) => row.receivedBytes));
    const sent = bytes(rows.map((row) => row.sentBytes));
    const complete =
      received.complete &&
      sent.complete &&
      rows.every(
        (row) =>
          row.coverage === "complete" &&
          row.accountId === first.accountId &&
          row.region === first.region,
      );
    const rank: TrafficOverviewRank = {
      instanceId: first.instanceId,
      instanceName: first.instanceName,
      accountId: first.accountId,
      accountName: first.accountName,
      region: first.region,
      vnicCount: rows.length,
      ...trafficValues(received.value, sent.value, complete),
    };
    return { rank, received, sent };
  });
  const received = bytes(grouped.map((group) => group.received.value));
  const sent = bytes(grouped.map((group) => group.sent.value));
  if (grouped.some((group) => group.received.overflow)) received.value = null;
  if (grouped.some((group) => group.sent.overflow)) sent.value = null;
  const summary = trafficValues(
    received.value,
    sent.value,
    report.status === "ok" &&
      grouped.length > 0 &&
      byteValue(report.totals.receivedBytes) === received.value &&
      byteValue(report.totals.sentBytes) === sent.value &&
      byteValue(report.totals.totalBytes) === combined(received.value, sent.value) &&
      grouped.every((group) => group.rank.coverage === "complete") &&
      report.accounts.every((account) => !["error", "partial"].includes(account.status)),
  );
  const ranking = grouped
    .map((group) => group.rank)
    .sort(
      (left, right) =>
        (left.totalGiB === null
          ? right.totalGiB === null
            ? 0
            : 1
          : right.totalGiB === null
            ? -1
            : right.totalGiB - left.totalGiB) ||
        left.instanceName.localeCompare(right.instanceName) ||
        left.instanceId.localeCompare(right.instanceId),
    );
  const start = Date.parse(report.range.startTime);
  const end = Date.parse(report.range.endTime);
  const generated = Date.parse(report.generatedAt);
  const declaredThrough = report.dataThrough ? Date.parse(report.dataThrough) : NaN;
  const through = Math.min(
    end,
    Number.isFinite(declaredThrough) ? declaredThrough : end,
    Number.isFinite(generated) ? Math.floor(generated / HOUR) * HOUR : end,
  );
  const normalized = new Map<number, TrafficPoint>();
  if (report.range.granularity !== "monthly") {
    for (const point of report.points) {
      const time = Date.parse(point.timestamp);
      if (!Number.isFinite(time) || time < start || time >= end || time >= through) continue;
      if (report.range.granularity === "hourly" && time + HOUR > through) continue;
      const value = {
        ...point,
        timestamp: new Date(time).toISOString(),
        receivedBytes: byteValue(point.receivedBytes),
        sentBytes: byteValue(point.sentBytes),
      };
      const prior = normalized.get(time);
      normalized.set(time, prior ? consistentPoint(prior, value) : value);
    }
  }
  const failedAccounts = report.accounts.some((account) => account.status === "error");
  const points = calendar(report.range.startTime, report.range.endTime).map((day) => {
    const samples = [...normalized]
      .filter(([time]) => dayStart(time) === day)
      .map(([, point]) => point);
    const rx = bytes(samples.map((point) => point.receivedBytes));
    const tx = bytes(samples.map((point) => point.sentBytes));
    const completeDay =
      day >= start &&
      day + DAY <= end &&
      day + DAY <= through &&
      Number.isFinite(generated) &&
      day + DAY <= generated;
    const expected = report.range.granularity === "hourly" ? 24 : 1;
    const complete =
      completeDay &&
      !failedAccounts &&
      samples.length === expected &&
      rx.complete &&
      tx.complete &&
      samples.every(
        (point) => point.coverage === "complete" || (!point.coverage && report.status === "ok"),
      );
    return {
      timestamp: new Date(day).toISOString(),
      completeDay,
      ...trafficValues(rx.value, tx.value, complete),
    };
  });
  const peak = points
    .filter(
      (point) => point.completeDay && point.coverage === "complete" && point.totalGiB !== null,
    )
    .reduce<TrafficOverviewDay | null>(
      (best, point) => (!best || point.totalGiB! > best.totalGiB! ? point : best),
      null,
    );
  return { points, summary, ranking, peak };
}

const currencyCode = (value: string | null | undefined) =>
  typeof value === "string" && /^[a-z]{3}$/i.test(value.trim()) ? value.trim().toUpperCase() : null;
function plotAmount(amount: string | null): number | null {
  if (amount === null) return null;
  const value = Number(amount);
  return Number.isFinite(value) && (value !== 0 || amount === "0") ? value : null;
}
function oneAmount(values: readonly (string | null)[]): string | null {
  const unique = [...new Set(values.map(normalizeDecimal))];
  return unique.length === 1 ? unique[0] : null;
}
function serviceName(row: CostRow): string | null {
  return typeof row.service === "string" && row.service.trim() ? row.service.trim() : null;
}

/** Real service rows form the stack; authoritative totals never manufacture missing services. */
export function costOverview(report: CostReport, currency: string): CostOverviewData {
  const code = currencyCode(currency) ?? currency;
  const start = Date.parse(report.range.startTime);
  const end = Date.parse(report.range.endTime);
  const generated = Date.parse(report.generatedAt);
  const selectedRows = report.rows.filter((row) => {
    const time = Date.parse(row.timestamp);
    return (
      currencyCode(row.currency) === code && Number.isFinite(time) && time >= start && time < end
    );
  });
  const names = [...new Set(selectedRows.map(serviceName))].sort((left, right) =>
    left === null ? (right === null ? 0 : 1) : right === null ? -1 : left.localeCompare(right),
  );
  const services: CostOverviewService[] = names.map((service, index) => ({
    key: "service" + index,
    service,
    label: service ?? "未知服务",
  }));
  const keys = new Map(services.map((service) => [service.service, service.key]));
  const rowsByDay = new Map<number, CostRow[]>();
  const pointRecords = new Map<number, string | null>();
  const sourceIsDaily = report.range.granularity !== "monthly";
  if (sourceIsDaily) {
    for (const row of selectedRows) {
      const day = dayStart(Date.parse(row.timestamp));
      const rows = rowsByDay.get(day) ?? [];
      rows.push(row);
      rowsByDay.set(day, rows);
    }
    for (const point of report.points) {
      if (currencyCode(point.currency) !== code) continue;
      const time = Date.parse(point.timestamp);
      if (!Number.isFinite(time) || time < start || time >= end) continue;
      const amount = normalizeDecimal(point.amount);
      pointRecords.set(
        time,
        pointRecords.has(time) ? oneAmount([pointRecords.get(time)!, amount]) : amount,
      );
    }
  }
  const totals = report.totals.filter((total) => currencyCode(total.currency) === code);
  const authoritative = oneAmount(totals.map((total) => total.amount));
  const globalIncomplete =
    report.status === "partial" ||
    report.accounts.some((account) => ["error", "partial"].includes(account.status)) ||
    report.rows.some((row) => currencyCode(row.currency) === null);
  const points: CostOverviewDay[] = calendar(report.range.startTime, report.range.endTime).map(
    (day) => {
      const rows = rowsByDay.get(day) ?? [];
      const grouped = new Map<string, (string | null)[]>();
      for (const row of rows) {
        const key = keys.get(serviceName(row))!;
        const amounts = grouped.get(key) ?? [];
        amounts.push(normalizeDecimal(row.amount));
        grouped.set(key, amounts);
      }
      const amounts: Record<string, string | null> = {};
      const values: Record<string, number | null> = {};
      for (const service of services) {
        amounts[service.key] = sumDecimalAmounts(grouped.get(service.key) ?? []);
        values[service.key] = plotAmount(amounts[service.key]);
      }
      const providerPoints = [...pointRecords]
        .filter(([time]) => dayStart(time) === day)
        .map(([, amount]) => amount);
      const rowTotal = sumDecimalAmounts(rows.map((row) => row.amount));
      const totalAmount = providerPoints.length ? sumDecimalAmounts(providerPoints) : rowTotal;
      const total = plotAmount(totalAmount);
      const observed =
        totalAmount !== null || Object.values(amounts).some((amount) => amount !== null);
      const completeDay =
        day >= start && day + DAY <= end && Number.isFinite(generated) && day + DAY <= generated;
      const complete =
        sourceIsDaily &&
        completeDay &&
        !globalIncomplete &&
        rows.length > 0 &&
        rowTotal !== null &&
        totalAmount !== null &&
        rowTotal === totalAmount &&
        total !== null &&
        [...grouped.keys()].every((key) => amounts[key] !== null && values[key] !== null);
      return {
        timestamp: new Date(day).toISOString(),
        values,
        amounts,
        totalAmount,
        total,
        coverage: !observed ? "unavailable" : complete ? "complete" : "partial",
      };
    },
  );
  const hasPoints = report.points.some((point) => currencyCode(point.currency) === code);
  const hasSource = totals.length > 0 || selectedRows.length > 0 || hasPoints;
  const rowSum = sumDecimalAmounts(selectedRows.map((row) => row.amount));
  const partial =
    globalIncomplete ||
    (hasSource &&
      (!sourceIsDaily ||
        authoritative === null ||
        rowSum !== authoritative ||
        points.some((point) => point.coverage !== "complete")));
  const value = plotAmount(authoritative);
  return {
    currency: code,
    services,
    points,
    summary: {
      amount: authoritative,
      value,
      coverage: !hasSource
        ? "unavailable"
        : partial || authoritative === null || value === null
          ? "partial"
          : "complete",
    },
    partial: partial || (authoritative !== null && value === null),
  };
}
