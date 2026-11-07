"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  ChevronRight,
  Info,
  HardDrive,
  KeyRound,
  ListChecks,
  RefreshCw,
  Server,
} from "lucide-react";
import type { DashboardData, MetricsResult } from "@/lib/contracts";
import { useResource } from "@/components/api";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeader,
  Button,
  Select,
  Status,
} from "@/components/ui";
import {
  activeJobStates,
  formatDate,
  instanceHref,
  number,
  percent,
  regionName,
} from "@/components/format";
import { MetricsChart } from "@/components/metrics-chart";
export default function OverviewPage() {
  const resource = useResource<DashboardData>("/api/dashboard", 30000);
  const data = resource.data;
  const [selected, setSelected] = useState("");
  const [range, setRange] = useState("24h");
  const selectedId = data?.instances.some((i) => i.id === selected)
    ? selected
    : data?.instances.find((i) => i.state === "RUNNING")?.id || data?.instances[0]?.id;
  const metrics = useResource<MetricsResult>(
    selectedId ? `/api/instances/${encodeURIComponent(selectedId)}/metrics?range=${range}` : null,
    60000,
  );
  const regions = useMemo(
    () =>
      Object.entries(
        (data?.instances || []).reduce<Record<string, number>>((acc, instance) => {
          acc[instance.region] = (acc[instance.region] || 0) + 1;
          return acc;
        }, {}),
      ).sort((a, b) => b[1] - a[1]),
    [data],
  );
  if (resource.loading) return <LoadingState />;
  if (!data)
    return <ErrorState message={resource.error || "无法读取总览。"} retry={resource.reload} />;
  const runningJobs = data.jobs.filter((job) => activeJobStates.has(job.state)).length;
  return (
    <>
      <PageHeader title="资源总览" description="所有账号的资源状态，一目了然。">
        <span className="muted small">
          {data.instances.length
            ? `最近同步 ${formatDate(
                data.instances
                  .map((i) => i.syncedAt)
                  .sort()
                  .at(-1),
              )}`
            : "尚未同步资源"}
        </span>
        <Button
          onClick={() => {
            resource.reload();
            metrics.reload();
          }}
          loading={resource.refreshing}
        >
          <RefreshCw size={15} />
          刷新数据
        </Button>
      </PageHeader>
      <div className="stack">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      </div>
      <div className="metrics-grid">
        <MetricCard
          label="实例总数"
          value={number(data.totals.instances)}
          note={`${data.totals.running} 运行中 · ${data.totals.stopped} 已停止`}
          icon={<Server size={17} />}
        />
        <MetricCard
          label="已连接账号"
          value={number(data.accounts.filter((a) => a.status === "connected").length)}
          note={`覆盖 ${data.totals.regions} 个区域`}
          icon={<KeyRound size={17} />}
        />
        <MetricCard
          label="执行中的任务"
          value={number(runningJobs)}
          note={`${data.jobs.filter((j) => j.state === "failed").length} 个任务需要关注`}
          icon={<ListChecks size={17} />}
        />
        <MetricCard
          label="存储容量"
          value={
            <>
              {number(data.totals.storageGb)} <span style={{ fontSize: 19 }}>GiB</span>
            </>
          }
          note={`${data.instances.reduce((sum, i) => sum + i.bootVolumes.length, 0)} 个已挂载启动卷`}
          icon={<HardDrive size={17} />}
        />
      </div>
      {!data.accounts.length ? (
        <Card>
          <EmptyState
            title="从添加第一个 OCI 账号开始"
            description="接入账号后，可在这里查看跨区域实例、运行指标和任务。"
            action={
              <Link href="/accounts" className="button button-primary">
                添加账号
              </Link>
            }
          />
        </Card>
      ) : (
        <>
          <div className="overview-grid">
            <Card
              title="实例性能"
              action={
                <div className="overview-chart-controls">
                  <Select
                    aria-label="选择监控实例"
                    value={selectedId || ""}
                    onChange={(e) => setSelected(e.target.value)}
                  >
                    {!data.instances.length && <option value="">暂无实例</option>}
                    {data.instances.map((i) => (
                      <option value={i.id} key={i.id}>
                        {i.displayName} · {regionName(i.region)}
                      </option>
                    ))}
                  </Select>
                  <Select
                    aria-label="监控时间范围"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                  >
                    <option value="1h">最近 1 小时</option>
                    <option value="24h">最近 24 小时</option>
                    <option value="7d">过去 7 天</option>
                  </Select>
                </div>
              }
            >
              <MetricsChart data={metrics.data} loading={metrics.loading} error={metrics.error} />
            </Card>
            <Card
              title="区域分布"
              description={`${data.totals.regions} 个区域 · ${data.totals.instances} 个实例`}
            >
              {regions.length ? (
                <div className="distribution">
                  {regions.map(([region, count]) => (
                    <Link key={region} href={`/instances?region=${encodeURIComponent(region)}`}>
                      <div className="distribution-label">
                        <span>{regionName(region)}</span>
                        <span>{count} 个</span>
                      </div>
                      <div className="distribution-track">
                        <div
                          style={{
                            width: `${(count / Math.max(...regions.map((r) => r[1]))) * 100}%`,
                          }}
                        />
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="暂无实例资源"
                  description="在账号页面同步资源，或创建一个新实例。"
                />
              )}
            </Card>
          </div>
          <div className="overview-grid">
            <Card
              title="实例速览"
              action={
                <Link href="/instances" className="text-link">
                  查看全部 <ChevronRight size={14} />
                </Link>
              }
            >
              {data.instances.length ? (
                data.instances.slice(0, 3).map((instance) => (
                  <Link
                    key={instance.id}
                    href={instanceHref(instance.id)}
                    className="instance-quick-row"
                  >
                    <span className="resource-icon">
                      <Server size={19} />
                    </span>
                    <div className="resource-label grow">
                      <strong>{instance.displayName}</strong>
                      <span>
                        {regionName(instance.region)} · {instance.accountName}
                      </span>
                    </div>
                    <Status value={instance.state} />
                    <span className="muted small">CPU {percent(instance.metrics?.cpuPercent)}</span>
                    <ChevronRight size={15} className="muted" />
                  </Link>
                ))
              ) : (
                <EmptyState
                  title="尚未同步实例"
                  action={
                    <Link href="/accounts" className="text-link">
                      前往账号同步
                    </Link>
                  }
                />
              )}
            </Card>
            <Card
              title="近期活动"
              action={
                <Link href="/tasks" aria-label="查看全部任务" className="text-link">
                  <ArrowUpRight size={17} />
                </Link>
              }
            >
              {data.activity.length ? (
                data.activity.slice(0, 4).map((event) => (
                  <div key={event.id} className="activity-item">
                    <span
                      className="activity-icon"
                      style={
                        /(fail|error|失败)/i.test(event.result)
                          ? { background: "var(--danger-bg)", color: "var(--danger)" }
                          : !/(success|succeeded|completed|ok|成功)/i.test(event.result)
                            ? { background: "var(--soft)", color: "var(--primary)" }
                            : undefined
                      }
                    >
                      {/(fail|error|失败)/i.test(event.result) ? (
                        <AlertCircle size={14} />
                      ) : /(success|succeeded|completed|ok|成功)/i.test(event.result) ? (
                        <Check size={14} />
                      ) : (
                        <Info size={14} />
                      )}
                    </span>
                    <div>
                      <p>{event.action}</p>
                      <small>
                        {event.resource || "工作区"} · {formatDate(event.createdAt)}
                      </small>
                    </div>
                  </div>
                ))
              ) : (
                <EmptyState
                  title="暂无活动"
                  description="完成账号验证或提交操作后，记录会显示在这里。"
                />
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
