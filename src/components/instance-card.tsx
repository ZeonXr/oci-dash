"use client";

import { useId } from "react";
import Link from "next/link";
import { Lock, Server } from "lucide-react";
import type { InstanceSummary, JobSummary, PublicIpBinding, VnicSummary } from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
import { Button, CopyButton, Status } from "./ui";
import { formatDate, instanceHref, number, primaryAddress, taskHref } from "./format";
import { RegionTag } from "./region-label";
import { CodeTag } from "./code-tag";
import { InventoryFreshness } from "./inventory-freshness";
import { canRotatePublicIp } from "./public-ip-rotation";

export function InstanceCard({
  instance,
  onRotate,
  rotationDisabled,
  rotationJob,
  rotationWarning = false,
}: {
  instance: InstanceSummary;
  onRotate: (vnic: VnicSummary, binding: PublicIpBinding) => void;
  rotationDisabled: boolean;
  rotationJob?: JobSummary;
  rotationWarning?: boolean;
}) {
  const titleId = useId();
  const address = primaryAddress(instance);
  const addresses = instance.vnics.flatMap((vnic) =>
    vnic.privateIps
      .filter((binding) => Boolean(binding.publicIp))
      .map((binding) => ({ vnic, binding })),
  );
  const pending = rotationJob && isJobPending(rotationJob);
  const failed =
    rotationJob && ["failed", "cancelled", "interrupted"].includes(rotationJob.state) && !pending;
  const syncing = rotationJob?.kind === "sync-account";
  const disabledReason = rotationWarning
    ? "地址同步不完整，请先刷新资源"
    : rotationDisabled
      ? "正在读取或处理此实例的任务"
      : !["RUNNING", "STOPPED"].includes(instance.state)
        ? "当前实例状态不可更换 IP"
        : undefined;
  return (
    <article className="card instance-card" aria-labelledby={titleId}>
      <div className="instance-card-heading">
        <span className="table-resource-icon">
          <Server size={18} aria-hidden="true" />
        </span>
        <div className="row row-wrap">
          <InventoryFreshness instance={instance} />
          <Status value={instance.state} />
        </div>
      </div>
      <h2 id={titleId}>
        <Link className="name-link" href={instanceHref(instance.id)}>
          {instance.displayName}
        </Link>
      </h2>
      <p className="instance-card-account" title={instance.accountName}>
        {instance.accountName}
      </p>
      <div className="instance-card-meta">
        <RegionTag region={instance.region} showName={false} />
        <CodeTag title={instance.shape}>{instance.shape.replace("VM.Standard.", "")}</CodeTag>
      </div>
      <dl className="instance-card-specs">
        <div>
          <dt>OCPU</dt>
          <dd>{number(instance.ocpus, 1)}</dd>
        </div>
        <div>
          <dt>内存</dt>
          <dd>
            {number(instance.memoryGb, 1)} <span>GB</span>
          </dd>
        </div>
      </dl>
      <div className="instance-card-address">
        {addresses.length ? (
          addresses.map(({ vnic, binding }) => {
            const fixed = binding.protected || binding.lifetime === "RESERVED";
            return (
              <div className="instance-ip-row" key={binding.privateIpId}>
                <span className="instance-ip-label muted small">
                  {fixed && <Lock size={11} aria-hidden="true" />}
                  {fixed ? "固定 IP" : binding.lifetime === "EPHEMERAL" ? "临时 IP" : "公网 IP"}
                </span>
                <div className="instance-ip-actions">
                  <span className="mono">{binding.publicIp}</span>
                  <CopyButton value={binding.publicIp!} label={`复制 ${binding.publicIp}`} />
                  {canRotatePublicIp(binding) &&
                    ["RUNNING", "STOPPED"].includes(instance.state) && (
                      <Button
                        variant="ghost"
                        className="button-sm"
                        aria-label={`更换 IP ${binding.publicIp}`}
                        disabled={Boolean(disabledReason)}
                        title={disabledReason || "更换此临时公网 IP"}
                        onClick={() => onRotate(vnic, binding)}
                      >
                        更换
                      </Button>
                    )}
                </div>
              </div>
            );
          })
        ) : (
          <div className="instance-ip-row">
            <span className="muted small">私网 IP</span>
            <div className="table-address mono">
              <span>{address}</span>
              {address !== "—" && (
                <CopyButton value={address} label={`复制 ${instance.displayName} 地址`} />
              )}
            </div>
          </div>
        )}
        {rotationJob &&
          (pending ||
            failed ||
            rotationWarning ||
            (rotationDisabled && rotationJob.state === "succeeded")) && (
            <Link
              href={taskHref(rotationJob.id)}
              className="instance-ip-task text-link"
              title={rotationJob.lastError || undefined}
            >
              {rotationWarning
                ? "地址同步不完整 · 查看任务"
                : pending
                  ? syncing
                    ? "正在更新地址 · 查看任务"
                    : "正在更换 IP · 查看任务"
                  : failed
                    ? syncing
                      ? "地址更新失败 · 查看任务"
                      : "更换未完成 · 查看任务"
                    : "正在更新地址 · 查看任务"}
            </Link>
          )}
      </div>
      <footer className="instance-card-footer">
        <span className="muted small">{formatDate(instance.createdAt)} 创建</span>
        <Link className="text-link" href={instanceHref(instance.id)}>
          查看详情
        </Link>
      </footer>
    </article>
  );
}
