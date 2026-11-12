"use client";

import { useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { regionCountryCode } from "@/lib/region-countries";
import { instanceHref } from "./format";
import { analyticsNumber, utcTimestamp } from "./analytics-chart";
import { displayCost } from "./analytics-cost-data";
import { EmptyState } from "./ui";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import type { CostOverviewData, CostOverviewDay, TrafficOverviewData } from "./overview-data";

const dayLabel = (value: string) => value.slice(5, 10).replace("-", "/");
const chartTick = { fill: "var(--muted-foreground)", fontSize: 10 };
const chartColors = [
  "var(--overview-cpu-4)",
  "var(--primary)",
  "var(--overview-cpu-1)",
  "var(--overview-teal)",
  "var(--overview-cpu-2)",
  "var(--warning)",
];

export function OverviewLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="overview-detail-link inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-primary hover:underline"
    >
      {children} <ArrowUpRight size={13} aria-hidden="true" />
    </Link>
  );
}

export function Sparkline({
  values,
  color = "var(--primary)",
}: {
  values: (number | null)[];
  color?: string;
}) {
  const id = useId();
  if (!values.some((value) => value !== null)) return null;
  return (
    <div
      className="overview-sparkline h-10 w-[94px] shrink-0 max-xl:w-[72px] max-xl:overflow-hidden max-md:w-[94px] max-md:overflow-visible"
      aria-hidden="true"
    >
      <AreaChart
        width={94}
        height={40}
        data={values.map((value) => ({ value }))}
        margin={{ top: 3, right: 2, left: 2, bottom: 2 }}
        accessibilityLayer={false}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.14} />
            <stop offset="100%" stopColor={color} stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <YAxis domain={[0, "auto"]} hide />
        <Area
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={1.8}
          fill={`url(#${id})`}
          connectNulls={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </div>
  );
}

export function OverviewSummary({
  label,
  value,
  unit,
  note,
  values,
  loading,
  color,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  note: string;
  values: (number | null)[];
  loading?: boolean;
  color?: string;
}) {
  return (
    <Card className="overview-summary gap-0">
      <CardContent className="flex items-center justify-between gap-3">
        <div className="overview-summary-copy min-w-0 [&>h2]:text-sm [&>h2]:font-normal [&>h2]:text-muted-foreground [&>p]:mt-1 [&>p]:text-xs [&>p]:text-muted-foreground">
          <h2>{label}</h2>
          <div
            className="overview-summary-value flex items-baseline gap-1.5 tabular-nums [&>strong]:text-3xl [&>strong]:font-semibold [&>span]:text-sm [&>span]:text-muted-foreground"
            aria-busy={loading}
          >
            <strong>{loading && value == null ? "…" : analyticsNumber(value, 1)}</strong>
            <span>{unit}</span>
          </div>
          <p>{note}</p>
        </div>
        <Sparkline values={values} color={color} />
      </CardContent>
    </Card>
  );
}

export function TrafficTrend({ data }: { data: TrafficOverviewData }) {
  const [shown, setShown] = useState({ sent: true, received: true });
  const series = [
    { key: "sent" as const, dataKey: "sentGiB", label: "发送", color: "var(--primary)" },
    {
      key: "received" as const,
      dataKey: "receivedGiB",
      label: "接收",
      color: "var(--overview-teal)",
    },
  ];
  const hasSamples = data.points.some(
    (point) => point.sentGiB !== null || point.receivedGiB !== null,
  );
  if (!hasSamples) return <EmptyState title="暂无流量数据" />;
  return (
    <>
      <div className="overview-chart-meta flex flex-wrap items-center justify-between gap-3">
        <div className="overview-chart-legend flex flex-wrap items-center gap-3.5 text-[11px] text-muted-foreground [&>span]:inline-flex [&>span]:items-center [&>span]:gap-1.5 [&>button]:inline-flex [&>button]:items-center [&>button]:gap-1.5 [&>button]:border-0 [&>button]:bg-transparent [&>button]:p-0 [&>button[aria-pressed=false]]:opacity-40 [&_i]:size-1.5 [&_i]:shrink-0 [&_i]:rounded-full">
          {series.map((item) => (
            <button
              key={item.key}
              type="button"
              aria-label={`显示${item.label}流量`}
              aria-pressed={shown[item.key]}
              onClick={() =>
                setShown((current) =>
                  current[item.key] && !current[item.key === "sent" ? "received" : "sent"]
                    ? current
                    : { ...current, [item.key]: !current[item.key] },
                )
              }
            >
              <i style={{ background: item.color }} /> {item.label}
            </button>
          ))}
        </div>
        <span className="overview-chart-total text-xs text-foreground tabular-nums">
          {data.summary.coverage === "complete" ? "合计" : "已获取"}{" "}
          {analyticsNumber(data.summary.totalGiB, 1)} GiB
        </span>
      </div>
      <div
        className="overview-traffic-plot h-[204px] w-full min-w-0 min-[1800px]:h-[250px]"
        role="img"
        aria-label="每日发送与接收流量，单位 GiB"
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <AreaChart data={data.points} margin={{ top: 12, right: 12, left: 0, bottom: 8 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={dayLabel}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              tickMargin={14}
              minTickGap={35}
            />
            <YAxis
              width={42}
              domain={[0, "auto"]}
              tickFormatter={(value) => analyticsNumber(value, 1)}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              label={{ value: "GiB", position: "insideTopLeft", offset: 0, ...chartTick }}
            />
            <Tooltip
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as
                  TrafficOverviewData["points"][number] | undefined;
                if (!active || !point) return null;
                return (
                  <div className="overview-tooltip max-w-[300px] rounded-lg border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md [&>strong]:mb-1.5 [&>strong]:block [&>strong]:font-semibold [&>small]:mt-1 [&>small]:block [&>small]:text-muted-foreground">
                    <strong>{point.timestamp.slice(0, 10)} · UTC</strong>
                    <p>发送 {analyticsNumber(point.sentGiB, 3)} GiB</p>
                    <p>接收 {analyticsNumber(point.receivedGiB, 3)} GiB</p>
                    {point.coverage !== "complete" && <small>部分数据 · 已观测小计</small>}
                  </div>
                );
              }}
            />
            {series.map((item) => (
              <Area
                key={item.key}
                type="monotone"
                dataKey={item.dataKey}
                hide={!shown[item.key]}
                stroke={item.color}
                strokeWidth={2.5}
                fill={item.color}
                fillOpacity={0.07}
                dot={
                  data.points.length <= 14
                    ? { r: 3, fill: "var(--surface)", strokeWidth: 1.8 }
                    : false
                }
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="overview-chart-caption text-xs text-muted-foreground [&>span]:mr-1 [&>span]:text-primary">
        {data.peak ? (
          <>
            <span>{dayLabel(data.peak.timestamp)}</span> 流量最高，为{" "}
            {analyticsNumber(data.peak.totalGiB, 1)} GiB
          </>
        ) : (
          "仅显示已取得的网卡流量"
        )}
      </p>
    </>
  );
}

export function TrafficRanking({ data }: { data: TrafficOverviewData }) {
  const [expanded, setExpanded] = useState(false);
  const rows = expanded ? data.ranking : data.ranking.slice(0, 5);
  // Include every observed byte in the denominator, even when another instance
  // has only one readable direction and cannot display a two-way total yet.
  const denominator = data.summary.totalGiB ?? 0;
  const partial = data.summary.coverage !== "complete";
  if (!rows.length) return <EmptyState title="暂无实例流量" />;
  return (
    <>
      <p className="overview-panel-note text-xs text-muted-foreground">
        按发送 + 接收汇总{partial ? " · 已获取小计" : ""}
      </p>
      <ol
        className="overview-ranking m-0 flex list-none flex-col gap-3 p-0 [&>li]:min-w-0 [&>li>p]:text-[10px] [&>li>p]:text-muted-foreground"
        aria-label="实例流量排行"
      >
        {rows.map((row) => {
          const share =
            row.totalGiB !== null && denominator > 0 ? (row.totalGiB / denominator) * 100 : null;
          const flag = regionCountryCode(row.region);
          return (
            <li key={row.instanceId}>
              <div className="overview-ranking-label flex items-center justify-between gap-2.5 text-xs [&>a]:flex [&>a]:min-w-0 [&>a]:items-center [&>a]:gap-1.5 [&>a:hover]:text-primary [&>a>span]:truncate [&_img]:h-3 [&_img]:w-4 [&_img]:shrink-0 [&_img]:border [&_img]:border-border [&_img]:object-cover [&>strong]:shrink-0 [&>strong]:font-medium [&>strong]:tabular-nums">
                <Link
                  href={instanceHref(row.instanceId)}
                  title={`${row.instanceName} · ${row.accountName} · ${row.region}`}
                >
                  {flag && (
                    <img
                      src={`/flags/${flag}.svg`}
                      width={16}
                      height={12}
                      alt=""
                      aria-hidden="true"
                    />
                  )}
                  <span>{row.instanceName}</span>
                </Link>
                <strong>{analyticsNumber(row.totalGiB, 1)} GiB</strong>
              </div>
              <div
                className="overview-ranking-track my-1.5 h-2 overflow-hidden rounded bg-canvas [&>span]:block [&>span]:h-full [&>span]:rounded-[inherit] [&>span]:bg-primary"
                aria-hidden="true"
              >
                <span style={{ width: `${Math.max(0, Math.min(100, share ?? 0))}%` }} />
              </div>
              <p>
                {share !== null
                  ? `占${partial ? "已获取" : "总"}流量 ${analyticsNumber(share, 1)}%`
                  : row.totalGiB === 0
                    ? "无流量"
                    : "数据不完整"}
              </p>
            </li>
          );
        })}
      </ol>
      {data.ranking.length > 5 && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="overview-expand self-start"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : `查看全部 ${data.ranking.length} 台`}
        </Button>
      )}
    </>
  );
}

export function CostTrend({ data, generatedAt }: { data: CostOverviewData; generatedAt: string }) {
  const hasBreakdown = data.points.some((point) =>
    Object.values(point.values).some((value) => value !== null),
  );
  if (!hasBreakdown) return <EmptyState title="暂无服务费用明细" />;
  const cutoff = Date.parse(generatedAt) - 48 * 3_600_000;
  return (
    <>
      <div
        className="overview-cost-plot h-[138px] w-full min-w-0 max-md:h-[170px]"
        role="img"
        aria-label={`每日服务费用，币种 ${data.currency}`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <BarChart
            data={data.points}
            stackOffset="sign"
            margin={{ top: 12, right: 4, left: 0, bottom: 0 }}
            barCategoryGap="36%"
          >
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="timestamp"
              tickFormatter={dayLabel}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              minTickGap={16}
            />
            <YAxis
              width={40}
              tickFormatter={(value) => analyticsNumber(value, 2)}
              axisLine={false}
              tickLine={false}
              tick={chartTick}
              domain={[(min: number) => Math.min(0, min), (max: number) => (max === 0 ? 1 : max)]}
            />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Tooltip
              cursor={{ fill: "var(--soft)" }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload as CostOverviewDay | undefined;
                if (!active || !point) return null;
                return (
                  <div className="overview-tooltip max-w-[300px] rounded-lg border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-md [&>strong]:mb-1.5 [&>strong]:block [&>strong]:font-semibold [&>small]:mt-1 [&>small]:block [&>small]:text-muted-foreground">
                    <strong>
                      {point.timestamp.slice(0, 10)} · {data.currency}
                    </strong>
                    {data.services.map((service) => (
                      <p key={service.key}>
                        {service.label} {displayCost(point.amounts[service.key])}
                      </p>
                    ))}
                    <p>已报告合计 {displayCost(point.totalAmount)}</p>
                    {point.coverage !== "complete" && <small>部分数据</small>}
                    {Date.parse(point.timestamp) >= cutoff && <small>账单可能继续补报</small>}
                  </div>
                );
              }}
            />
            {data.services.map((service, index) => (
              <Bar
                key={service.key}
                dataKey={(point: CostOverviewDay) => point.values[service.key]}
                name={service.label}
                stackId="cost"
                fill={chartColors[index % chartColors.length]}
                maxBarSize={28}
                isAnimationActive={false}
              >
                {data.points.map((point) => (
                  <Cell
                    key={point.timestamp}
                    fillOpacity={Date.parse(point.timestamp) >= cutoff ? 0.55 : 1}
                  />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="overview-chart-legend overview-cost-legend flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-muted-foreground [&>span]:inline-flex [&>span]:max-w-full [&>span]:items-center [&>span]:gap-1.5 [&>span]:wrap-anywhere [&_i]:size-1.5 [&_i]:shrink-0 [&_i]:rounded-full">
        {data.services.map((service, index) => (
          <span key={service.key}>
            <i style={{ background: chartColors[index % chartColors.length] }} />
            {service.label}
          </span>
        ))}
      </div>
      <p className="overview-panel-note text-xs text-muted-foreground">
        {data.summary.value === 0 ? "本期已报告费用为 0" : "最近两日可能继续补报"}
      </p>
    </>
  );
}

export { utcTimestamp };
