"use client";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useEffect, useRef, useState, type RefObject, type SubmitEvent } from "react";
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
import { RegionTag } from "@/components/region-label";
import { CodeTag } from "@/components/code-tag";
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
  publicBindings,
  shortId,
  taskHref,
} from "@/components/format";
import { MetricsChart } from "@/components/metrics-chart";
import { instanceMetrics, metricSampleNote } from "@/components/instance-metrics";
import { UpdatedAt } from "@/components/updated-at";
import { InventoryFreshness } from "@/components/inventory-freshness";
import { NetworkPanel, SecurityPanel, StoragePanel } from "@/components/instance-resources";
import { OperationDialog, type OperationDialogProps } from "@/components/operation-dialog";
import { IpDetailsDialog } from "@/components/ip-details-dialog";
import {
  IpAddressButton,
  primaryIpTarget,
  targetForBinding,
  type IpDetailsTarget,
} from "@/components/ip-address";
import { ipRotationContext } from "@/components/public-ip-rotation";
import { useInstanceJobs } from "@/components/use-instance-jobs";

function RenameDialog({
  instance,
  onClose,
  returnFocusRef,
}: {
  instance: InstanceSummary;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
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
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
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
      <form id="rename-form" className="flex flex-col gap-5" onSubmit={submit}>
        <Field label="实例名称" required>
          <Input
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
  const pendingJobs = useInstanceJobs(resource.reload);
  const [address, setAddress] = useState<{ instanceId: string; target: IpDetailsTarget } | null>(
    null,
  );
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
  const moreButtonRef = useRef<HTMLButtonElement>(null);
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
  const primaryIp = primaryIpTarget(instance);
  const privateVnic = instance.vnics.find((vnic) => vnic.privateIps.length);
  const privateIp = privateVnic?.privateIps[0];
  const ipContext = ipRotationContext(instance, pendingJobs, resource.error);
  const openIp = (target: IpDetailsTarget) => setAddress({ instanceId: instance.id, target });
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
        ["区域", instance.region],
      ],
      danger: kind === "instance-terminate",
      returnFocusRef: kind === "instance-start" ? undefined : moreButtonRef,
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
    <div className="mb-6 grid grid-cols-4 gap-4 max-[620px]:grid-cols-2 max-[620px]:gap-2">
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
      <Table className="task-table min-w-205">
        <TableHeader>
          <TableRow>
            <TableHead>任务</TableHead>
            <TableHead>状态</TableHead>
            <SortableHeader
              label="提交时间"
              direction={activityOrder}
              onSort={() =>
                setActivityOrder((value) => (value === "ascending" ? "descending" : "ascending"))
              }
            />
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {instanceJobs.map((job) => (
            <TableRow key={job.id}>
              <TableCell>
                <Link
                  href={taskHref(job.id)}
                  className="name-link inline-flex items-center gap-2 font-medium text-foreground hover:text-primary"
                >
                  {operationLabels[job.kind]}
                </Link>
                <div className="mt-1 text-xs text-muted-foreground font-mono tabular-nums">
                  {job.id.slice(0, 12)}
                </div>
              </TableCell>
              <TableCell>
                <Status value={job.state} />
              </TableCell>
              <TableCell className="whitespace-nowrap">{formatDate(job.createdAt)}</TableCell>
              <TableCell>
                <Link
                  href={taskHref(job.id)}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                >
                  查看详情
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
            <RegionTag region={instance.region} /> · {instance.accountName}
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button ref={moreButtonRef}>
              更多 <ChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setRenaming(true)}>重命名</DropdownMenuItem>
            <DropdownMenuItem
              disabled={instance.state !== "RUNNING"}
              onSelect={() => lifecycle("instance-reboot")}
            >
              重启实例
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={instance.state !== "RUNNING"}
              onSelect={() => lifecycle("instance-stop")}
            >
              停止实例
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={instance.state === "TERMINATED" || instance.state === "TERMINATING"}
              onSelect={() => lifecycle("instance-terminate")}
            >
              终止实例
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button asChild variant="primary">
          <Link
            href={`/instances/${encodeURIComponent(instance.id)}/console`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Monitor size={15} />
            VNC 控制台
            <ArrowUpRight size={14} aria-hidden="true" />
          </Link>
        </Button>
      </PageHeader>
      {resource.error && (
        <div className="mb-5">
          <ErrorState message={resource.error} retry={resource.reload} />
        </div>
      )}
      {sync.error && (
        <div className="mb-5">
          <ErrorState message={sync.error} retry={sync.refresh} />
        </div>
      )}
      <Tabs value={tab} onValueChange={setTab} className="gap-6">
        <div className="min-w-0 overflow-x-auto overflow-y-hidden pb-1">
          <TabsList variant="line" className="gap-4" aria-label="实例详情">
            {tabs.map((item) => (
              <TabsTrigger
                key={item.id}
                value={item.id}
                id={`tab-${item.id}`}
                aria-controls={`panel-${item.id}`}
                className="shrink-0 px-2"
                onFocus={(event) =>
                  event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" })
                }
              >
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        <TabsContent
          value={tab}
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="min-w-0"
        >
          {tab === "overview" && (
            <>
              {metricCards}
              <div className="grid grid-cols-2 gap-6 max-[900px]:gap-4 max-[620px]:grid-cols-1 *:min-w-0 mb-6">
                <Card title="基本信息">
                  <dl className="grid grid-cols-[105px_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-1.5 [&_dd]:wrap-anywhere max-[620px]:grid-cols-[85px_minmax(0,1fr)] max-[620px]:gap-3 max-[620px]:text-xs">
                    <dt>账号</dt>
                    <dd>
                      <Link
                        href="/settings/accounts"
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                      >
                        {instance.accountName}
                      </Link>
                    </dd>
                    <dt>区域 / 可用域</dt>
                    <dd>
                      <RegionTag region={instance.region} />
                      <CodeTag title={instance.availabilityDomain}>
                        {instance.availabilityDomain.split(":").at(-1) ||
                          instance.availabilityDomain}
                      </CodeTag>
                    </dd>
                    <dt>规格</dt>
                    <dd>
                      <CodeTag>{instance.shape}</CodeTag>
                      <span className="text-muted-foreground text-xs">
                        {number(instance.ocpus, 1)} OCPU / {number(instance.memoryGb, 1)} GB
                      </span>
                    </dd>
                    <dt>操作系统</dt>
                    <dd>{instance.os || "未提供"}</dd>
                    <dt>实例 OCID</dt>
                    <dd>
                      <CodeTag title={instance.id}>{shortId(instance.id)}</CodeTag>
                      <CopyButton value={instance.id} />
                    </dd>
                    <dt>区间</dt>
                    <dd>
                      <CodeTag title={instance.compartmentId}>
                        {shortId(instance.compartmentId)}
                      </CodeTag>
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
                        <span className="text-muted-foreground">暂无标签</span>
                      )}
                    </dd>
                  </dl>
                  <p className="text-muted-foreground text-xs mt-5">
                    创建于 {formatDate(instance.createdAt, true)}
                  </p>
                </Card>
                <Card
                  title="性能趋势"
                  action={
                    <Select
                      aria-label="监控时间范围"
                      value={range}
                      onValueChange={(value) => setRange(value)}
                    >
                      <option value="1h">最近 1 小时</option>
                      <option value="24h">最近 24 小时</option>
                      <option value="7d">过去 7 天</option>
                    </Select>
                  }
                >
                  <MetricsChart
                    data={metrics.data}
                    loading={metrics.loading}
                    error={metrics.error}
                  />
                </Card>
                <Card
                  title="网络"
                  action={<Badge>{publicBindings(instance).length} 个公网地址</Badge>}
                >
                  <div className="row flex items-center gap-2.5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Network size={19} />
                    </span>
                    <div className="flex min-w-0 flex-col [&>strong]:font-medium [&>span]:text-xs [&>span]:text-muted-foreground">
                      <strong>{instance.vnics.length} 个虚拟网卡</strong>
                      <span>
                        {privateVnic && privateIp ? (
                          <IpAddressButton
                            target={targetForBinding(privateVnic, privateIp, "private")}
                            onClick={openIp}
                          />
                        ) : (
                          "暂无私网地址"
                        )}
                      </span>
                    </div>
                  </div>
                  <div className="row flex items-center gap-2.5 justify-between mt-4">
                    <span className="font-mono tabular-nums text-xs text-muted-foreground">
                      {primaryIp ? <IpAddressButton target={primaryIp} onClick={openIp} /> : "—"}
                      {publicBindings(instance).length > 1
                        ? ` +${publicBindings(instance).length - 1}`
                        : ""}
                    </span>
                    <button
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                      onClick={() => setTab("network")}
                    >
                      查看网络详情 <ArrowUpRight size={14} />
                    </button>
                  </div>
                </Card>
                <Card title="存储" action={<Badge>{instance.bootVolumes.length} 个启动卷</Badge>}>
                  <div className="row flex items-center gap-2.5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <HardDrive size={19} />
                    </span>
                    <div className="flex min-w-0 flex-col [&>strong]:font-medium [&>span]:text-xs [&>span]:text-muted-foreground">
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
                  <div className="row flex items-center gap-2.5 justify-between mt-4">
                    <span className="text-xs text-muted-foreground">
                      {instance.bootVolumes[0]?.name || "—"}
                    </span>
                    <button
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                      onClick={() => setTab("storage")}
                    >
                      查看存储详情 <ArrowUpRight size={14} />
                    </button>
                  </div>
                </Card>
              </div>
              <Card className="recent-task-summary [&_h2]:text-sm [&_h2]:font-medium">
                <div className="row flex items-center gap-2.5 flex-wrap">
                  <ListChecks size={17} className="text-muted-foreground" />
                  <h2>近期任务</h2>
                  {instanceJobs[0] ? (
                    <>
                      <Link href={taskHref(instanceJobs[0].id)} className="min-w-0 flex-1 text-xs">
                        {operationLabels[instanceJobs[0].kind]} ·{" "}
                        {formatDate(instanceJobs[0].createdAt)}
                      </Link>
                      <Status value={instanceJobs[0].state} />
                    </>
                  ) : (
                    <span className="text-muted-foreground text-xs min-w-0 flex-1">
                      暂无关联任务
                    </span>
                  )}
                  <button
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                    onClick={() => setTab("activity")}
                  >
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
                  <div className="row flex items-center gap-2.5">
                    <Select
                      aria-label="选择监控指标"
                      value={mode}
                      onValueChange={(value) => setMode(value as "cpu" | "network")}
                    >
                      <option value="cpu">CPU 使用率</option>
                      <option value="network">网络流量</option>
                    </Select>
                    <Select
                      aria-label="监控时间范围"
                      value={range}
                      onValueChange={(value) => setRange(value)}
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
          {tab === "network" && <NetworkPanel instance={instance} onAddress={openIp} />}{" "}
          {tab === "security" && (
            <SecurityPanel
              instance={instance}
              jobs={pendingJobs.jobs}
              onSubmitted={pendingJobs.track}
            />
          )}{" "}
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
        </TabsContent>
      </Tabs>
      {operation && <OperationDialog {...operation} onClose={() => setOperation(null)} />}
      {renaming && (
        <RenameDialog
          instance={instance}
          onClose={() => setRenaming(false)}
          returnFocusRef={moreButtonRef}
        />
      )}
      {address?.instanceId === instance.id && (
        <IpDetailsDialog
          instance={instance}
          target={address.target}
          blockedReason={ipContext.blockedReason}
          onSuccess={pendingJobs.track}
          onClose={() => setAddress(null)}
        />
      )}
    </>
  );
}
