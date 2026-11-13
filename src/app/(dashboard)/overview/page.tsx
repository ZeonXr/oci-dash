"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
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
import {
  Card,
  EmptyState,
  ErrorState,
  RefreshButton,
  LoadingState,
  PageHeader,
  Select,
} from "@/components/ui";
import { Button as LinkButton } from "@/components/ui/button";

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
    <div
      className="overview-panel-content flex min-w-0 flex-col gap-3"
      aria-busy={query.refreshing}
    >
      {query.error && (
        <LinkButton
          variant="outline"
          size="sm"
          className="overview-retry self-start"
          type="button"
          onClick={query.retry}
          title={query.error}
        >
          更新失败 · 重试
        </LinkButton>
      )}
      {children}
    </div>
  );
}

export default function OverviewPage() {
  const { accounts, accountsLoading, accountsReady, accountsError, reloadAccounts } = useApp();
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
  const enabled = accountsReady && accounts.length > 0;
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
  const generated = [traffic.data?.generatedAt, costs.data?.generatedAt, cpu.data?.generatedAt]
    .filter((time): time is string => Boolean(time) && Number.isFinite(Date.parse(time!)))
    .sort();
  const periodNote = periodNames[period];
  const trafficNote =
    trafficData?.summary.coverage === "partial" ? periodNote + " · 已获取小计" : periodNote;
  const detailQuery = accountId ? "?accountId=" + encodeURIComponent(accountId) : "";
  return (
    <div className="data-overview flex flex-col gap-6 *:data-[slot=page-heading]:mb-0 [--overview-teal:#39a99c] [--overview-cpu-1:#d1e2fc] [--overview-cpu-2:#92b7f0] [--overview-cpu-4:#1e57a4] dark:[--overview-teal:#70d1c3] dark:[--overview-cpu-1:#3a567b] dark:[--overview-cpu-2:#6997d6] dark:[--overview-cpu-4:#a1c3fa]">
      <PageHeader
        title="数据总览"
        description={
          range.startDate.replaceAll("-", ".") +
          " — " +
          range.endDate.replaceAll("-", ".") +
          " · UTC"
        }
      >
        <RefreshButton
          updatedAt={generated[0]}
          disabled={!enabled}
          onClick={async () => {
            const next = dateRange(period);
            if (next.startDate !== range.startDate || next.endDate !== range.endDate) {
              setRange(next);
              await cpu.refresh();
            } else await Promise.all([traffic.refresh(), costs.refresh(), cpu.refresh()]);
          }}
        />
      </PageHeader>
      <div className="analytics-controls flex flex-wrap items-center gap-3">
        <Select
          aria-label="总览账号"
          value={accountId}
          onValueChange={setAccount}
          disabled={!accountsReady}
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
          onValueChange={(next) => {
            const value = next as Period;
            setPeriod(value);
            setRange(dateRange(value));
          }}
        >
          <option value="7d">近 7 日</option>
          <option value="30d">近 30 日</option>
          <option value="month">本月</option>
        </Select>
      </div>
      {accountsError && (
        <ErrorState message={`账号读取失败：${accountsError}`} retry={reloadAccounts} />
      )}
      {accountsLoading ? (
        <LoadingState />
      ) : !accountsReady ? null : !accounts.length ? (
        <Card>
          <EmptyState
            title="添加账号后查看用量"
            description="连接 OCI 账号，即可读取流量、CPU 和费用记录。"
            action={
              <LinkButton asChild>
                <Link href="/settings/accounts">添加账号</Link>
              </LinkButton>
            }
          />
        </Card>
      ) : (
        <>
          <div className="overview-summaries grid grid-cols-3 gap-4 max-md:grid-cols-1">
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
          <div className="overview-chart-grid grid grid-cols-[minmax(0,2fr)_minmax(280px,1fr)] items-stretch gap-6 max-xl:grid-cols-[minmax(0,1.65fr)_minmax(250px,1fr)] max-xl:gap-4 max-md:grid-cols-1">
            <Card
              className="overview-panel overview-flow min-w-0"
              title="收发流量趋势"
              action={
                <div className="overview-panel-actions flex items-center gap-2 max-md:gap-1">
                  {traffic.data && <AnalyticsStatusNote report={traffic.data} />}
                  <OverviewLink href={"/traffic" + detailQuery}>流量明细</OverviewLink>
                </div>
              }
            >
              <PanelContent query={traffic}>
                {trafficData && <TrafficTrend data={trafficData} />}
              </PanelContent>
            </Card>
            <Card className="overview-panel overview-rank min-w-0" title="实例流量排行">
              <PanelContent query={traffic}>
                {trafficData && <TrafficRanking data={trafficData} />}
              </PanelContent>
            </Card>
            <Card
              className="overview-panel overview-load min-w-0"
              title="实例负载"
              action={
                <div className="overview-panel-actions flex items-center gap-2 max-md:gap-1">
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
              className="overview-panel overview-cost min-w-0"
              title="费用走势"
              action={
                <div className="overview-panel-actions flex items-center gap-2 max-md:gap-1">
                  {costs.data && <AnalyticsStatusNote report={costs.data} />}
                  <OverviewLink href={"/costs" + detailQuery}>费用明细</OverviewLink>
                </div>
              }
            >
              <PanelContent query={costs}>
                {costs.data && (
                  <>
                    <div className="overview-cost-summary flex flex-wrap items-baseline gap-2 text-xs text-muted-foreground [&>strong]:text-2xl [&>strong]:font-semibold [&>strong]:text-foreground [&>strong]:tabular-nums [&>strong]:wrap-anywhere *:data-[slot=select-trigger]:w-auto">
                      <strong title={costData?.summary.amount ?? undefined}>
                        {displayCost(costData?.summary.amount)}
                      </strong>
                      {currencies.length > 1 ? (
                        <Select
                          aria-label="总览费用币种"
                          value={selectedCurrency}
                          onValueChange={setCurrency}
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
                      <p className="overview-panel-note text-xs text-muted-foreground">
                        已报告费用 · 明细不完整
                      </p>
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
