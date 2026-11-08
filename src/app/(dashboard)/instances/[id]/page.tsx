"use client";
import { useEffect, useState, type SubmitEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  HardDrive,
  ListChecks,
  Monitor,
  Network,
  Play,
} from "lucide-react";
import type { InstanceSummary, JobPage, JobSummary, MetricsResult } from "@/lib/contracts";
import { useApp } from "@/components/app-provider";
import { send, useAction, useResource } from "@/components/api";
import { useInventoryRefresh } from "@/components/inventory-refresh";
import { SortableHeader, TablePanel } from "@/components/table";
import { RegionLabel } from "@/components/region-label";
import {
  Badge,
  Button,
  RefreshButton,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Status,
} from "@/components/ui";
import {
  formatDate,
  number,
  operationLabels,
  percent,
  primaryAddress,
  publicBindings,
  regionName,
  shortId,
  taskHref,
} from "@/components/format";
import { MetricsChart } from "@/components/metrics-chart";
import { instanceMetrics, metricSampleNote } from "@/components/instance-metrics";
import { UpdatedAt } from "@/components/updated-at";
import { InventoryFreshness } from "@/components/inventory-freshness";
import { NetworkPanel, SecurityPanel, StoragePanel } from "@/components/instance-resources";
import { OperationDialog, type OperationDialogProps } from "@/components/operation-dialog";

function RenameDialog({ instance, onClose }: { instance: InstanceSummary; onClose: () => void }) {
  const { notify } = useApp();
  const [name, setName] = useState(instance.displayName);
  const action = useAction();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const submit = async (e: SubmitEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) return;
    const response = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", {
        kind: "instance-rename",
        accountId: instance.accountId,
        region: instance.region,
        resourceId: instance.id,
        payload: { displayName: name.trim() },
        idempotencyKey,
      }),
    );
    if (response) {
      notify("重命名任务已提交。", taskHref(response.job.id));
      onClose();
    }
  };
  return (
    <Modal
      open
      title="重命名实例"
      description="更新 OCI 实例显示名称。"
      busy={action.pending}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="submit"
            form="rename-form"
            variant="primary"
            disabled={name.trim() === instance.displayName}
            loading={action.pending}
          >
            保存名称
          </Button>
        </>
      }
    >
      <form id="rename-form" className="stack" onSubmit={submit}>
        <Field label="实例名称" required>
          <input
            autoFocus
            required
            maxLength={255}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
const tabs = [
  { id: "overview", label: "概览" },
  { id: "monitoring", label: "监控" },
  { id: "network", label: "网络" },
  { id: "security", label: "安全规则" },
  { id: "storage", label: "存储" },
  { id: "activity", label: "任务与活动" },
];
export default function InstanceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [tab, setTab] = useState("overview");
  const [range, setRange] = useState("1h");
  const [mode, setMode] = useState<"cpu" | "network">("cpu");
  const resource = useResource<{ instance: InstanceSummary }>(
    `/api/instances/${encodeURIComponent(id)}`,
    30000,
  );
  const instance = resource.data?.instance;
  const sync = useInventoryRefresh({
    accountIds: instance ? [instance.accountId] : [],
    enabled: Boolean(instance),
    onUpdated: resource.reload,
  });
  const metrics = useResource<MetricsResult>(
    instance && (tab === "overview" || tab === "monitoring")
      ? `/api/instances/${encodeURIComponent(id)}/metrics?range=${range}`
      : null,
    60000,
  );
  const [activityPage, setActivityPage] = useState(1);
  const [activityPageSize, setActivityPageSize] = useState(10);
  const [activityOrder, setActivityOrder] = useState<"ascending" | "descending">("descending");
  const jobQuery = new URLSearchParams({
    resourceId: id,
    accountId: instance?.accountId || "",
    page: String(tab === "overview" ? 1 : activityPage),
    pageSize: String(tab === "overview" ? 1 : activityPageSize),
    sort: tab === "overview" ? "descending" : activityOrder,
  });
  const jobs = useResource<JobPage>(
    instance && (tab === "overview" || tab === "activity") ? `/api/jobs?${jobQuery}` : null,
    5000,
  );
  const [operation, setOperation] = useState<Omit<OperationDialogProps, "onClose"> | null>(null);
  const [renaming, setRenaming] = useState(false);
  useEffect(() => setActivityPage(1), [id, activityPageSize, activityOrder]);
  useEffect(() => {
    if (tab === "activity" && jobs.data && jobs.data.page !== activityPage)
      setActivityPage(jobs.data.page);
  }, [tab, jobs.data, activityPage]);
  if (resource.loading) return <LoadingState />;
  if (!instance)
    return <ErrorState message={resource.error || "未找到此实例。"} retry={resource.reload} />;
  const instanceJobs = jobs.data?.jobs || [];
  const safeActivityPage = jobs.data?.page ?? activityPage;
  const lifecycle = (
    kind: "instance-start" | "instance-stop" | "instance-reboot" | "instance-terminate",
  ) =>
    setOperation({
      title: operationLabels[kind],
      description:
        kind === "instance-terminate"
          ? "此操作将永久终止实例，保留现有启动卷和数据卷。"
          : kind === "instance-stop"
            ? "实例将正常关机，正在运行的服务会中断。"
            : kind === "instance-reboot"
              ? "实例将重启，正在运行的服务会短暂中断。"
              : "启动此实例及其操作系统。",
      summary: [
        ["实例", instance.displayName],
        ["账号", instance.accountName],
        ["区域", regionName(instance.region)],
      ],
      danger: kind === "instance-terminate",
      requireName: kind === "instance-terminate" ? instance.displayName : undefined,
      operation: {
        kind,
        accountId: instance.accountId,
        region: instance.region,
        resourceId: instance.id,
        payload:
          kind === "instance-terminate"
            ? { preserveBootVolume: true, preserveDataVolumes: true }
            : {},
      },
    });
  const latestMetrics = instanceMetrics(metrics.data);
  const metricCards = (
    <div className="metrics-grid">
      <MetricCard
        label="CPU 使用率"
        value={percent(latestMetrics.cpu?.value)}
        note={metricSampleNote(latestMetrics.cpu, metrics.data?.intervalSeconds)}
      />
      <MetricCard
        label="内存使用率"
        value={percent(instance.metrics?.memoryPercent)}
        note={
          instance.metrics?.memoryPercent == null ? "当前未返回来宾内存指标" : "最近一次可用采样"
        }
      />
      <MetricCard
        label="网络接收"
        value={latestMetrics.received ? `${number(latestMetrics.received.value, 1)} Mbps` : "—"}
        note={metricSampleNote(latestMetrics.received, metrics.data?.intervalSeconds)}
      />
      <MetricCard
        label="网络发送"
        value={latestMetrics.sent ? `${number(latestMetrics.sent.value, 1)} Mbps` : "—"}
        note={metricSampleNote(latestMetrics.sent, metrics.data?.intervalSeconds)}
      />
    </div>
  );
  const taskRows = () => (
    <TablePanel
      embedded
      label="实例任务"
      loading={jobs.loading}
      refreshing={jobs.refreshing}
      hasRows={instanceJobs.length > 0}
      empty={<EmptyState title="暂无关联任务" description="在此实例上提交的操作会显示在这里。" />}
      footer={
        <Pagination
          page={safeActivityPage}
          pageSize={activityPageSize}
          total={jobs.data?.total ?? 0}
          onPage={setActivityPage}
          onPageSize={setActivityPageSize}
        />
      }
    >
      <table className="task-table">
        <thead>
          <tr>
            <th>任务</th>
            <th>状态</th>
            <SortableHeader
              label="提交时间"
              direction={activityOrder}
              onSort={() =>
                setActivityOrder((value) => (value === "ascending" ? "descending" : "ascending"))
              }
            />
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {instanceJobs.map((job) => (
            <tr key={job.id}>
              <td>
                <Link href={taskHref(job.id)} className="name-link">
                  {operationLabels[job.kind]}
                </Link>
                <div className="task-id mono">{job.id.slice(0, 12)}</div>
              </td>
              <td>
                <Status value={job.state} />
              </td>
              <td className="nowrap">{formatDate(job.createdAt)}</td>
              <td>
                <Link href={taskHref(job.id)} className="text-link">
                  查看详情
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TablePanel>
  );
  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/instances">实例</Link>
            <ChevronRight size={12} />
            <span>{instance.displayName}</span>
          </>
        }
        title={
          <>
            {instance.displayName}
            <Status value={instance.state} />
          </>
        }
        description={
          <>
            <RegionLabel region={instance.region} /> · {instance.region} · {instance.accountName}
          </>
        }
      >
        <InventoryFreshness instance={instance} />
        <UpdatedAt
          value={instance.syncedAt}
          title="此实例基础信息最近一次从 OCI 同步的时间；部分未更新的字段另行标记"
        />
        <RefreshButton
          iconOnly
          onClick={sync.refresh}
          loading={resource.refreshing || sync.refreshing}
          label="刷新实例"
        />
        {instance.state === "STOPPED" && (
          <Button onClick={() => lifecycle("instance-start")} icon={<Play size={16} />}>
            启动
          </Button>
        )}
        <details className="dropdown">
          <summary className="button">
            更多 <ChevronDown size={14} />
          </summary>
          <div className="dropdown-menu">
            <button
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                setRenaming(true);
              }}
            >
              重命名
            </button>
            <button
              type="button"
              disabled={instance.state !== "RUNNING"}
              onClick={(e) => {
                const menu = e.currentTarget.closest("details");
                menu?.removeAttribute("open");
                menu?.querySelector("summary")?.focus({ preventScroll: true });
                lifecycle("instance-reboot");
              }}
            >
              重启实例
            </button>
            <button
              disabled={instance.state !== "RUNNING"}
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                lifecycle("instance-stop");
              }}
            >
              停止实例
            </button>
            <button
              className="danger-text"
              disabled={instance.state === "TERMINATED" || instance.state === "TERMINATING"}
              onClick={(e) => {
                e.currentTarget.closest("details")?.removeAttribute("open");
                lifecycle("instance-terminate");
              }}
            >
              终止实例
            </button>
          </div>
        </details>
        <Link
          href={`/instances/${encodeURIComponent(instance.id)}/console`}
          target="_blank"
          rel="noopener noreferrer"
          className="button button-primary"
        >
          <Monitor size={15} />
          VNC 控制台
          <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </PageHeader>
      {resource.error && (
        <div style={{ marginBottom: 20 }}>
          <ErrorState message={resource.error} retry={resource.reload} />
        </div>
      )}
      {sync.error && (
        <div style={{ marginBottom: 20 }}>
          <ErrorState message={sync.error} retry={sync.refresh} />
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="实例详情">
        {tabs.map((item) => (
          <button
            key={item.id}
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={(event) => {
              const index = tabs.findIndex((t) => t.id === item.id);
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                setTab(tabs[next].id);
                document.getElementById(`tab-${tabs[next].id}`)?.focus();
              }
            }}
            aria-controls={`panel-${item.id}`}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && (
          <>
            {metricCards}
            <div className="grid-2 instance-overview-grid" style={{ marginBottom: 24 }}>
              <Card title="基本信息">
                <dl className="details-list">
                  <dt>账号</dt>
                  <dd>
                    <Link href="/settings/accounts" className="text-link">
                      {instance.accountName}
                    </Link>
                  </dd>
                  <dt>区域 / 可用域</dt>
                  <dd>
                    {instance.region} / {instance.availabilityDomain.split(":").at(-1)}
                  </dd>
                  <dt>规格</dt>
                  <dd>
                    {instance.shape}
                    <span className="muted small">
                      {number(instance.ocpus, 1)} OCPU / {number(instance.memoryGb, 1)} GB
                    </span>
                  </dd>
                  <dt>操作系统</dt>
                  <dd>{instance.os || "未提供"}</dd>
                  <dt>实例 OCID</dt>
                  <dd>
                    <span className="mono" title={instance.id}>
                      {shortId(instance.id)}
                    </span>
                    <CopyButton value={instance.id} />
                  </dd>
                  <dt>区间</dt>
                  <dd>
                    <span className="mono" title={instance.compartmentId}>
                      {shortId(instance.compartmentId)}
                    </span>
                    <CopyButton value={instance.compartmentId} />
                  </dd>
                  <dt>标签</dt>
                  <dd>
                    {Object.keys(instance.tags).length ? (
                      Object.entries(instance.tags)
                        .slice(0, 8)
                        .map(([key, value]) => (
                          <Badge key={key} tone="info">
                            {key}: {value}
                          </Badge>
                        ))
                    ) : (
                      <span className="muted">暂无标签</span>
                    )}
                  </dd>
                </dl>
                <p className="muted small" style={{ marginTop: 20 }}>
                  创建于 {formatDate(instance.createdAt, true)}
                </p>
              </Card>
              <Card
                title="性能趋势"
                action={
                  <Select
                    aria-label="监控时间范围"
                    value={range}
                    onChange={(e) => setRange(e.target.value)}
                  >
                    <option value="1h">最近 1 小时</option>
                    <option value="24h">最近 24 小时</option>
                    <option value="7d">过去 7 天</option>
                  </Select>
                }
              >
                <MetricsChart data={metrics.data} loading={metrics.loading} error={metrics.error} />
              </Card>
              <Card
                title="网络"
                action={<Badge>{publicBindings(instance).length} 个公网地址</Badge>}
              >
                <div className="row">
                  <span className="resource-icon">
                    <Network size={19} />
                  </span>
                  <div className="resource-label">
                    <strong>{instance.vnics.length} 个虚拟网卡</strong>
                    <span>{instance.vnics[0]?.privateIps[0]?.privateIp || "暂无私网地址"}</span>
                  </div>
                </div>
                <div className="row between" style={{ marginTop: 18 }}>
                  <span className="mono small muted">
                    {primaryAddress(instance)}
                    {publicBindings(instance).length > 1
                      ? ` +${publicBindings(instance).length - 1}`
                      : ""}
                  </span>
                  <button className="text-link" onClick={() => setTab("network")}>
                    查看网络详情 <ArrowUpRight size={14} />
                  </button>
                </div>
              </Card>
              <Card title="存储" action={<Badge>{instance.bootVolumes.length} 个启动卷</Badge>}>
                <div className="row">
                  <span className="resource-icon">
                    <HardDrive size={19} />
                  </span>
                  <div className="resource-label">
                    <strong>
                      {number(instance.bootVolumes.reduce((sum, v) => sum + v.sizeGb, 0))} GiB
                    </strong>
                    <span>
                      {instance.bootVolumes[0]
                        ? `${instance.bootVolumes[0].vpusPerGb} VPU / GB`
                        : "暂无启动卷"}
                    </span>
                  </div>
                </div>
                <div className="row between" style={{ marginTop: 18 }}>
                  <span className="small muted">{instance.bootVolumes[0]?.name || "—"}</span>
                  <button className="text-link" onClick={() => setTab("storage")}>
                    查看存储详情 <ArrowUpRight size={14} />
                  </button>
                </div>
              </Card>
            </div>
            <Card className="recent-task-summary">
              <div className="row row-wrap">
                <ListChecks size={17} className="muted" />
                <h2>近期任务</h2>
                {instanceJobs[0] ? (
                  <>
                    <Link href={taskHref(instanceJobs[0].id)} className="grow small">
                      {operationLabels[instanceJobs[0].kind]} ·{" "}
                      {formatDate(instanceJobs[0].createdAt)}
                    </Link>
                    <Status value={instanceJobs[0].state} />
                  </>
                ) : (
                  <span className="muted small grow">暂无关联任务</span>
                )}
                <button className="text-link" onClick={() => setTab("activity")}>
                  查看全部 <ChevronRight size={14} />
                </button>
              </div>
            </Card>
          </>
        )}
        {tab === "monitoring" && (
          <>
            {metricCards}
            <Card
              title="监控指标"
              action={
                <div className="row">
                  <Select
                    aria-label="选择监控指标"
                    value={mode}
                    onChange={(e) => setMode(e.target.value as "cpu" | "network")}
                  >
                    <option value="cpu">CPU 使用率</option>
                    <option value="network">网络流量</option>
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
                  <RefreshButton
                    iconOnly
                    label="刷新监控"
                    onClick={metrics.reload}
                    loading={metrics.refreshing}
                  />
                </div>
              }
            >
              <MetricsChart
                data={metrics.data}
                loading={metrics.loading}
                error={metrics.error}
                mode={mode}
              />
            </Card>
          </>
        )}
        {tab === "network" && <NetworkPanel instance={instance} />}{" "}
        {tab === "security" && <SecurityPanel instance={instance} />}{" "}
        {tab === "storage" && <StoragePanel instance={instance} />}{" "}
        {tab === "activity" && (
          <Card
            title="任务与活动"
            action={<RefreshButton onClick={jobs.reload} loading={jobs.refreshing} />}
          >
            {jobs.error && <ErrorState message={jobs.error} retry={jobs.reload} />}
            {taskRows()}
          </Card>
        )}
      </div>
      {operation && <OperationDialog {...operation} onClose={() => setOperation(null)} />}
      {renaming && <RenameDialog instance={instance} onClose={() => setRenaming(false)} />}
    </>
  );
}
