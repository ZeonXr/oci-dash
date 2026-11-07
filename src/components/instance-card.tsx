"use client";

import { useId } from "react";
import Link from "next/link";
import { Server } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import { CopyButton, Status } from "./ui";
import { formatDate, instanceHref, number, primaryAddress } from "./format";
import { RegionLabel } from "./region-label";

export function InstanceCard({ instance }: { instance: InstanceSummary }) {
  const titleId = useId();
  const address = primaryAddress(instance);
  return (
    <article className="card instance-card" aria-labelledby={titleId}>
      <div className="instance-card-heading">
        <span className="table-resource-icon">
          <Server size={18} aria-hidden="true" />
        </span>
        <Status value={instance.state} />
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
        <RegionLabel region={instance.region} />
        <span className="instance-card-shape" title={instance.shape}>
          {instance.shape.replace("VM.Standard.", "")}
        </span>
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
        <span className="muted small">主要地址</span>
        <div className="table-address mono">
          <span>{address}</span>
          {address !== "—" && (
            <CopyButton value={address} label={`复制 ${instance.displayName} 地址`} />
          )}
        </div>
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
