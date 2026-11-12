"use client";

import { useId } from "react";
import Link from "next/link";
import { Lock, Server } from "lucide-react";
import type { InstanceSummary, JobSummary } from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
import { CopyButton, Status } from "./ui";
import { Card } from "./ui/card";
import { formatDate, instanceHref, number, taskHref } from "./format";
import { RegionTag } from "./region-label";
import { CodeTag } from "./code-tag";
import { InventoryFreshness } from "./inventory-freshness";
import {
  IpAddressButton,
  primaryIpTarget,
  targetForBinding,
  type IpDetailsTarget,
} from "./ip-address";

export function InstanceCard({
  instance,
  onAddress,
  rotationDisabled,
  rotationJob,
  rotationWarning = false,
}: {
  instance: InstanceSummary;
  onAddress: (target: IpDetailsTarget) => void;
  rotationDisabled: boolean;
  rotationJob?: JobSummary;
  rotationWarning?: boolean;
}) {
  const titleId = useId();
  const fallback = primaryIpTarget(instance);
  const addresses = instance.vnics.flatMap((vnic) =>
    vnic.privateIps
      .filter((binding) => Boolean(binding.publicIp))
      .map((binding) => ({ vnic, binding })),
  );
  const pending = rotationJob && isJobPending(rotationJob);
  const failed =
    rotationJob && ["failed", "cancelled", "interrupted"].includes(rotationJob.state) && !pending;
  const syncing = rotationJob?.kind === "sync-account";
  return (
    <Card
      role="article"
      className="instance-card flex flex-col gap-0 p-5 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:leading-normal [&_h2]:wrap-anywhere"
      aria-labelledby={titleId}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Server size={18} aria-hidden="true" />
        </span>
        <div className="row flex items-center gap-2.5 flex-wrap">
          <InventoryFreshness instance={instance} />
          <Status value={instance.state} />
        </div>
      </div>
      <h2 id={titleId}>
        <Link
          className="name-link inline-flex items-center gap-2 font-medium text-foreground hover:text-primary"
          href={instanceHref(instance.id)}
        >
          {instance.displayName}
        </Link>
      </h2>
      <p
        className="mt-1 mb-3 text-xs text-muted-foreground wrap-anywhere"
        title={instance.accountName}
      >
        {instance.accountName}
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <RegionTag region={instance.region} />
        <CodeTag title={instance.shape}>{instance.shape.replace("VM.Standard.", "")}</CodeTag>
      </div>
      <dl className="my-4 grid grid-cols-2 gap-4 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:mt-1 [&_dd]:text-xl [&_dd]:font-medium [&_dd]:tabular-nums [&_dd_span]:text-xs [&_dd_span]:font-normal [&_dd_span]:text-muted-foreground">
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
      <div className="mt-auto grid gap-2 border-y py-3 text-xs [&_.table-address]:min-w-0 [&_.table-address]:max-w-full">
        {addresses.length ? (
          addresses.map(({ vnic, binding }) => {
            const fixed = binding.protected || binding.lifetime === "RESERVED";
            return (
              <div
                className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
                key={binding.privateIpId}
              >
                <span className="inline-flex items-center gap-1 text-muted-foreground text-xs">
                  {fixed && <Lock size={11} aria-hidden="true" />}
                  {fixed ? "固定 IP" : binding.lifetime === "EPHEMERAL" ? "临时 IP" : "公网 IP"}
                </span>
                <div className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <IpAddressButton target={targetForBinding(vnic, binding)} onClick={onAddress} />
                  <CopyButton value={binding.publicIp!} label={`复制 ${binding.publicIp}`} />
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="text-muted-foreground text-xs">
              {fallback?.kind === "ipv6" ? "IPv6" : "私网 IP"}
            </span>
            <div className="flex items-center gap-1 whitespace-nowrap font-mono tabular-nums">
              {fallback ? (
                <>
                  <IpAddressButton target={fallback} onClick={onAddress} />
                  <CopyButton
                    value={fallback.address}
                    label={`复制 ${instance.displayName} 地址`}
                  />
                </>
              ) : (
                "—"
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
              className="justify-self-end inline-flex items-center gap-1 text-xs text-primary hover:underline underline-offset-4"
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
      <footer className="flex flex-wrap items-center justify-between gap-3 pt-3 text-xs">
        <span className="text-muted-foreground text-xs">{formatDate(instance.createdAt)} 创建</span>
        <Link
          className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
          href={instanceHref(instance.id)}
        >
          查看详情
        </Link>
      </footer>
    </Card>
  );
}
