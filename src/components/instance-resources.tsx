"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { HardDrive, Lock, Network, Plus, ShieldCheck } from "lucide-react";
import type {
  BootVolumeSummary,
  InstanceSummary,
  JobSummary,
  SecurityGroup,
  SecurityRule,
} from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
import { useApp } from "./app-provider";
import { send, useAction, useResource } from "./api";
import { number, shortId, taskHref } from "./format";
import {
  Alert,
  Badge,
  Button,
  RefreshButton,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  Select,
  Status,
} from "./ui";
import { OperationDialog, type OperationDialogProps } from "./operation-dialog";
import { TablePanel } from "./table";
import { IpAddressButton, targetForBinding, type IpDetailsTarget } from "./ip-address";

export function NetworkPanel({
  instance,
  onAddress,
}: {
  instance: InstanceSummary;
  onAddress: (target: IpDetailsTarget) => void;
}) {
  const [operation, setOperation] = useState<Omit<OperationDialogProps, "onClose"> | null>(null);
  return (
    <div className="flex flex-col gap-5">
      {!instance.vnics.length ? (
        <Card>
          <EmptyState title="没有网卡信息" description="可在账号页刷新资源，重新读取网络信息。" />
        </Card>
      ) : (
        instance.vnics.map((vnic) => (
          <Card
            key={vnic.id}
            title={vnic.name || "虚拟网卡"}
            action={
              <Badge tone={vnic.primary ? "info" : "neutral"}>
                {vnic.primary ? "主网卡" : "附加网卡"}
              </Badge>
            }
          >
            <div className="row flex items-center gap-2.5 flex-wrap text-xs text-muted-foreground mb-4">
              <Network size={15} />
              <span className="font-mono tabular-nums" title={vnic.id}>
                {shortId(vnic.id)}
              </span>
              <CopyButton value={vnic.id} />
              <span>子网 {shortId(vnic.subnetId)}</span>
              <span>{vnic.nsgIds.length} 个网络安全组</span>
            </div>
            <TablePanel
              embedded
              label={`${vnic.name || "虚拟网卡"} IPv4 地址`}
              hasRows={vnic.privateIps.length > 0}
              empty={<EmptyState title="此网卡没有 IPv4 地址信息" />}
            >
              <Table className="min-w-[730px]">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">私网 IPv4</TableHead>
                    <TableHead scope="col">公网 IPv4</TableHead>
                    <TableHead scope="col">分配方式</TableHead>
                    <TableHead scope="col">保护状态</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {vnic.privateIps.map((binding) => (
                    <TableRow key={binding.privateIpId}>
                      <TableCell>
                        <IpAddressButton
                          target={targetForBinding(vnic, binding, "private")}
                          onClick={onAddress}
                        />
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {binding.isPrimary ? "主要私网地址" : "次要私网地址"}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1 whitespace-nowrap font-mono tabular-nums">
                          {binding.publicIp ? (
                            <IpAddressButton
                              target={targetForBinding(vnic, binding)}
                              onClick={onAddress}
                            />
                          ) : (
                            "未绑定"
                          )}
                          {binding.publicIp && <CopyButton value={binding.publicIp} />}
                        </span>
                      </TableCell>
                      <TableCell>
                        {binding.lifetime === "RESERVED"
                          ? "保留公网 IP"
                          : binding.lifetime === "EPHEMERAL"
                            ? "临时公网 IP"
                            : "—"}
                      </TableCell>
                      <TableCell>
                        {binding.protected || binding.lifetime === "RESERVED" ? (
                          <Badge>
                            <Lock size={11} />
                            受保护
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground">
                            {binding.publicIp ? "未保护" : "—"}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TablePanel>
            <div className="row flex items-center gap-2.5 justify-between flex-wrap mt-5">
              <div>
                <p className="mb-3 text-sm font-medium text-foreground">IPv6 地址</p>
                {vnic.ipv6.length ? (
                  vnic.ipv6.map((ip) => (
                    <div
                      key={ip}
                      className="row flex items-center gap-2.5 font-mono tabular-nums wrap-anywhere"
                    >
                      <IpAddressButton
                        target={{ kind: "ipv6", address: ip, vnicId: vnic.id }}
                        onClick={onAddress}
                      />
                      <CopyButton value={ip} />
                    </div>
                  ))
                ) : (
                  <p className="text-muted-foreground text-xs">此网卡尚未分配 IPv6。</p>
                )}
              </div>
              <Button
                size="sm"
                onClick={() =>
                  setOperation({
                    title: "分配 IPv6",
                    description: "为此网卡申请 IPv6 地址。所属子网需要已启用 IPv6。",
                    summary: [
                      ["实例", instance.displayName],
                      ["网卡名称", vnic.name],
                    ],
                    operation: {
                      kind: "ipv6-assign",
                      accountId: instance.accountId,
                      region: instance.region,
                      resourceId: instance.id,
                      payload: { vnicId: vnic.id },
                    },
                  })
                }
              >
                <Plus size={14} />
                分配 IPv6
              </Button>
            </div>
          </Card>
        ))
      )}
      {operation && <OperationDialog {...operation} onClose={() => setOperation(null)} />}
    </div>
  );
}

function VolumeDialog({
  instance,
  volume,
  onClose,
}: {
  instance: InstanceSummary;
  volume: BootVolumeSummary;
  onClose: () => void;
}) {
  const { notify } = useApp();
  const action = useAction();
  const [size, setSize] = useState(volume.sizeGb);
  const [vpu, setVpu] = useState(volume.vpusPerGb);
  const [ack, setAck] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!ack) return;
    const result = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", {
        kind: "boot-volume-update",
        accountId: instance.accountId,
        region: instance.region,
        resourceId: instance.id,
        payload: { bootVolumeId: volume.id, sizeGb: size, vpusPerGb: vpu },
        idempotencyKey,
      }),
    );
    if (result) {
      notify("启动卷更新已提交。", taskHref(result.job.id));
      onClose();
    }
  };
  return (
    <Modal
      open
      title="调整启动卷"
      description={volume.name}
      busy={action.pending}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button
            form="volume-form"
            type="submit"
            variant="primary"
            disabled={!ack || (size === volume.sizeGb && vpu === volume.vpusPerGb)}
            loading={action.pending}
          >
            保存配置
          </Button>
        </>
      }
    >
      <form id="volume-form" className="flex flex-col gap-5" onSubmit={submit}>
        <Field
          label="容量 (GiB)"
          hint={`当前 ${volume.sizeGb} GiB。OCI 在线扩容不支持缩小磁盘。`}
          required
        >
          <Input
            type="number"
            required
            min={volume.sizeGb}
            max={32768}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
        </Field>
        <Field label="性能 (VPU / GB)" required>
          <Select value={vpu} onValueChange={(value) => setVpu(Number(value))}>
            {Array.from(
              new Set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, volume.vpusPerGb]),
            )
              .sort((a, b) => a - b)
              .map((value) => (
                <option key={value} value={value}>
                  {value} VPU / GB
                </option>
              ))}
          </Select>
        </Field>
        <Alert>容量和性能调整可能影响费用；扩容后可能还需要在操作系统内扩展分区。</Alert>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={ack} onCheckedChange={(checked) => setAck(checked === true)} />
          确认按上述容量与性能更新
        </label>
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
export function StoragePanel({ instance }: { instance: InstanceSummary }) {
  const [editing, setEditing] = useState<BootVolumeSummary | null>(null);
  return (
    <>
      <div className="flex flex-col gap-5">
        {instance.bootVolumes.length ? (
          instance.bootVolumes.map((volume) => (
            <Card
              key={volume.id}

              title={volume.name}
              action={<Status value={volume.state} />}
            >
              <div className="row flex items-center gap-2.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <HardDrive size={20} />
                </span>
                <div className="flex min-w-0 flex-col [&>strong]:font-medium [&>span]:text-xs [&>span]:text-muted-foreground">
                  <strong>启动卷</strong>
                  <span className="font-mono tabular-nums">
                    {shortId(volume.id)} <CopyButton value={volume.id} />
                  </span>
                </div>
              </div>
              <dl className="grid grid-cols-[105px_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-1.5 [&_dd]:wrap-anywhere max-[620px]:grid-cols-[85px_minmax(0,1fr)] max-[620px]:gap-3 max-[620px]:text-xs">
                <dt>容量</dt>
                <dd>{number(volume.sizeGb)} GiB</dd>
                <dt>配置性能</dt>
                <dd>{volume.vpusPerGb} VPU / GB</dd>
                <dt>区域</dt>
                <dd>{volume.region}</dd>
                <dt>挂载状态</dt>
                <dd>{volume.attachmentId ? "已附加到当前实例" : "未提供挂载信息"}</dd>
              </dl>
              <Button onClick={() => setEditing(volume)}>调整容量与性能</Button>
            </Card>
          ))
        ) : (
          <Card>
            <EmptyState
              title="没有已挂载启动卷"
              description="可在账号页刷新资源，重新读取启动卷信息。"
            />
          </Card>
        )}
      </div>
      {editing && (
        <VolumeDialog instance={instance} volume={editing} onClose={() => setEditing(null)} />
      )}
    </>
  );
}

function RuleDialog({
  instance,
  group,
  onClose,
  onSubmitted,
}: {
  instance: InstanceSummary;
  group: SecurityGroup;
  onClose: () => void;
  onSubmitted: (job: JobSummary) => void;
}) {
  const { notify } = useApp();
  const action = useAction();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    direction: "INGRESS" as "INGRESS" | "EGRESS",
    protocol: "6",
    peer: "",
    peerType: "CIDR_BLOCK",
    description: "",
    stateless: false,
    portMin: "",
    portMax: "",
    icmpType: "",
    icmpCode: "",
  });
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const rule = {
      id: "",
      direction: form.direction,
      protocol: form.protocol,
      peer: form.peer.trim(),
      peerType: form.peerType,
      description: form.description,
      stateless: form.stateless,
      ...(["6", "17"].includes(form.protocol) && form.portMin
        ? { portMin: Number(form.portMin), portMax: Number(form.portMax || form.portMin) }
        : {}),
      ...(["1", "58"].includes(form.protocol) && form.icmpType
        ? {
            icmpType: Number(form.icmpType),
            ...(form.icmpCode ? { icmpCode: Number(form.icmpCode) } : {}),
          }
        : {}),
    };
    const result = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", {
        kind: "security-rule-add",
        accountId: instance.accountId,
        region: instance.region,
        resourceId: instance.id,
        payload: { groupId: group.id, groupKind: group.kind, etag: group.etag, rule },
        idempotencyKey,
      }),
    );
    if (result) {
      notify("安全规则添加任务已提交。", taskHref(result.job.id));
      onSubmitted(result.job);
      onClose();
    }
  };
  return (
    <Modal
      open
      title="添加安全规则"
      description={group.name}
      busy={action.pending}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button
            type="submit"
            form="security-rule-form"
            variant="primary"
            loading={action.pending}
          >
            添加规则
          </Button>
        </>
      }
    >
      <form id="security-rule-form" onSubmit={submit} className="flex flex-col gap-5">
        <Alert tone="info">
          规则会作用于此{group.kind === "nsg" ? "网络安全组" : "安全列表"}关联的所有资源。
        </Alert>
        <div className="grid grid-cols-2 gap-4 max-[620px]:grid-cols-1">
          <Field label="方向">
            <Select
              value={form.direction}
              onValueChange={(value) =>
                setForm({ ...form, direction: value as "INGRESS" | "EGRESS" })
              }
            >
              <option value="INGRESS">入站</option>
              <option value="EGRESS">出站</option>
            </Select>
          </Field>
          <Field label="协议">
            <Select
              value={form.protocol}
              onValueChange={(value) => setForm({ ...form, protocol: value })}
            >
              <option value="6">TCP</option>
              <option value="17">UDP</option>
              <option value="1">ICMP</option>
              <option value="58">ICMPv6</option>
              <option value="all">所有协议</option>
            </Select>
          </Field>
          <Field label="地址类型" className="col-span-2 max-[620px]:col-span-1">
            <Select
              value={form.peerType}
              onValueChange={(value) => setForm({ ...form, peerType: value })}
            >
              <option value="CIDR_BLOCK">CIDR 地址段</option>
              {group.kind === "nsg" && (
                <option value="NETWORK_SECURITY_GROUP">网络安全组 OCID</option>
              )}
              {form.direction === "EGRESS" && (
                <option value="SERVICE_CIDR_BLOCK">OCI 服务 CIDR</option>
              )}
            </Select>
          </Field>
          <Field
            label={form.direction === "INGRESS" ? "来源" : "目标"}
            required
            className="col-span-2 max-[620px]:col-span-1"
          >
            <Input
              required
              value={form.peer}
              onChange={(e) => setForm({ ...form, peer: e.target.value })}
              placeholder={
                form.peerType === "CIDR_BLOCK" ? "例如 203.0.113.0/24" : "填写对应资源标识"
              }
            />
          </Field>
          {["6", "17"].includes(form.protocol) && (
            <>
              <Field label="目标起始端口" hint="留空表示所有端口。">
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.portMin}
                  onChange={(e) => setForm({ ...form, portMin: e.target.value })}
                  placeholder="例如 443"
                />
              </Field>
              <Field label="目标结束端口" hint="留空表示与起始端口相同。">
                <Input
                  type="number"
                  min={Number(form.portMin) || 1}
                  max={65535}
                  value={form.portMax}
                  onChange={(e) => setForm({ ...form, portMax: e.target.value })}
                  disabled={!form.portMin}
                />
              </Field>
            </>
          )}
          {["1", "58"].includes(form.protocol) && (
            <>
              <Field label="ICMP 类型">
                <Input
                  type="number"
                  min={0}
                  max={255}
                  value={form.icmpType}
                  onChange={(e) => setForm({ ...form, icmpType: e.target.value })}
                />
              </Field>
              <Field label="ICMP 代码">
                <Input
                  type="number"
                  min={0}
                  max={255}
                  value={form.icmpCode}
                  onChange={(e) => setForm({ ...form, icmpCode: e.target.value })}
                  disabled={!form.icmpType}
                />
              </Field>
            </>
          )}
          <Field label="说明" className="col-span-2 max-[620px]:col-span-1">
            <Input
              value={form.description}
              maxLength={255}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="说明这条规则的用途"
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={form.stateless}
            onCheckedChange={(checked) => setForm({ ...form, stateless: checked === true })}
          />
          使用无状态规则
        </label>
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
const protocolLabels: Record<string, string> = {
  "6": "TCP",
  "17": "UDP",
  "1": "ICMP",
  "58": "ICMPv6",
  all: "所有",
};
export function SecurityPanel({
  instance,
  jobs,
  onSubmitted,
}: {
  instance: InstanceSummary;
  jobs: JobSummary[];
  onSubmitted: (job: JobSummary) => void;
}) {
  const resource = useResource<{ groups: SecurityGroup[] }>(
    `/api/instances/${encodeURIComponent(instance.id)}/security`,
  );
  const watched = useRef(new Map<string, string | null>());
  useEffect(() => {
    let completed = false;
    for (const job of jobs) {
      if (
        job.accountId !== instance.accountId ||
        job.resourceId !== instance.id ||
        !["security-rule-add", "security-rule-delete"].includes(job.kind)
      )
        continue;
      if (isJobPending(job)) watched.current.set(job.id, null);
      else {
        const completion = JSON.stringify([
          job.state,
          job.attempt,
          job.maxAttempts,
          job.finishedAt,
        ]);
        const previous = watched.current.get(job.id);
        watched.current.set(job.id, completion);
        if (previous !== undefined && previous !== completion) completed = true;
      }
    }
    // The queued response precedes the cloud write. Re-read only after a watched
    // task finishes, including failures/cancellation that may follow a partial write.
    if (completed) void resource.reload();
  }, [jobs, instance.accountId, instance.id, resource.reload]);
  const submitted = (job: JobSummary) => {
    watched.current.set(job.id, null);
    onSubmitted(job);
  };
  const [adding, setAdding] = useState<SecurityGroup | null>(null);
  const [deleting, setDeleting] = useState<{ group: SecurityGroup; rule: SecurityRule } | null>(
    null,
  );
  const deletingGroup =
    resource.data?.groups.find((group) => group.id === deleting?.group.id) ?? deleting?.group;
  if (resource.loading) return <LoadingState label="正在读取安全规则…" />;
  return (
    <div className="flex flex-col gap-5">
      <div className="row flex items-center gap-2.5 justify-between">
        <p className="text-muted-foreground text-xs">
          同时显示网卡关联的网络安全组与子网安全列表。
        </p>
        <RefreshButton onClick={resource.reload} loading={resource.refreshing}>
          刷新规则
        </RefreshButton>
      </div>
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      {resource.data?.groups.length
        ? resource.data.groups.map((group) => (
            <Card
              key={group.id}
              title={group.name}
              description={group.kind === "nsg" ? "网络安全组 (NSG)" : "子网安全列表"}
              action={
                <Button size="sm" onClick={() => setAdding(group)}>
                  <Plus size={14} />
                  添加规则
                </Button>
              }
            >
              <p className="font-mono tabular-nums text-xs text-muted-foreground wrap-anywhere mb-3.5">
                {group.id} <CopyButton value={group.id} />
              </p>
              <TablePanel
                embedded
                label={`${group.name}安全规则`}
                refreshing={resource.refreshing}
                hasRows={group.rules.length > 0}
                empty={<EmptyState title="此资源中没有安全规则" icon={<ShieldCheck size={25} />} />}
              >
                <Table className="min-w-[730px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">方向</TableHead>
                      <TableHead scope="col">协议</TableHead>
                      <TableHead scope="col">来源 / 目标</TableHead>
                      <TableHead scope="col">目标端口</TableHead>
                      <TableHead scope="col">说明</TableHead>
                      <TableHead scope="col">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {group.rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <Badge tone={rule.direction === "INGRESS" ? "info" : "neutral"}>
                            {rule.direction === "INGRESS" ? "入站" : "出站"}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {protocolLabels[rule.protocol] || rule.protocol}
                          {rule.stateless && (
                            <span className="mt-1 block text-xs text-muted-foreground">无状态</span>
                          )}
                        </TableCell>
                        <TableCell className="font-mono tabular-nums">{rule.peer}</TableCell>
                        <TableCell>
                          {rule.portMin != null
                            ? `${rule.portMin}${rule.portMax != null && rule.portMax !== rule.portMin ? `–${rule.portMax}` : ""}`
                            : rule.icmpType != null
                              ? `类型 ${rule.icmpType}${rule.icmpCode != null ? ` / ${rule.icmpCode}` : ""}`
                              : "所有"}
                        </TableCell>
                        <TableCell>{rule.description || "—"}</TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setDeleting({ group, rule })}
                          >
                            删除
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TablePanel>
            </Card>
          ))
        : !resource.error && (
            <Card>
              <EmptyState
                title="没有可显示的安全规则"
                description="当前网卡未返回网络安全组或子网安全列表。"
              />
            </Card>
          )}
      {adding && (
        <RuleDialog
          instance={instance}
          group={resource.data?.groups.find((group) => group.id === adding.id) ?? adding}
          onClose={() => setAdding(null)}
          onSubmitted={submitted}
        />
      )}
      {deleting && deletingGroup && (
        <OperationDialog
          title="删除安全规则"
          description="此规则将从安全组或安全列表移除，并影响所有关联资源。"
          danger
          summary={[
            ["规则所属", deleting.group.name],
            ["方向", deleting.rule.direction === "INGRESS" ? "入站" : "出站"],
            ["来源 / 目标", deleting.rule.peer],
            ["协议", protocolLabels[deleting.rule.protocol] || deleting.rule.protocol],
          ]}
          operation={{
            kind: "security-rule-delete",
            accountId: instance.accountId,
            region: instance.region,
            resourceId: instance.id,
            payload: {
              groupId: deleting.group.id,
              groupKind: deleting.group.kind,
              etag: deletingGroup.etag,
              ruleId: deleting.rule.id,
            },
          }}
          onClose={() => setDeleting(null)}
          onSuccess={submitted}
        />
      )}
    </div>
  );
}
