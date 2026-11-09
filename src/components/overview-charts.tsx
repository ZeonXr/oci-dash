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
import { Card, EmptyState } from "./ui";
import type { CostOverviewData, CostOverviewDay, TrafficOverviewData } from "./overview-data";

const dayLabel = (value: string) => value.slice(5, 10).replace("-", "/");
const chartTick = { fill: "var(--muted)", fontSize: 10 };
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
    <Link href={href} className="overview-detail-link">
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
    <div className="overview-sparkline" aria-hidden="true">
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
    <Card className="overview-summary">
      <div className="overview-summary-copy">
        <h2>{label}</h2>
        <div className="overview-summary-value" aria-busy={loading}>
          <strong>{loading && value == null ? "…" : analyticsNumber(value, 1)}</strong>
          <span>{unit}</span>
        </div>
        <p>{note}</p>
      </div>
      <Sparkline values={values} color={color} />
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
      <div className="overview-chart-meta">
        <div className="overview-chart-legend">
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
        <span className="overview-chart-total">
          {data.summary.coverage === "complete" ? "合计" : "已获取"}{" "}
          {analyticsNumber(data.summary.totalGiB, 1)} GiB
        </span>
      </div>
      <div className="overview-traffic-plot" role="img" aria-label="每日发送与接收流量，单位 GiB">
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
                  <div className="overview-tooltip">
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
      <p className="overview-chart-caption">
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
      <p className="overview-panel-note">按发送 + 接收汇总{partial ? " · 已获取小计" : ""}</p>
      <ol className="overview-ranking" aria-label="实例流量排行">
        {rows.map((row) => {
          const share =
            row.totalGiB !== null && denominator > 0 ? (row.totalGiB / denominator) * 100 : null;
          const flag = regionCountryCode(row.region);
          return (
            <li key={row.instanceId}>
              <div className="overview-ranking-label">
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
              <div className="overview-ranking-track" aria-hidden="true">
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
        <button
          type="button"
          className="overview-expand"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
        >
          {expanded ? "收起" : `查看全部 ${data.ranking.length} 台`}
        </button>
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
        className="overview-cost-plot"
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
                  <div className="overview-tooltip">
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
      <div className="overview-chart-legend overview-cost-legend">
        {data.services.map((service, index) => (
          <span key={service.key}>
            <i style={{ background: chartColors[index % chartColors.length] }} />
            {service.label}
          </span>
        ))}
      </div>
      <p className="overview-panel-note">
        {data.summary.value === 0 ? "本期已报告费用为 0" : "最近两日可能继续补报"}
      </p>
    </>
  );
}

export { utcTimestamp };
