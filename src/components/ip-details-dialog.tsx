"use client";

import { useState, type ReactNode } from "react";
import type { InstanceSummary, JobSummary } from "@/lib/contracts";
import { send, useAction } from "./api";
import { useApp } from "./app-provider";
import { CodeTag } from "./code-tag";
import { taskHref } from "./format";
import { getIpDetails, type IpDetailsTarget } from "./ip-address";
import { RegionTag } from "./region-label";
import { Alert, Badge, Button, CopyButton, ErrorState, Modal } from "./ui";
import styles from "./ip-details-dialog.module.css";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      <strong className={styles.value}>{children}</strong>
    </div>
  );
}

function Identifier({ value, label }: { value: string; label: string }) {
  return (
    <span className={styles.identifier}>
      <CodeTag>{value}</CodeTag>
      <CopyButton value={value} label={`复制${label}`} />
    </span>
  );
}

export function IpDetailsDialog({
  instance,
  target,
  blockedReason,
  onClose,
  onSuccess,
}: {
  instance?: InstanceSummary;
  target: IpDetailsTarget;
  blockedReason?: string;
  onClose: () => void;
  onSuccess?: (job: JobSummary) => void;
}) {
  const { notify } = useApp();
  const action = useAction();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const { vnic, binding, reason, operation } = getIpDetails(instance, target, blockedReason);
  const addressType =
    target.kind === "ipv6"
      ? "IPv6"
      : target.kind === "private"
        ? "私网 IPv4"
        : binding?.lifetime === "RESERVED"
          ? "保留公网 IPv4"
          : binding?.lifetime === "EPHEMERAL"
            ? "临时公网 IPv4"
            : "公网 IPv4";
  const replace = async () => {
    if (!operation || reason) return;
    const response = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", { ...operation, idempotencyKey }),
    );
    if (response) {
      notify("更换公网 IP 任务已提交。", taskHref(response.job.id));
      onSuccess?.(response.job);
      onClose();
    }
  };
  const identifiers = [
    ["网卡 OCID", target.vnicId],
    ["私网 IP OCID", target.privateIpId],
    ["公网 IP OCID", target.publicIpId],
    ["子网 OCID", vnic?.subnetId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
  return (
    <Modal
      open
      title="IP 详情"
      description="查看地址及网卡绑定信息。"
      onClose={onClose}
      busy={action.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            关闭
          </Button>
          <Button
            variant="primary"
            disabled={!operation || Boolean(reason)}
            title={reason}
            loading={action.pending}
            onClick={replace}
          >
            更换公网 IP
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className={`confirm-summary ${styles.summary}`}>
          <Row label="IP 地址">
            <Identifier value={target.address} label="IP 地址" />
          </Row>
          <Row label="类型">
            {addressType}
            {target.kind === "public" && binding?.protected && <Badge>已保护</Badge>}
          </Row>
          <Row label="实例">{instance?.displayName || "实例信息不可用"}</Row>
          {instance && (
            <Row label="区域">
              <RegionTag region={instance.region} />
            </Row>
          )}
          <Row label="网卡名称">
            {vnic ? (
              <>
                <CodeTag>{vnic.name || vnic.id}</CodeTag>
                <Badge>{vnic.primary ? "主网卡" : "附加网卡"}</Badge>
              </>
            ) : (
              "网卡信息不可用"
            )}
          </Row>
          {binding && (
            <>
              <Row label="私网地址角色">{binding.isPrimary ? "主要私网地址" : "次要私网地址"}</Row>
              {(target.kind !== "private" || binding.privateIp !== target.address) && (
                <Row label="私网地址">
                  <Identifier value={binding.privateIp} label="私网地址" />
                </Row>
              )}
              {binding.publicIp &&
                (target.kind !== "public" || binding.publicIp !== target.address) && (
                  <Row label="当前公网地址">
                    <Identifier value={binding.publicIp} label="当前公网地址" />
                  </Row>
                )}
            </>
          )}
        </div>
        {reason ? (
          <Alert tone="info">{reason}</Alert>
        ) : (
          <Alert>更换将释放此私网地址绑定的临时公网 IP，旧地址释放后无法保证找回。</Alert>
        )}
        {action.error && <ErrorState message={action.error} />}
        <details className={styles.identifiers}>
          <summary>资源标识</summary>
          <dl>
            {identifiers.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <Identifier value={value} label={label} />
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </div>
    </Modal>
  );
}
