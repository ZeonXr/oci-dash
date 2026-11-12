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
      <div className="chart-legend mb-2 flex gap-[18px] text-[11px] text-muted-foreground [&>span]:flex [&>span]:items-center [&>span]:gap-[5px]">
        {mode === "cpu" ? (
          <span>
            <i className="legend-dot size-1.5 rounded-full bg-primary" />
            CPU 使用率
          </span>
        ) : (
          <>
            <span>
              <i className="legend-dot size-1.5 rounded-full bg-primary" />
              发送
            </span>
            <span>
              <i className="legend-dot green size-1.5 rounded-full bg-[#58baa7]" />
              接收
            </span>
          </>
        )}
        <span className="grow min-w-0 flex-1" />
        <span>{mode === "cpu" ? "%" : "MiB / 采样区间"}</span>
      </div>
      <div
        className="chart-wrap h-[250px] min-w-0 max-[620px]:h-[220px] [&_.recharts-cartesian-axis-tick-value]:fill-muted-foreground [&_.recharts-cartesian-axis-tick-value]:text-[10px] [&_.recharts-cartesian-grid_line]:stroke-border"
        role="img"
        aria-label={mode === "cpu" ? "CPU 使用率时间趋势" : "网络发送与接收时间趋势"}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 10, left: -15, bottom: 4 }}>
            <defs>
              <linearGradient id={`chart-fill-${mode}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.12} />
                <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.015} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={(value) => tickFormat.format(new Date(value))}
              axisLine={false}
              tickLine={false}
              minTickGap={55}
              tickMargin={12}
            />
            <YAxis
              domain={mode === "cpu" ? [0, 100] : [0, "auto"]}
              axisLine={false}
              tickLine={false}
              tickCount={4}
              tickFormatter={(value) => number(value, 1)}
            />
            <Tooltip
              contentStyle={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--text)",
              }}
              labelFormatter={(value) => formatDate(String(value), true)}
              formatter={(value, name) => [
                `${number(Number(value), 2)} ${mode === "cpu" ? "%" : "MiB"}`,
                name === "cpu" ? "CPU" : name === "sent" ? "发送" : "接收",
              ]}
            />
            <Area
              type="monotone"
              dataKey={mode === "cpu" ? "cpu" : "sent"}
              stroke="var(--primary)"
              strokeWidth={2}
              fill={`url(#chart-fill-${mode})`}
              isAnimationActive={false}
              connectNulls={false}
            />
            {mode === "network" && (
              <Line
                type="monotone"
                dataKey="received"
                stroke="#58baa7"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="chart-note mt-2.5 text-[11px] text-muted-foreground">
        {data.note || "数据来源：OCI 原生监控"}
      </p>
    </div>
  );
}
