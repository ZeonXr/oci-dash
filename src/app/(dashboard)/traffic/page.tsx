"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownToLine, ArrowUpFromLine, ArrowLeftRight } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import type { TrafficReport } from "@/lib/analytics-contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { useAccountFilter } from "@/components/account-filter";
import { useAnalytics } from "@/components/analytics-query";
import { AnalyticsRange, useAnalyticsRange } from "@/components/analytics-range";
import { AnalyticsChart, analyticsNumber, utcTimestamp } from "@/components/analytics-chart";
import { AnalyticsStatusNote } from "@/components/analytics-status";
import { UpdatedAt } from "@/components/updated-at";
import {
  Badge,
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

const gib = (value: number | null | undefined) => (value == null ? null : value / 1024 ** 3);
const totalBytes = (received: number | null, sent: number | null) =>
  received == null || sent == null ? null : received + sent;

function TrafficContent() {
  const { accounts, accountsLoading, accountsReady, accountsError, reloadAccounts } = useApp();
  const inventory = useResource<{ instances: InstanceSummary[] }>("/api/instances");
  const [account, setAccount] = useAccountFilter();
  const [filters, setFilters] = useState({ account, region: "", instance: "", vnic: "" });
  // History navigation can change account without invoking the select handler.
  // Never send another account's dependent filters with the new query.
  const { region, instance, vnic } =
    filters.account === account ? filters : { region: "", instance: "", vnic: "" };
  const changeFilters = (updates: Partial<{ region: string; instance: string; vnic: string }>) =>
    setFilters({ account, region, instance, vnic, ...updates });
  const { range, setRange, refreshRange } = useAnalyticsRange();
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
  const url = !accountsReady || !accounts.length ? null : `/api/analytics/traffic?${query}`;
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
        <RefreshButton
          onClick={() => {
            if (!refreshRange()) void report.refresh();
          }}
          loading={report.refreshing}
          disabled={!url}
        >
          刷新数据
        </RefreshButton>
      </PageHeader>
      <div className="analytics-controls mb-6 flex flex-wrap items-center gap-3">
        <div className="analytics-filters contents *:data-[slot=select-trigger]:w-45 *:data-[slot=select-trigger]:max-w-full max-sm:*:data-[slot=select-trigger]:flex-1">
          <Select
            aria-label="流量账号"
            value={account}
            disabled={!accountsReady}
            onValueChange={(value) => {
              setAccount(value);
              setFilters({ account: value, region: "", instance: "", vnic: "" });
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
            onValueChange={(value) => {
              changeFilters({ region: value, instance: "", vnic: "" });
            }}
          >
            <option value="">全部区域</option>
            {regions.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <Select
            aria-label="流量实例"
            value={instance}
            onValueChange={(value) => {
              changeFilters({ instance: value, vnic: "" });
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
            onValueChange={(value) => changeFilters({ vnic: value })}
          >
            <option value="">全部网卡</option>
            {vnics.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name || shortId(item.id)} · {item.instanceName}
              </option>
            ))}
          </Select>
        </div>
        <div className="analytics-period contents *:data-[slot=select-trigger]:w-auto *:data-[slot=select-trigger]:min-w-28">
          <AnalyticsRange value={range} onChange={setRange} />
          <Select
            aria-label="流量统计粒度"
            value={granularity}
            onValueChange={(value) => setGranularity(value as "hourly" | "daily")}
          >
            <option value="hourly">按小时</option>
            <option value="daily">按日</option>
          </Select>
        </div>
      </div>
      {accountsError && (
        <ErrorState message={`账号读取失败：${accountsError}`} retry={reloadAccounts} />
      )}
      {inventory.error && (
        <ErrorState message={`筛选选项读取失败：${inventory.error}`} retry={inventory.reload} />
      )}
      {report.error && <ErrorState message={report.error} retry={report.retry} />}
      {accountsLoading || report.loading ? (
        <LoadingState label="正在读取流量统计…" />
      ) : !accountsReady ? null : !accounts.length ? (
        <Card>
          <EmptyState
            title="先添加 OCI 账号"
            description="添加账号并同步实例后，可查询网卡流量。"
            action={
              <LinkButton asChild>
                <Link href="/settings/accounts">管理账号</Link>
              </LinkButton>
            }
          />
        </Card>
      ) : data ? (
        <div className="stack analytics-content flex flex-col gap-5" aria-busy={report.refreshing}>
          <div className="analytics-metrics grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4 max-sm:grid-cols-1">
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
            <p className="chart-note mt-2.5 text-xs text-muted-foreground">
              仅统计当前网卡，非公网计费流量。
            </p>
          </Card>
          <div className="section-heading flex flex-wrap items-baseline justify-between gap-2 [&>h2]:m-0 [&>h2]:text-base [&>h2]:font-semibold">
            <h2>网卡明细</h2>
            <span className="muted small text-xs text-muted-foreground">数值单位：GiB</span>
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
            <Table className="analytics-table min-w-205">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">实例 / 网卡</TableHead>
                  <TableHead scope="col">账号 / 区域</TableHead>
                  <TableHead scope="col">接收</TableHead>
                  <TableHead scope="col">发送</TableHead>
                  <SortableHeader
                    label="合计"
                    direction={sort}
                    onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
                  />
                  <TableHead scope="col">数据状态</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.slice((safePage - 1) * pageSize, safePage * pageSize).map((row) => (
                  <TableRow key={`${row.accountId}/${row.vnicId}`}>
                    <TableCell>
                      <Link
                        href={instanceHref(row.instanceId)}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {row.instanceName || shortId(row.instanceId)}
                      </Link>
                      <span className="mt-1 block text-xs text-muted-foreground" title={row.vnicId}>
                        {row.vnicName || shortId(row.vnicId)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {row.accountName}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        <RegionTag region={row.region} />
                      </span>
                    </TableCell>
                    <TableCell className="tabular tabular-nums">
                      {analyticsNumber(gib(row.receivedBytes))}
                    </TableCell>
                    <TableCell className="tabular tabular-nums">
                      {analyticsNumber(gib(row.sentBytes))}
                    </TableCell>
                    <TableCell className="tabular tabular-nums">
                      {analyticsNumber(gib(totalBytes(row.receivedBytes, row.sentBytes)))}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
