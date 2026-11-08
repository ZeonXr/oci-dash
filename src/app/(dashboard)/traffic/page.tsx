"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight, RefreshCw } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import type { TrafficReport } from "@/lib/analytics-contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { useAccountFilter } from "@/components/account-filter";
import { useAnalytics } from "@/components/analytics-query";
import { AnalyticsRange, analyticsRange } from "@/components/analytics-range";
import { AnalyticsChart, analyticsNumber, utcTimestamp } from "@/components/analytics-chart";
import { AnalyticsStatusNote } from "@/components/analytics-status";
import { UpdatedAt } from "@/components/updated-at";
import {
  Badge,
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

const gib = (value: number | null | undefined) => (value == null ? null : value / 1024 ** 3);
const totalBytes = (received: number | null, sent: number | null) =>
  received == null || sent == null ? null : received + sent;

function TrafficContent() {
  const { accounts, accountsLoading } = useApp();
  const inventory = useResource<{ instances: InstanceSummary[] }>("/api/instances");
  const [account, setAccount] = useAccountFilter();
  const [filters, setFilters] = useState({ account, region: "", instance: "", vnic: "" });
  // History navigation can change account without invoking the select handler.
  // Never send another account's dependent filters with the new query.
  const { region, instance, vnic } =
    filters.account === account ? filters : { region: "", instance: "", vnic: "" };
  const changeFilters = (updates: Partial<{ region: string; instance: string; vnic: string }>) =>
    setFilters({ account, region, instance, vnic, ...updates });
  const [range, setRange] = useState(() => analyticsRange("month"));
  const [granularity, setGranularity] = useState<"hourly" | "daily">("daily");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<"ascending" | "descending">("descending");
  const instances = inventory.data?.instances || [];
  const accountInstances = instances.filter((item) => !account || item.accountId === account);
  const regions = [
    ...new Set([
      ...accounts
        .filter((item) => !account || item.id === account)
        .flatMap((item) => [item.homeRegion, ...item.regions]),
      ...accountInstances.map((item) => item.region),
    ]),
  ].sort();
  const visibleInstances = accountInstances.filter((item) => !region || item.region === region);
  const vnics = visibleInstances
    .filter((item) => !instance || item.id === instance)
    .flatMap((item) => item.vnics.map((card) => ({ ...card, instanceName: item.displayName })));
  const query = new URLSearchParams({
    startDate: range.startDate,
    endDate: range.endDate,
    granularity,
  });
  if (account) query.set("accountId", account);
  if (region) query.set("region", region);
  if (instance) query.set("instanceId", instance);
  if (vnic) query.set("vnicId", vnic);
  const url = accountsLoading || !accounts.length ? null : `/api/analytics/traffic?${query}`;
  const report = useAnalytics<TrafficReport>(url);
  const data = report.data;
  const rows = useMemo(
    () =>
      [...(data?.rows || [])].sort((a, b) => {
        const left = totalBytes(a.receivedBytes, a.sentBytes),
          right = totalBytes(b.receivedBytes, b.sentBytes);
        if (left == null) return right == null ? a.vnicId.localeCompare(b.vnicId) : 1;
        if (right == null) return -1;
        return (
          (sort === "ascending" ? left - right : right - left) || a.vnicId.localeCompare(b.vnicId)
        );
      }),
    [data, sort],
  );
  useEffect(() => setPage(1), [url, pageSize, sort]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const points = useMemo(
    () =>
      (data?.points || [])
        .map((point) => ({
          timestamp: point.timestamp,
          coverage: point.coverage,
          received: gib(point.receivedBytes),
          sent: gib(point.sentBytes),
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    [data],
  );
  const hasPoints = points.some((point) => point.received != null || point.sent != null);
  const partialPoints =
    data?.status === "partial" || points.some((point) => point.coverage === "partial");
  return (
    <>
      <PageHeader title="流量统计" description="按账号、实例和网卡查看接收与发送流量。">
        {data && <AnalyticsStatusNote report={data} />}
        <UpdatedAt value={data?.generatedAt} title="统计查询时间" />
        <Button onClick={report.refresh} loading={report.refreshing} disabled={!url}>
          <RefreshCw size={15} />
          刷新数据
        </Button>
      </PageHeader>
      <div className="analytics-controls">
        <div className="filters analytics-filters">
          <Select
            aria-label="流量账号"
            value={account}
            disabled={accountsLoading}
            onChange={(event) => {
              setAccount(event.target.value);
              setFilters({ account: event.target.value, region: "", instance: "", vnic: "" });
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
            aria-label="流量区域"
            value={region}
            onChange={(event) => {
              changeFilters({ region: event.target.value, instance: "", vnic: "" });
            }}
          >
            <option value="">全部区域</option>
            {regions.map((item) => (
              <option key={item} value={item}>
                {regionName(item)}
              </option>
            ))}
          </Select>
          <Select
            aria-label="流量实例"
            value={instance}
            onChange={(event) => {
              changeFilters({ instance: event.target.value, vnic: "" });
            }}
          >
            <option value="">全部实例</option>
            {visibleInstances.map((item) => (
              <option key={item.id} value={item.id}>
                {item.displayName}
              </option>
            ))}
          </Select>
          <Select
            aria-label="流量网卡"
            value={vnic}
            onChange={(event) => changeFilters({ vnic: event.target.value })}
          >
            <option value="">全部网卡</option>
            {vnics.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || shortId(item.id)} · {item.instanceName}
              </option>
            ))}
          </Select>
        </div>
        <div className="analytics-period">
          <AnalyticsRange value={range} onChange={setRange} />
          <Select
            aria-label="流量统计粒度"
            value={granularity}
            onChange={(event) => setGranularity(event.target.value as "hourly" | "daily")}
          >
            <option value="hourly">按小时</option>
            <option value="daily">按日</option>
          </Select>
        </div>
      </div>
      {inventory.error && (
        <ErrorState message={`筛选选项读取失败：${inventory.error}`} retry={inventory.reload} />
      )}
      {report.error && <ErrorState message={report.error} retry={report.retry} />}
      {accountsLoading || report.loading ? (
        <LoadingState label="正在读取流量统计…" />
      ) : !accounts.length ? (
        <Card>
          <EmptyState
            title="先添加 OCI 账号"
            description="添加账号并同步实例后，可查询网卡流量。"
            action={
              <Link className="button" href="/settings/accounts">
                管理账号
              </Link>
            }
          />
        </Card>
      ) : data ? (
        <div className="stack analytics-content" aria-busy={report.refreshing}>
          <div className="analytics-metrics">
            <MetricCard
              label="接收流量"
              value={
                <>
                  {analyticsNumber(gib(data.totals.receivedBytes))} <span>GiB</span>
                </>
              }
              icon={<ArrowDownToLine size={17} />}
              note={
                data.totals.receivedBytes == null
                  ? "暂无数据"
                  : partialPoints
                    ? "已获取小计"
                    : "网卡接收"
              }
            />
            <MetricCard
              label="发送流量"
              value={
                <>
                  {analyticsNumber(gib(data.totals.sentBytes))} <span>GiB</span>
                </>
              }
              icon={<ArrowUpFromLine size={17} />}
              note={
                data.totals.sentBytes == null
                  ? "暂无数据"
                  : partialPoints
                    ? "已获取小计"
                    : "网卡发送"
              }
            />
            <MetricCard
              label="收发合计"
              value={
                <>
                  {analyticsNumber(gib(data.totals.totalBytes))} <span>GiB</span>
                </>
              }
              icon={<ArrowLeftRight size={17} />}
              note={partialPoints ? "接收 + 发送 · 已获取小计" : "接收 + 发送"}
            />
          </div>
          <Card
            title="流量趋势"
            description={
              data.dataThrough
                ? `截至 ${utcTimestamp(data.dataThrough)} UTC`
                : "按完整 UTC 小时统计"
            }
          >
            {hasPoints ? (
              <AnalyticsChart
                points={points}
                series={[
                  {
                    key: "received",
                    label: partialPoints ? "接收（已获取）" : "接收",
                    color: "var(--primary)",
                  },
                  {
                    key: "sent",
                    label: partialPoints ? "发送（已获取）" : "发送",
                    color: "#58baa7",
                  },
                ]}
                unit="GiB"
                granularity={granularity}
                label="网卡接收与发送流量趋势"
              />
            ) : (
              <EmptyState
                title="所选范围暂无流量数据"
                description="没有监控样本不等同于零流量，可调整日期或筛选条件。"
              />
            )}
            <p className="chart-note">仅统计当前网卡，非公网计费流量。</p>
          </Card>
          <div className="section-heading">
            <h2>网卡明细</h2>
            <span className="muted small">数值单位：GiB</span>
          </div>
          <TablePanel
            label="网卡流量明细"
            hasRows={rows.length > 0}
            refreshing={report.refreshing}
            empty={
              <EmptyState
                title="没有可显示的网卡"
                description="尝试调整账号、区域、实例或网卡筛选。"
              />
            }
            footer={
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={rows.length}
                onPage={setPage}
                onPageSize={setPageSize}
              />
            }
          >
            <table className="analytics-table">
              <thead>
                <tr>
                  <th scope="col">实例 / 网卡</th>
                  <th scope="col">账号 / 区域</th>
                  <th scope="col">接收</th>
                  <th scope="col">发送</th>
                  <SortableHeader
                    label="合计"
                    direction={sort}
                    onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
                  />
                  <th scope="col">数据状态</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice((safePage - 1) * pageSize, safePage * pageSize).map((row) => (
                  <tr key={`${row.accountId}/${row.vnicId}`}>
                    <td>
                      <Link href={instanceHref(row.instanceId)} className="name-link">
                        {row.instanceName || shortId(row.instanceId)}
                      </Link>
                      <span className="cell-secondary" title={row.vnicId}>
                        {row.vnicName || shortId(row.vnicId)}
                      </span>
                    </td>
                    <td>
                      {row.accountName}
                      <span className="cell-secondary">
                        <RegionLabel region={row.region} />
                      </span>
                    </td>
                    <td className="tabular">{analyticsNumber(gib(row.receivedBytes))}</td>
                    <td className="tabular">{analyticsNumber(gib(row.sentBytes))}</td>
                    <td className="tabular">
                      {analyticsNumber(gib(totalBytes(row.receivedBytes, row.sentBytes)))}
                    </td>
                    <td>
                      <Badge
                        tone={
                          row.coverage === "complete"
                            ? "success"
                            : row.coverage === "partial"
                              ? "warning"
                              : "neutral"
                        }
                      >
                        {row.coverage === "complete"
                          ? "完整"
                          : row.coverage === "partial"
                            ? "部分数据"
                            : "暂无数据"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TablePanel>
        </div>
      ) : null}
    </>
  );
}

export default function TrafficPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <TrafficContent />
    </Suspense>
  );
}
