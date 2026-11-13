"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleDollarSign } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import type { CostReport } from "@/lib/analytics-contracts";
import { useApp } from "@/components/app-provider";
import { useAccountFilter } from "@/components/account-filter";
import { useResource } from "@/components/api";
import { useAnalytics } from "@/components/analytics-query";
import { AnalyticsRange, analyticsRange, useAnalyticsRange } from "@/components/analytics-range";
import { AnalyticsChart } from "@/components/analytics-chart";
import { AnalyticsStatusNote } from "@/components/analytics-status";
import {
  compareCostAmounts,
  costChartPoints,
  costSubtotals,
  costTrend,
  displayCost,
  groupCostRows,
} from "@/components/analytics-cost-data";
import {
  Button,
  RefreshButton,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  Pagination,
  Select,
} from "@/components/ui";
import { TablePanel, SortableHeader } from "@/components/table";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Button as LinkButton } from "@/components/ui/button";
import { instanceHref, shortId } from "@/components/format";
import { RegionTag } from "@/components/region-label";

const missing = "__unknown__";
const matches = (selected: string, value: string | null) =>
  !selected || (selected === missing ? value == null : selected === value);

function CostsContent() {
  const { accounts, accountsLoading, accountsReady, accountsError, reloadAccounts } = useApp();
  const inventory = useResource<{ instances: InstanceSummary[] }>("/api/instances");
  const [account, setAccount] = useAccountFilter();
  const [filters, setFilters] = useState({ account, region: "", service: "" });
  const { region, service } = filters.account === account ? filters : { region: "", service: "" };
  const changeFilters = (updates: Partial<{ region: string; service: string }>) =>
    setFilters({ account, region, service, ...updates });
  const { range, setRange, refreshRange } = useAnalyticsRange();
  const [granularity, setGranularity] = useState<"daily" | "monthly">("daily");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [servicePage, setServicePage] = useState(1);
  const [servicePageSize, setServicePageSize] = useState(10);
  const [sort, setSort] = useState<"ascending" | "descending">("descending");
  const query = new URLSearchParams({
    startDate: range.startDate,
    endDate: range.endDate,
    granularity,
  });
  if (account) query.set("accountId", account);
  const url = !accountsReady || !accounts.length ? null : `/api/analytics/costs?${query}`;
  const report = useAnalytics<CostReport>(url);
  const data = report.data;
  const filtered = Boolean(region || service);
  const rows = useMemo(
    () =>
      (data?.rows || []).filter(
        (row) => matches(region, row.region) && matches(service, row.service),
      ),
    [data, region, service],
  );
  const regions = [
    ...new Set(
      (data?.rows || []).map((row) => row.region ?? missing).concat(region ? [region] : []),
    ),
  ].sort();
  const services = [
    ...new Set(
      (data?.rows || []).map((row) => row.service ?? missing).concat(service ? [service] : []),
    ),
  ].sort();
  const totals = useMemo(
    () => (filtered ? costSubtotals(rows) : data?.totals || []),
    [filtered, rows, data],
  );
  const points = useMemo(
    () => (filtered ? costTrend(rows) : data?.points || []),
    [filtered, rows, data],
  );
  const currencies = [
    ...new Set(totals.flatMap((total) => (total.currency ? [total.currency] : []))),
  ].sort();
  const serviceRows = useMemo(
    () =>
      groupCostRows(rows, "service").sort((a, b) => {
        const currencyOrder = (a.currency || "~").localeCompare(b.currency || "~");
        if (currencyOrder) return currencyOrder;
        if (a.amount == null) return b.amount == null ? a.key.localeCompare(b.key) : 1;
        if (b.amount == null) return -1;
        return (
          compareCostAmounts(b.amount, a.amount) || (a.service || "").localeCompare(b.service || "")
        );
      }),
    [rows],
  );
  const resourceRows = useMemo(
    () =>
      groupCostRows(rows, "resource").sort((a, b) => {
        const currencyOrder = (a.currency || "~").localeCompare(b.currency || "~");
        if (currencyOrder) return currencyOrder;
        if (a.amount == null) return b.amount == null ? a.key.localeCompare(b.key) : 1;
        if (b.amount == null) return -1;
        return (
          (sort === "ascending"
            ? compareCostAmounts(a.amount, b.amount)
            : compareCostAmounts(b.amount, a.amount)) || a.key.localeCompare(b.key)
        );
      }),
    [rows, sort],
  );
  const knownResources = useMemo(() => {
    const known = new Map<
      string,
      { instance: InstanceSummary; name: string; associated: boolean }
    >();
    for (const item of inventory.data?.instances || []) {
      known.set(item.id, { instance: item, name: item.displayName, associated: false });
      for (const volume of item.bootVolumes)
        known.set(volume.id, { instance: item, name: volume.name || "启动卷", associated: true });
      for (const vnic of item.vnics)
        known.set(vnic.id, { instance: item, name: vnic.name || "网卡", associated: true });
    }
    return known;
  }, [inventory.data]);
  useEffect(() => {
    setPage(1);
    setServicePage(1);
  }, [url, region, service]);
  useEffect(() => setPage(1), [pageSize, sort]);
  useEffect(() => setServicePage(1), [servicePageSize]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(resourceRows.length / pageSize)));
  const safeServicePage = Math.min(
    servicePage,
    Math.max(1, Math.ceil(serviceRows.length / servicePageSize)),
  );
  const subtotalLabel = filtered || data?.status === "partial" ? "已获取小计" : "已报告成本";
  return (
    <>
      <PageHeader title="成本分析" description="OCI 已报告成本，账单数据可能延迟约 48 小时。">
        {data && <AnalyticsStatusNote report={data} />}
        <RefreshButton
          updatedAt={data?.generatedAt}
          onClick={async () => {
            if (!refreshRange()) await report.refresh();
          }}
          disabled={!url}
        />
      </PageHeader>
      <div className="analytics-controls mb-6 flex flex-wrap items-center gap-3">
        <div className="analytics-filters contents *:data-[slot=select-trigger]:w-45 *:data-[slot=select-trigger]:max-w-full max-sm:*:data-[slot=select-trigger]:flex-1">
          <Select
            aria-label="成本账号"
            value={account}
            disabled={!accountsReady}
            onValueChange={(value) => {
              setAccount(value);
              setFilters({ account: value, region: "", service: "" });
            }}
          >
            <option value="">全部账号</option>
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
          <Select
            aria-label="成本区域"
            value={region}
            onValueChange={(value) => changeFilters({ region: value })}
          >
            <option value="">全部区域</option>
            {regions.map((item) => (
              <option key={item} value={item}>
                {item === missing ? "未提供区域" : item}
              </option>
            ))}
          </Select>
          <Select
            aria-label="成本服务"
            value={service}
            onValueChange={(value) => changeFilters({ service: value })}
          >
            <option value="">全部服务</option>
            {services.map((item) => (
              <option key={item} value={item}>
                {item === missing ? "未提供服务" : item}
              </option>
            ))}
          </Select>
          {filtered && (
            <Button
              variant="ghost"
              onClick={() => {
                changeFilters({ region: "", service: "" });
              }}
            >
              重置筛选
            </Button>
          )}
        </div>
        <div className="analytics-period contents *:data-[slot=select-trigger]:w-auto *:data-[slot=select-trigger]:min-w-28">
          <AnalyticsRange
            value={range}
            onChange={setRange}
            allowYear={granularity === "monthly"}
            fullMonths={granularity === "monthly"}
          />
          <Select
            aria-label="成本统计粒度"
            value={granularity}
            onValueChange={(value) => {
              const next = value as "daily" | "monthly";
              setGranularity(next);
              setRange(analyticsRange(next === "monthly" ? "last12Months" : "month"));
            }}
          >
            <option value="daily">按日</option>
            <option value="monthly">按月</option>
          </Select>
        </div>
      </div>
      {accountsError && (
        <ErrorState message={`账号读取失败：${accountsError}`} retry={reloadAccounts} />
      )}
      {report.error && <ErrorState message={report.error} retry={report.retry} />}
      {accountsLoading || report.loading ? (
        <LoadingState label="正在读取成本分析…" />
      ) : !accountsReady ? null : !accounts.length ? (
        <Card>
          <EmptyState
            title="先添加 OCI 账号"
            description="连接账号后，可读取该租户的已报告成本。"
            action={
              <LinkButton asChild>
                <Link href="/settings/accounts">管理账号</Link>
              </LinkButton>
            }
          />
        </Card>
      ) : data ? (
        <div className="stack analytics-content flex flex-col gap-5" aria-busy={report.refreshing}>
          {totals.length > 0 ? (
            <div className="analytics-metrics grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 max-sm:grid-cols-1">
              {totals.map((total) => (
                <MetricCard
                  key={total.currency || "unknown"}
                  label={`${total.currency || "币种未提供"} · ${subtotalLabel}`}
                  value={
                    <span title={total.amount || undefined}>
                      {total.currency ? displayCost(total.amount) : "—"}
                    </span>
                  }
                  icon={<CircleDollarSign size={17} />}
                  note={
                    total.currency
                      ? total.amount == null
                        ? "金额未完整返回"
                        : filtered
                          ? "仅所选区域 / 服务"
                          : "各币种独立统计"
                      : "缺少币种，无法合计"
                  }
                />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                title={
                  rows.length
                    ? "成本总计暂不可用"
                    : filtered
                      ? "没有匹配的成本记录"
                      : "暂无已报告成本"
                }
                description={
                  rows.length
                    ? "已取得的明细保留在下方；未完整提供的金额不显示为零。"
                    : "没有记录不等同于零费用；请留意上报延迟并调整时间范围。"
                }
              />
            </Card>
          )}
          {currencies.map((currency) => {
            const chartPoints = costChartPoints(data, points, currency);
            return (
              <Card
                key={currency}
                title={`${currency} 成本趋势`}
                description={`${subtotalLabel} · ${granularity === "monthly" ? "按月" : "按日"}统计`}
              >
                {chartPoints.some((point) => point.cost != null) ? (
                  <AnalyticsChart
                    points={chartPoints}
                    series={[{ key: "cost", label: subtotalLabel, color: "var(--primary)" }]}
                    unit={currency}
                    granularity={granularity}
                    label={`${currency} ${subtotalLabel}时间趋势`}
                  />
                ) : (
                  <EmptyState
                    title="暂无可绘制的成本数据"
                    description="金额缺失的日期保留为空，不自动补零。"
                  />
                )}
              </Card>
            );
          })}
          <div className="section-heading flex flex-wrap items-baseline justify-between gap-2 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold">
            <h2>服务分类</h2>
            <span className="muted small text-xs text-muted-foreground">按币种分别汇总</span>
          </div>
          <TablePanel
            label="服务成本分类"
            hasRows={serviceRows.length > 0}
            refreshing={report.refreshing}
            empty={<EmptyState title="没有服务分类记录" />}
            footer={
              <Pagination
                page={safeServicePage}
                pageSize={servicePageSize}
                total={serviceRows.length}
                onPage={setServicePage}
                onPageSize={setServicePageSize}
              />
            }
          >
            <Table className="analytics-table analytics-service-table min-w-105">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">服务</TableHead>
                  <TableHead scope="col">币种</TableHead>
                  <TableHead scope="col">已获取小计</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {serviceRows
                  .slice((safeServicePage - 1) * servicePageSize, safeServicePage * servicePageSize)
                  .map((row) => (
                    <TableRow key={row.key}>
                      <TableCell>{row.service || "未提供服务"}</TableCell>
                      <TableCell>{row.currency || "未提供"}</TableCell>
                      <TableCell className="tabular tabular-nums" title={row.amount || undefined}>
                        {displayCost(row.amount)}
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </TablePanel>
          <div className="section-heading flex flex-wrap items-baseline justify-between gap-2 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold">
            <h2>资源明细</h2>
          </div>
          <TablePanel
            label="资源成本明细"
            hasRows={resourceRows.length > 0}
            refreshing={report.refreshing}
            empty={<EmptyState title="没有资源成本明细" />}
            footer={
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={resourceRows.length}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            }
          >
            <Table className="analytics-table analytics-cost-table min-w-225">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">资源</TableHead>
                  <TableHead scope="col">账号 / 区域</TableHead>
                  <TableHead scope="col">服务</TableHead>
                  <TableHead scope="col">币种</TableHead>
                  <SortableHeader
                    label="已获取小计"
                    direction={sort}
                    onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
                  />
                </TableRow>
              </TableHeader>
              <TableBody>
                {resourceRows.slice((safePage - 1) * pageSize, safePage * pageSize).map((row) => {
                  const known = row.resourceId ? knownResources.get(row.resourceId) : undefined;
                  return (
                    <TableRow key={row.key}>
                      <TableCell>
                        {known ? (
                          <Link
                            className="font-medium text-foreground hover:text-primary"
                            href={instanceHref(known.instance.id)}
                          >
                            {row.resourceName || known.name}
                          </Link>
                        ) : (
                          <span
                            className="font-medium text-foreground hover:text-primary"
                            title={row.resourceId || undefined}
                          >
                            {row.resourceName ||
                              (row.resourceId ? shortId(row.resourceId) : "未归属资源")}
                          </span>
                        )}
                        <span
                          className="mt-1 block text-xs text-muted-foreground"
                          title={row.resourceId || undefined}
                        >
                          {known
                            ? known.associated
                              ? `关联实例 ${known.instance.displayName}`
                              : shortId(known.instance.id)
                            : row.resourceId
                              ? inventory.loading
                                ? "正在匹配资源"
                                : inventory.error
                                  ? "库存信息暂不可用"
                                  : "不在当前资源库存中"
                              : "OCI 未提供资源标识"}
                        </span>
                      </TableCell>
                      <TableCell>
                        {row.accountName}
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {row.region ? <RegionTag region={row.region} /> : "未提供区域"}
                        </span>
                      </TableCell>
                      <TableCell>{row.service || "未提供服务"}</TableCell>
                      <TableCell>{row.currency || "未提供"}</TableCell>
                      <TableCell className="tabular tabular-nums" title={row.amount || undefined}>
                        {displayCost(row.amount)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TablePanel>
        </div>
      ) : null}
    </>
  );
}

export default function CostsPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <CostsContent />
    </Suspense>
  );
}
