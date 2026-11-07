"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface AnalyticsChartPoint {
  timestamp: string;
  received?: number | null;
  sent?: number | null;
  cost?: number | null;
  coverage?: "complete" | "partial" | "unavailable";
}
export interface AnalyticsSeries {
  key: "received" | "sent" | "cost";
  label: string;
  color: string;
}
export const analyticsNumber = (value: number | null | undefined, digits = 3) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const threshold = 10 ** -digits;
  if (value > 0 && value < threshold) return `< ${threshold}`;
  if (value < 0 && value > -threshold) return `> −${threshold}`;
  return value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
};
export const utcTimestamp = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    hourCycle: "h23",
  }).format(new Date(value));

export function AnalyticsChart({
  points,
  series,
  unit,
  granularity,
  label,
}: {
  points: AnalyticsChartPoint[];
  series: AnalyticsSeries[];
  unit: string;
  granularity: "hourly" | "daily" | "monthly";
  label: string;
}) {
  const tick = (value: string) => {
    const date = new Date(value);
    return new Intl.DateTimeFormat("zh-CN", {
      ...(granularity === "monthly"
        ? { year: "2-digit", month: "2-digit" }
        : { month: "2-digit", day: "2-digit" }),
      ...(granularity === "hourly" ? { hour: "2-digit" } : {}),
      timeZone: "UTC",
      hourCycle: "h23",
    }).format(date);
  };
  return (
    <>
      <div className="chart-legend analytics-legend">
        {series.map((item) => (
          <span key={item.key}>
            <i className="legend-dot" style={{ background: item.color }} />
            {item.label}
          </span>
        ))}
        <span className="grow" />
        <span>{unit} · UTC</span>
      </div>
      <div className="chart-wrap analytics-chart" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 12, right: 18, left: 0, bottom: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={tick}
              axisLine={false}
              tickLine={false}
              minTickGap={45}
              tickMargin={12}
            />
            <YAxis
              domain={[(minimum: number) => Math.min(0, minimum), "auto"]}
              axisLine={false}
              tickLine={false}
              width={55}
              tickFormatter={(value) => analyticsNumber(value, 2)}
            />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--text)",
              }}
              labelFormatter={(value, entries) =>
                `${utcTimestamp(String(value))} UTC${entries.some((entry) => entry.payload?.coverage === "partial") ? " · 部分数据（已观测小计）" : ""}`
              }
              formatter={(value, name) => [
                `${analyticsNumber(Number(value), 4)} ${unit}`,
                series.find((item) => item.key === name)?.label || String(name),
              ]}
            />
            {series.map((item) => {
              const samples = points.filter(
                (point) => typeof point[item.key] === "number" && Number.isFinite(point[item.key]),
              ).length;
              return (
                <Line
                  key={item.key}
                  type="linear"
                  dataKey={item.key}
                  stroke={item.color}
                  strokeWidth={2}
                  dot={samples <= 31 ? { r: samples === 1 ? 3 : 2 } : false}
                  activeDot={{ r: 4 }}
                  isAnimationActive={false}
                  connectNulls={false}
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}
