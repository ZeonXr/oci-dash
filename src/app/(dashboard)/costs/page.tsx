"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CircleDollarSign, RefreshCw } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import type { CostReport } from "@/lib/analytics-contracts";
import { useApp } from "@/components/app-provider";
import { useResource } from "@/components/api";
import { useAnalytics } from "@/components/analytics-query";
import { AnalyticsRange, analyticsRange } from "@/components/analytics-range";
import { AnalyticsChart } from "@/components/analytics-chart";
import { AnalyticsStatusNote } from "@/components/analytics-status";
import { UpdatedAt } from "@/components/updated-at";
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
import { instanceHref, regionName, shortId } from "@/components/format";
import { RegionLabel } from "@/components/region-label";

const missing = "__unknown__";
const matches = (selected: string, value: string | null) =>
  !selected || (selected === missing ? value == null : selected === value);

export default function CostsPage() {
  const { accounts, accountsLoading } = useApp();
  const inventory = useResource<{ instances: InstanceSummary[] }>("/api/instances");
  const [account, setAccount] = useState("");
  const [region, setRegion] = useState("");
  const [service, setService] = useState("");
  const [range, setRange] = useState(() => analyticsRange("month"));
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
  const url = accountsLoading || !accounts.length ? null : `/api/analytics/costs?${query}`;
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
        <UpdatedAt value={data?.generatedAt} title="统计查询时间，不代表账单上报时间" />
        <Button onClick={report.refresh} loading={report.refreshing} disabled={!url}>
          <RefreshCw size={15} />
          刷新数据
        </Button>
      </PageHeader>
      <div className="analytics-controls">
        <div className="filters analytics-filters">
          <Select
            aria-label="成本账号"
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
              setRegion("");
              setService("");
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
            onChange={(event) => setRegion(event.target.value)}
          >
            <option value="">全部区域</option>
            {regions.map((item) => (
              <option key={item} value={item}>
                {item === missing ? "未提供区域" : regionName(item)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="成本服务"
            value={service}
            onChange={(event) => setService(event.target.value)}
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
                setRegion("");
                setService("");
              }}
            >
              重置筛选
            </Button>
          )}
        </div>
        <div className="analytics-period">
          <AnalyticsRange
            value={range}
            onChange={setRange}
            allowYear={granularity === "monthly"}
            fullMonths={granularity === "monthly"}
          />
          <Select
            aria-label="成本统计粒度"
            value={granularity}
            onChange={(event) => {
              const value = event.target.value as "daily" | "monthly";
              setGranularity(value);
              setRange(analyticsRange(value === "monthly" ? "last12Months" : "month"));
            }}
          >
            <option value="daily">按日</option>
            <option value="monthly">按月</option>
          </Select>
        </div>
      </div>
      {report.error && <ErrorState message={report.error} retry={report.retry} />}
      {accountsLoading || report.loading ? (
        <LoadingState label="正在读取成本分析…" />
      ) : !accounts.length ? (
        <Card>
          <EmptyState
            title="先添加 OCI 账号"
            description="连接账号后，可读取该租户的已报告成本。"
            action={
              <Link className="button" href="/accounts">
                管理账号
              </Link>
            }
          />
        </Card>
      ) : data ? (
        <div className="stack analytics-content" aria-busy={report.refreshing}>
          {totals.length > 0 ? (
            <div className="analytics-metrics">
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
          <div className="section-heading">
            <h2>服务分类</h2>
            <span className="muted small">按币种分别汇总</span>
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
            <table className="analytics-table analytics-service-table">
              <thead>
                <tr>
                  <th scope="col">服务</th>
                  <th scope="col">币种</th>
                  <th scope="col">已获取小计</th>
                </tr>
              </thead>
              <tbody>
                {serviceRows
                  .slice((safeServicePage - 1) * servicePageSize, safeServicePage * servicePageSize)
                  .map((row) => (
                    <tr key={row.key}>
                      <td>{row.service || "未提供服务"}</td>
                      <td>{row.currency || "未提供"}</td>
                      <td className="tabular" title={row.amount || undefined}>
                        {displayCost(row.amount)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TablePanel>
          <div className="section-heading">
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
            <table className="analytics-table analytics-cost-table">
              <thead>
                <tr>
                  <th scope="col">资源</th>
                  <th scope="col">账号 / 区域</th>
                  <th scope="col">服务</th>
                  <th scope="col">币种</th>
                  <SortableHeader
                    label="已获取小计"
                    direction={sort}
                    onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
                  />
                </tr>
              </thead>
              <tbody>
                {resourceRows.slice((safePage - 1) * pageSize, safePage * pageSize).map((row) => {
                  const known = row.resourceId ? knownResources.get(row.resourceId) : undefined;
                  return (
                    <tr key={row.key}>
                      <td>
                        {known ? (
                          <Link className="name-link" href={instanceHref(known.instance.id)}>
                            {row.resourceName || known.name}
                          </Link>
                        ) : (
                          <span className="name-link" title={row.resourceId || undefined}>
                            {row.resourceName ||
                              (row.resourceId ? shortId(row.resourceId) : "未归属资源")}
                          </span>
                        )}
                        <span className="cell-secondary" title={row.resourceId || undefined}>
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
                      </td>
                      <td>
                        {row.accountName}
                        <span className="cell-secondary">
                          {row.region ? <RegionLabel region={row.region} /> : "未提供区域"}
                        </span>
                      </td>
                      <td>{row.service || "未提供服务"}</td>
                      <td>{row.currency || "未提供"}</td>
                      <td className="tabular" title={row.amount || undefined}>
                        {displayCost(row.amount)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TablePanel>
        </div>
      ) : null}
    </>
  );
}
