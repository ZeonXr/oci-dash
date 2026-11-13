"use client";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { MetricsResult } from "@/lib/contracts";
import { EmptyState, ErrorState, LoadingState } from "./ui";
import { formatDate, number } from "./format";
import {
  ChartFrame,
  ChartLegend,
  ChartLegendItem,
  ChartTooltip,
  chartTick,
} from "./chart-presentation";
export function MetricsChart({
  data,
  loading,
  error,
  mode = "cpu",
}: {
  data?: MetricsResult;
  loading?: boolean;
  error?: string | null;
  mode?: "cpu" | "network";
}) {
  if (loading && !data) return <LoadingState label="正在读取监控指标…" />;
  if (error && !data) return <ErrorState message={error} />;
  if (!data?.available || !data.points.length)
    return (
      <EmptyState
        title="暂无监控数据"
        description={data?.note || "OCI 尚未返回此实例的监控指标。"}
      />
    );
  const points = data.points
    .map((p) => ({
      ...p,
      received: p.receivedBytes == null ? null : p.receivedBytes / 1024 / 1024,
      sent: p.sentBytes == null ? null : p.sentBytes / 1024 / 1024,
    }))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const spansDays =
    points.length > 1 &&
    Date.parse(points[points.length - 1].timestamp) - Date.parse(points[0].timestamp) >
      36 * 60 * 60 * 1000;
  const tickFormat = new Intl.DateTimeFormat(
    "zh-CN",
    spansDays ? { month: "2-digit", day: "2-digit" } : { hour: "2-digit", minute: "2-digit" },
  );
  return (
    <div>
      {error && <ErrorState message={error} />}
      <ChartLegend className="chart-legend mb-2">
        {mode === "cpu" ? (
          <ChartLegendItem color="var(--chart-sent)">CPU 使用率</ChartLegendItem>
        ) : (
          <>
            <ChartLegendItem color="var(--chart-sent)">发送</ChartLegendItem>
            <ChartLegendItem color="var(--chart-received)">接收</ChartLegendItem>
          </>
        )}
        <span className="ml-auto">{mode === "cpu" ? "%" : "MiB / 采样区间"}</span>
      </ChartLegend>
      <ChartFrame
        className="chart-wrap"
        aria-label={mode === "cpu" ? "CPU 使用率时间趋势" : "网络发送与接收时间趋势"}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 10, left: -15, bottom: 4 }}>
            <defs>
              <linearGradient id={`chart-fill-${mode}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--chart-sent)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--chart-sent)" stopOpacity={0.015} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(value) => tickFormat.format(new Date(value))}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              minTickGap={55}
              tickMargin={12}
            />
            <YAxis
              domain={mode === "cpu" ? [0, 100] : [0, "auto"]}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              tickCount={4}
              tickFormatter={(value) => number(value, 1)}
            />
            <Tooltip
              content={({ active, label: timestamp, payload, accessibilityLayer }) => {
                if (!active || !payload?.length) return null;
                return (
                  <ChartTooltip
                    role={accessibilityLayer ? "status" : undefined}
                    aria-live={accessibilityLayer ? "assertive" : undefined}
                  >
                    <p className="recharts-tooltip-label font-semibold">
                      {formatDate(String(timestamp), true)}
                    </p>
                    {payload.map((entry) => (
                      <div key={String(entry.dataKey)} className="flex justify-between gap-4">
                        <span style={{ color: entry.color }}>
                          {entry.name === "cpu" ? "CPU" : entry.name === "sent" ? "发送" : "接收"}
                        </span>
                        <strong className="font-semibold tabular-nums">
                          {number(Number(entry.value), 2)} {mode === "cpu" ? "%" : "MiB"}
                        </strong>
                      </div>
                    ))}
                  </ChartTooltip>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey={mode === "cpu" ? "cpu" : "sent"}
              stroke="var(--chart-sent)"
              strokeWidth={2}
              fill={`url(#chart-fill-${mode})`}
              isAnimationActive={false}
              connectNulls={false}
            />
            {mode === "network" && (
              <Line
                type="monotone"
                dataKey="received"
                stroke="var(--chart-received)"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </ChartFrame>
      <p className="chart-note mt-2 text-xs text-muted-foreground">
        {data.note || "数据来源：OCI 原生监控"}
      </p>
    </div>
  );
}
