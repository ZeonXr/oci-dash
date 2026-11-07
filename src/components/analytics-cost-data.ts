import type { CostPoint, CostReport, CostRow, CostTotal } from "@/lib/analytics-contracts";
import { normalizeDecimal, sumDecimalAmounts } from "@/lib/decimal";

export interface CostGroup {
  key: string;
  accountId: string;
  accountName: string;
  region: string | null;
  service: string | null;
  resourceId: string | null;
  resourceName: string | null;
  currency: string | null;
  amount: string | null;
}

export function groupCostRows(rows: CostRow[], mode: "service" | "resource"): CostGroup[] {
  const groups = new Map<string, { row: CostRow; values: (string | null)[] }>();
  rows.forEach((row, index) => {
    // A missing currency cannot authorize adding amounts from distinct records.
    const identity =
      mode === "service"
        ? [row.service, row.currency]
        : [
            row.accountId,
            row.region,
            row.service,
            row.resourceId,
            row.resourceId ? null : row.resourceName,
            row.currency,
            row.currency ? null : index,
          ];
    const key = JSON.stringify(identity);
    const group = groups.get(key);
    if (group) {
      group.values.push(row.amount);
      if (!group.row.resourceName && row.resourceName)
        group.row = { ...group.row, resourceName: row.resourceName };
    } else groups.set(key, { row, values: [row.amount] });
  });
  return [...groups.entries()].map(([key, group]) => ({
    ...group.row,
    key,
    amount: group.row.currency
      ? sumDecimalAmounts(group.values)
      : mode === "resource" && group.values.length === 1
        ? group.row.amount
        : null,
  }));
}

export function costSubtotals(rows: CostRow[]): CostTotal[] {
  const groups = new Map<string | null, (string | null)[]>();
  for (const row of rows) {
    const values = groups.get(row.currency) || [];
    values.push(row.amount);
    groups.set(row.currency, values);
  }
  return [...groups].map(([currency, values]) => ({
    currency,
    amount: currency ? sumDecimalAmounts(values) : null,
  }));
}

export function costTrend(rows: CostRow[]): CostPoint[] {
  const groups = new Map<
    string,
    { currency: string; timestamp: string; values: (string | null)[] }
  >();
  for (const row of rows) {
    if (!row.currency) continue;
    const timestamp = new Date(row.timestamp).toISOString();
    const key = JSON.stringify([row.currency, timestamp]);
    const group = groups.get(key);
    if (group) group.values.push(row.amount);
    else groups.set(key, { currency: row.currency, timestamp, values: [row.amount] });
  }
  return [...groups.values()].map((group) => ({
    currency: group.currency,
    timestamp: group.timestamp,
    amount: sumDecimalAmounts(group.values),
  }));
}

export function costChartPoints(report: CostReport, points: CostPoint[], currency: string) {
  const values = new Map(
    points
      .filter((point) => point.currency === currency)
      .map((point) => [new Date(point.timestamp).toISOString(), point.amount]),
  );
  const cursor = new Date(report.range.startTime);
  const end = Date.parse(report.range.endTime);
  const result: { timestamp: string; cost: number | null }[] = [];
  // A point absent from the provider response stays unknown, including between two known days.
  for (let count = 0; cursor.getTime() < end && count < 740; count++) {
    const timestamp = cursor.toISOString();
    const amount = values.get(timestamp);
    const cost = amount == null ? null : Number(amount);
    result.push({ timestamp, cost: cost != null && Number.isFinite(cost) ? cost : null });
    if (report.range.granularity === "monthly") cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    else cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

export function compareCostAmounts(left: string | null, right: string | null) {
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const difference = sumDecimalAmounts([
    left,
    right.startsWith("-") ? right.slice(1) : `-${right}`,
  ]);
  return !difference || difference === "0" ? 0 : difference.startsWith("-") ? -1 : 1;
}

export function displayCost(amount: string | null | undefined) {
  const normalized = normalizeDecimal(amount);
  if (normalized == null) return "—";
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = (negative ? normalized.slice(1) : normalized).split(".");
  if (whole === "0" && fraction.length > 4 && fraction.startsWith("0000"))
    return negative ? "> −0.0001" : "< 0.0001";
  // Round for display using decimal digits; aggregation and exact tooltip values stay unchanged.
  const scaled =
    BigInt(whole + fraction.slice(0, 4).padEnd(4, "0")) +
    (fraction.length > 4 && fraction[4] >= "5" ? 1n : 0n);
  const integer = (scaled / 10000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const decimals = (scaled % 10000n).toString().padStart(4, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${negative && scaled !== 0n ? "−" : ""}${integer}.${decimals}`;
}
