"use client";
import { useState, type FormEvent } from "react";
import { HardDrive, Lock, Network, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import type {
  BootVolumeSummary,
  InstanceSummary,
  JobSummary,
  SecurityGroup,
  SecurityRule,
} from "@/lib/contracts";
import { useApp } from "./app-provider";
import { send, useAction, useResource } from "./api";
import { number, shortId, taskHref } from "./format";
import {
  Alert,
  Badge,
  Button,
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

export function NetworkPanel({ instance }: { instance: InstanceSummary }) {
  const { demo } = useApp();
  const [operation, setOperation] = useState<Omit<OperationDialogProps, "onClose"> | null>(null);
  return (
    <div className="stack">
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
            <div className="row row-wrap small muted" style={{ marginBottom: 18 }}>
              <Network size={15} />
              <span className="mono" title={vnic.id}>
                {shortId(vnic.id)}
              </span>
              <CopyButton value={vnic.id} />
              <span>子网 {shortId(vnic.subnetId)}</span>
              <span>{vnic.nsgIds.length} 个网络安全组</span>
            </div>
            <div className="table-scroll">
              <table className="network-table">
                <thead>
                  <tr>
                    <th>私网 IPv4</th>
                    <th>公网 IPv4</th>
                    <th>分配方式</th>
                    <th>保护状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {vnic.privateIps.map((binding) => (
                    <tr key={binding.privateIpId}>
                      <td>
                        <span className="mono">{binding.privateIp}</span>
                        <span className="cell-secondary">
                          {binding.isPrimary ? "主要私网地址" : "次要私网地址"}
                        </span>
                      </td>
                      <td>
                        <span className="table-address mono">
                          {binding.publicIp || "未绑定"}
                          {binding.publicIp && <CopyButton value={binding.publicIp} />}
                        </span>
                      </td>
                      <td>
                        {binding.lifetime === "RESERVED"
                          ? "保留公网 IP"
                          : binding.lifetime === "EPHEMERAL"
                            ? "临时公网 IP"
                            : "—"}
                      </td>
                      <td>
                        {binding.protected || binding.lifetime === "RESERVED" ? (
                          <Badge>
                            <Lock size={11} />
                            受保护
                          </Badge>
                        ) : (
                          <span className="muted">可轮换</span>
                        )}
                      </td>
                      <td>
                        <Button
                          variant="ghost"
                          className="button-sm"
                          disabled={
                            demo ||
                            binding.protected ||
                            binding.lifetime === "RESERVED" ||
                            !binding.publicIpId
                          }
                          title={
                            binding.protected || binding.lifetime === "RESERVED"
                              ? "保留或受保护地址不可轮换"
                              : demo
                                ? "演示模式仅供查看"
                                : undefined
                          }
                          onClick={() =>
                            setOperation({
                              title: "更换公网 IP",
                              description:
                                "将替换此私网地址绑定的临时公网 IP。旧地址释放后无法保证找回。",
                              summary: [
                                ["实例", instance.displayName],
                                ["网卡", vnic.name],
                                ["私网地址", binding.privateIp],
                                ["当前公网地址", binding.publicIp || "—"],
                              ],
                              operation: {
                                kind: "public-ip-rotate",
                                accountId: instance.accountId,
                                region: instance.region,
                                resourceId: instance.id,
                                payload: {
                                  vnicId: vnic.id,
                                  privateIpId: binding.privateIpId,
                                  expectedPublicIpId: binding.publicIpId,
                                  expectedPublicIp: binding.publicIp,
                                },
                              },
                            })
                          }
                        >
                          <RefreshCw size={13} />
                          更换 IP
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row between row-wrap" style={{ marginTop: 20 }}>
              <div>
                <p className="subsection-title">IPv6 地址</p>
                {vnic.ipv6.length ? (
                  vnic.ipv6.map((ip) => (
                    <div key={ip} className="row mono break-all">
                      {ip}
                      <CopyButton value={ip} />
                    </div>
                  ))
                ) : (
                  <p className="muted small">此网卡尚未分配 IPv6。</p>
                )}
              </div>
              <Button
                className="button-sm"
                disabled={demo}
                onClick={() =>
                  setOperation({
                    title: "分配 IPv6",
                    description: "为此网卡申请 IPv6 地址。所属子网需要已启用 IPv6。",
                    summary: [
                      ["实例", instance.displayName],
                      ["网卡", vnic.name],
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
  const { demo, notify } = useApp();
  const action = useAction();
  const [size, setSize] = useState(volume.sizeGb);
  const [vpu, setVpu] = useState(volume.vpusPerGb);
  const [ack, setAck] = useState(false);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (demo || !ack) return;
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
            disabled={demo || !ack || (size === volume.sizeGb && vpu === volume.vpusPerGb)}
            loading={action.pending}
          >
            保存配置
          </Button>
        </>
      }
    >
      <form id="volume-form" className="stack" onSubmit={submit}>
        <Field
          label="容量 (GiB)"
          hint={`当前 ${volume.sizeGb} GiB。OCI 在线扩容不支持缩小磁盘。`}
          required
        >
          <input
            type="number"
            required
            min={volume.sizeGb}
            max={32768}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
        </Field>
        <Field label="性能 (VPU / GB)" required>
          <Select value={vpu} onChange={(e) => setVpu(Number(e.target.value))}>
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
        <label className="checkbox-field">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          确认按上述容量与性能更新
        </label>
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
export function StoragePanel({ instance }: { instance: InstanceSummary }) {
  const { demo } = useApp();
  const [editing, setEditing] = useState<BootVolumeSummary | null>(null);
  return (
    <>
      <div className="stack">
        {instance.bootVolumes.length ? (
          instance.bootVolumes.map((volume) => (
            <Card
              key={volume.id}
              className="volume-card"
              title={volume.name}
              action={<Status value={volume.state} />}
            >
              <div className="row">
                <span className="resource-icon">
                  <HardDrive size={20} />
                </span>
                <div className="resource-label">
                  <strong>启动卷</strong>
                  <span className="mono">
                    {shortId(volume.id)} <CopyButton value={volume.id} />
                  </span>
                </div>
              </div>
              <dl className="details-list">
                <dt>容量</dt>
                <dd>{number(volume.sizeGb)} GiB</dd>
                <dt>配置性能</dt>
                <dd>{volume.vpusPerGb} VPU / GB</dd>
                <dt>区域</dt>
                <dd>{volume.region}</dd>
                <dt>挂载状态</dt>
                <dd>{volume.attachmentId ? "已附加到当前实例" : "未提供挂载信息"}</dd>
              </dl>
              <Button disabled={demo} onClick={() => setEditing(volume)}>
                调整容量与性能
              </Button>
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
  onSubmitted: () => void;
}) {
  const { demo, notify } = useApp();
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
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (demo) return;
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
      onSubmitted();
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
            disabled={demo}
            loading={action.pending}
          >
            添加规则
          </Button>
        </>
      }
    >
      <form id="security-rule-form" onSubmit={submit} className="stack">
        <Alert tone="info">
          规则会作用于此{group.kind === "nsg" ? "网络安全组" : "安全列表"}关联的所有资源。
        </Alert>
        <div className="form-grid">
          <Field label="方向">
            <Select
              value={form.direction}
              onChange={(e) =>
                setForm({ ...form, direction: e.target.value as "INGRESS" | "EGRESS" })
              }
            >
              <option value="INGRESS">入站</option>
              <option value="EGRESS">出站</option>
            </Select>
          </Field>
          <Field label="协议">
            <Select
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
            >
              <option value="6">TCP</option>
              <option value="17">UDP</option>
              <option value="1">ICMP</option>
              <option value="58">ICMPv6</option>
              <option value="all">所有协议</option>
            </Select>
          </Field>
          <Field label="地址类型" className="span-2">
            <Select
              value={form.peerType}
              onChange={(e) => setForm({ ...form, peerType: e.target.value })}
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
          <Field label={form.direction === "INGRESS" ? "来源" : "目标"} required className="span-2">
            <input
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
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={form.portMin}
                  onChange={(e) => setForm({ ...form, portMin: e.target.value })}
                  placeholder="例如 443"
                />
              </Field>
              <Field label="目标结束端口" hint="留空表示与起始端口相同。">
                <input
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
                <input
                  type="number"
                  min={0}
                  max={255}
                  value={form.icmpType}
                  onChange={(e) => setForm({ ...form, icmpType: e.target.value })}
                />
              </Field>
              <Field label="ICMP 代码">
                <input
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
          <Field label="说明" className="span-2">
            <input
              value={form.description}
              maxLength={255}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="说明这条规则的用途"
            />
          </Field>
        </div>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.stateless}
            onChange={(e) => setForm({ ...form, stateless: e.target.checked })}
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
export function SecurityPanel({ instance }: { instance: InstanceSummary }) {
  const { demo } = useApp();
  const resource = useResource<{ groups: SecurityGroup[]; demo: boolean }>(
    `/api/instances/${encodeURIComponent(instance.id)}/security`,
  );
  const [adding, setAdding] = useState<SecurityGroup | null>(null);
  const [deleting, setDeleting] = useState<{ group: SecurityGroup; rule: SecurityRule } | null>(
    null,
  );
  if (resource.loading) return <LoadingState label="正在读取安全规则…" />;
  return (
    <div className="stack">
      <div className="row between">
        <p className="muted small">同时显示网卡关联的网络安全组与子网安全列表。</p>
        <Button onClick={resource.reload} loading={resource.refreshing}>
          <RefreshCw size={14} />
          刷新规则
        </Button>
      </div>
      {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
      {resource.data?.groups.length
        ? resource.data.groups.map((group) => (
            <Card
              key={group.id}
              title={group.name}
              description={group.kind === "nsg" ? "网络安全组 (NSG)" : "子网安全列表"}
              action={
                <Button className="button-sm" disabled={demo} onClick={() => setAdding(group)}>
                  <Plus size={14} />
                  添加规则
                </Button>
              }
            >
              <p className="mono small muted break-all" style={{ marginBottom: 14 }}>
                {group.id} <CopyButton value={group.id} />
              </p>
              {group.rules.length ? (
                <div className="table-scroll">
                  <table className="network-table">
                    <thead>
                      <tr>
                        <th>方向</th>
                        <th>协议</th>
                        <th>来源 / 目标</th>
                        <th>目标端口</th>
                        <th>说明</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rules.map((rule) => (
                        <tr key={rule.id}>
                          <td>
                            <Badge tone={rule.direction === "INGRESS" ? "info" : "neutral"}>
                              {rule.direction === "INGRESS" ? "入站" : "出站"}
                            </Badge>
                          </td>
                          <td>
                            {protocolLabels[rule.protocol] || rule.protocol}
                            {rule.stateless && <span className="cell-secondary">无状态</span>}
                          </td>
                          <td className="mono">{rule.peer}</td>
                          <td>
                            {rule.portMin != null
                              ? `${rule.portMin}${rule.portMax != null && rule.portMax !== rule.portMin ? `–${rule.portMax}` : ""}`
                              : rule.icmpType != null
                                ? `类型 ${rule.icmpType}${rule.icmpCode != null ? ` / ${rule.icmpCode}` : ""}`
                                : "所有"}
                          </td>
                          <td>{rule.description || "—"}</td>
                          <td>
                            <Button
                              variant="ghost"
                              className="button-sm danger-text"
                              disabled={demo}
                              onClick={() => setDeleting({ group, rule })}
                            >
                              删除
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="此资源中没有安全规则" icon={<ShieldCheck size={25} />} />
              )}
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
          group={adding}
          onClose={() => setAdding(null)}
          onSubmitted={resource.reload}
        />
      )}
      {deleting && (
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
              etag: deleting.group.etag,
              ruleId: deleting.rule.id,
            },
          }}
          onClose={() => setDeleting(null)}
          onSuccess={resource.reload}
        />
      )}
    </div>
  );
}
