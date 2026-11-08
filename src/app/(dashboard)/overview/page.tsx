"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import type { CostReport, TrafficReport } from "@/lib/analytics-contracts";
import type { CpuReport } from "@/lib/cpu-contracts";
import { useApp } from "@/components/app-provider";
import { useOverviewQuery } from "@/components/overview-query";
import { overviewDateRange, trafficOverview, costOverview } from "@/components/overview-data";
import {
  CostTrend,
  OverviewLink,
  OverviewSummary,
  TrafficRanking,
  TrafficTrend,
} from "@/components/overview-charts";
import { CpuHeatmap } from "@/components/cpu-heatmap";
import { AnalyticsStatusNote } from "@/components/analytics-status";
import { displayCost } from "@/components/analytics-cost-data";
import { UpdatedAt } from "@/components/updated-at";
import {
  Card,
  EmptyState,
  ErrorState,
  IconButton,
  LoadingState,
  PageHeader,
  Select,
} from "@/components/ui";
import "./overview.css";

type Period = "7d" | "30d" | "month";
function dateRange(period: Period, now = new Date()) {
  const range = overviewDateRange(now);
  if (period === "30d") {
    const first = new Date(range.endDate + "T00:00:00Z");
    first.setUTCDate(first.getUTCDate() - 29);
    range.startDate = first.toISOString().slice(0, 10);
  } else if (period === "month") {
    range.startDate = now.toISOString().slice(0, 7) + "-01";
    range.endDate = now.toISOString().slice(0, 10);
  }
  return range;
}
const periodNames: Record<Period, string> = { "7d": "近 7 日", "30d": "近 30 日", month: "本月" };

function PanelContent({
  query,
  children,
}: {
  query: {
    data?: unknown;
    loading: boolean;
    refreshing: boolean;
    error: string | null;
    retry: () => Promise<void>;
  };
  children: ReactNode;
}) {
  if (query.loading) return <LoadingState label="正在读取统计…" />;
  if (!query.data && query.error) return <ErrorState message={query.error} retry={query.retry} />;
  return (
    <div className="overview-panel-content" aria-busy={query.refreshing}>
      {query.error && (
        <button className="overview-retry" type="button" onClick={query.retry} title={query.error}>
          更新失败 · 重试
        </button>
      )}
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const { accounts, accountsLoading } = useApp();
  const [account, setAccount] = useState("");
  const [period, setPeriod] = useState<Period>("7d");
  const [range, setRange] = useState(() => dateRange("7d"));
  const [currency, setCurrency] = useState("");
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      const next = dateRange(period);
      setRange((current) =>
        current.startDate === next.startDate && current.endDate === next.endDate ? current : next,
      );
      timer = setTimeout(update, 86_400_000 - (Date.now() % 86_400_000) + 50);
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [period]);
  const accountId = accounts.some((item) => item.id === account) ? account : "";
  const enabled = !accountsLoading && accounts.length > 0;
  const query = new URLSearchParams({
    startDate: range.startDate,
    endDate: range.endDate,
    granularity: "daily",
  });
  if (accountId) query.set("accountId", accountId);
  const cpuQuery = new URLSearchParams();
  if (accountId) cpuQuery.set("accountId", accountId);
  const traffic = useOverviewQuery<TrafficReport>(
    enabled ? "/api/analytics/traffic?" + query : null,
  );
  const costs = useOverviewQuery<CostReport>(enabled ? "/api/analytics/costs?" + query : null);
  const cpu = useOverviewQuery<CpuReport>(enabled ? "/api/analytics/cpu?" + cpuQuery : null);
  const trafficData = useMemo(() => traffic.data && trafficOverview(traffic.data), [traffic.data]);
  const currencies = [
    ...new Set(
      (costs.data?.totals || []).flatMap((item) => (item.currency ? [item.currency] : [])),
    ),
  ].sort();
  const selectedCurrency = currencies.includes(currency) ? currency : currencies[0] || "";
  const costData = useMemo(
    () => (costs.data && selectedCurrency ? costOverview(costs.data, selectedCurrency) : undefined),
    [costs.data, selectedCurrency],
  );
  const refreshing = traffic.refreshing || costs.refreshing || cpu.refreshing;
  const generated = [traffic.data?.generatedAt, costs.data?.generatedAt, cpu.data?.generatedAt]
    .filter((time): time is string => Boolean(time) && Number.isFinite(Date.parse(time!)))
    .sort();
  const updateTitle = [
    "流量查询：" + (traffic.data?.generatedAt || "尚未取得"),
    "费用查询：" + (costs.data?.generatedAt || "尚未取得"),
    "CPU 查询：" + (cpu.data?.generatedAt || "尚未取得"),
    "显示已加载统计中最早的查询时间；费用上报可能延迟。",
  ].join("\n");
  const periodNote = periodNames[period];
  const trafficNote =
    trafficData?.summary.coverage === "partial" ? periodNote + " · 已获取小计" : periodNote;
  const detailQuery = accountId ? "?accountId=" + encodeURIComponent(accountId) : "";
  return (
    <div className="data-overview">
      <PageHeader
        title="数据总览"
        description={
          range.startDate.replaceAll("-", ".") +
          " — " +
          range.endDate.replaceAll("-", ".") +
          " · UTC"
        }
      >
        <Select
          aria-label="总览账号"
          value={accountId}
          onChange={(event) => setAccount(event.target.value)}
          disabled={accountsLoading}
        >
          <option value="">全部账号</option>
          {accounts.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="总览时间范围"
          value={period}
          title={
            period === "month" ? "本月包含今天，按完整小时累计" : "统计完整 UTC 日期，不含今天"
          }
          onChange={(event) => {
            const value = event.target.value as Period;
            setPeriod(value);
            setRange(dateRange(value));
          }}
        >
          <option value="7d">近 7 日</option>
          <option value="30d">近 30 日</option>
          <option value="month">本月</option>
        </Select>
        <UpdatedAt value={generated[0]} title={updateTitle} />
        <IconButton
          label="刷新总览"
          disabled={!enabled || refreshing}
          onClick={() => {
            const next = dateRange(period);
            if (next.startDate !== range.startDate || next.endDate !== range.endDate)
              setRange(next);
            else {
              void traffic.refresh();
              void costs.refresh();
            }
            void cpu.refresh();
          }}
        >
          <RefreshCw size={16} className={refreshing ? "spin" : undefined} />
        </IconButton>
      </PageHeader>
      {accountsLoading ? (
        <LoadingState />
      ) : !accounts.length ? (
        <Card>
          <EmptyState
            title="添加账号后查看用量"
            description="连接 OCI 账号，即可读取流量、CPU 和费用记录。"
            action={
              <Link href="/settings/accounts" className="button button-primary">
                添加账号
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="overview-summaries">
            <OverviewSummary
              label="发送流量"
              value={trafficData?.summary.sentGiB}
              unit="GiB"
              note={trafficNote}
              values={trafficData?.points.map((point) => point.sentGiB) || []}
              loading={traffic.loading}
            />
            <OverviewSummary
              label="接收流量"
              value={trafficData?.summary.receivedGiB}
              unit="GiB"
              note={trafficNote}
              values={trafficData?.points.map((point) => point.receivedGiB) || []}
              loading={traffic.loading}
              color="var(--overview-teal)"
            />
            <OverviewSummary
              label="平均 CPU"
              value={cpu.data?.summary.averageCpuPercent}
              unit="%"
              note={
                (cpu.data ? cpu.data.summary.instancesWithSamples + " 台有样本 · " : "") +
                "近 24 小时"
              }
              values={cpu.data?.points.map((point) => point.cpuPercent) || []}
              loading={cpu.loading}
            />
          </div>
          <div className="overview-chart-grid">
            <Card
              className="overview-panel overview-flow"
              title="收发流量趋势"
              action={
                <div className="overview-panel-actions">
                  {traffic.data && <AnalyticsStatusNote report={traffic.data} />}
                  <OverviewLink href={"/traffic" + detailQuery}>流量明细</OverviewLink>
                </div>
              }
            >
              <PanelContent query={traffic}>
                {trafficData && <TrafficTrend data={trafficData} />}
              </PanelContent>
            </Card>
            <Card className="overview-panel overview-rank" title="实例流量排行">
              <PanelContent query={traffic}>
                {trafficData && <TrafficRanking data={trafficData} />}
              </PanelContent>
            </Card>
            <Card
              className="overview-panel overview-load"
              title="实例负载"
              action={
                <div className="overview-panel-actions">
                  {cpu.data && <AnalyticsStatusNote report={cpu.data} />}
                  <OverviewLink href={"/instances" + detailQuery}>实例监控</OverviewLink>
                </div>
              }
            >
              <PanelContent query={cpu}>
                {cpu.data && <CpuHeatmap report={cpu.data} />}
              </PanelContent>
            </Card>
            <Card
              className="overview-panel overview-cost"
              title="费用走势"
              action={
                <div className="overview-panel-actions">
                  {costs.data && <AnalyticsStatusNote report={costs.data} />}
                  <OverviewLink href={"/costs" + detailQuery}>费用明细</OverviewLink>
                </div>
              }
            >
              <PanelContent query={costs}>
                {costs.data && (
                  <>
                    <div className="overview-cost-summary">
                      <strong title={costData?.summary.amount ?? undefined}>
                        {displayCost(costData?.summary.amount)}
                      </strong>
                      {currencies.length > 1 ? (
                        <Select
                          aria-label="总览费用币种"
                          value={selectedCurrency}
                          onChange={(event) => setCurrency(event.target.value)}
                        >
                          {currencies.map((code) => (
                            <option key={code} value={code}>
                              {code}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <span>{selectedCurrency || "币种未提供"}</span>
                      )}
                      <span>· {periodNote}</span>
                    </div>
                    {costData?.partial && (
                      <p className="overview-panel-note">已报告费用 · 明细不完整</p>
                    )}
                    {costData ? (
                      <CostTrend data={costData} generatedAt={costs.data.generatedAt} />
                    ) : (
                      <EmptyState title="暂无费用数据" />
                    )}
                  </>
                )}
              </PanelContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
