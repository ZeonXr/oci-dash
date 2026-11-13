"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { AccountSummary } from "@/lib/contracts";
import type { AccountDetails } from "@/lib/account-details-contracts";
import { useResource } from "./api";
import { CodeTag } from "./code-tag";
import { formatDate, number } from "./format";
import { RegionTag } from "./region-label";
import {
  Alert,
  StatusBadge,
  Button,
  CopyButton,
  ErrorState,
  LoadingState,
  Modal,
  RefreshButton,
  Status,
} from "./ui";
const sectionClassName = cn("flex min-w-0 flex-col gap-4 [&+section]:border-t [&+section]:pt-6");
const detailGridClassName = cn("m-0 grid grid-cols-2 gap-6 max-sm:grid-cols-1");

function Detail({
  label,
  children,
  wide = false,
}: {
  label: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", wide && "col-span-full")}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="m-0 min-w-0 text-sm wrap-anywhere">{children}</dd>
    </div>
  );
}

function Identifier({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <CodeTag>{value}</CodeTag>
      <CopyButton value={value} label={`复制${label}`} />
    </span>
  );
}

export function AccountDetailsDialog({
  account: initialAccount,
  onClose,
}: {
  account: AccountSummary;
  onClose: () => void;
}) {
  const resource = useResource<AccountDetails>(
    `/api/accounts/${encodeURIComponent(initialAccount.id)}/details`,
  );
  const account = resource.data?.account ?? initialAccount;
  const inventory = resource.data?.inventory;
  const cloud = resource.data?.cloud;
  const home = cloud?.regions?.find((region) => region.home);
  const sectionError = (section: "tenancy" | "user" | "regions") =>
    cloud?.errors.find((error) => error.section === section)?.message;
  const regionError = sectionError("regions");
  const tenancyError = sectionError("tenancy");
  const userError = sectionError("user");
  return (
    <Modal
      open
      wide
      initialFocus="title"
      title="账号详情"
      description={account.name}
      onClose={onClose}
      footer={
        <>
          <RefreshButton label="刷新详情" onClick={resource.reload} updatedAt={cloud?.checkedAt} />
          <Button onClick={onClose}>关闭</Button>
        </>
      }
    >
      <div className="flex min-w-0 flex-col gap-6">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        <section className={sectionClassName} aria-label="连接配置">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">连接配置</h3>
            <Status value={account.status} />
          </div>
          <dl className={detailGridClassName}>
            <Detail label="配置主区域">
              <RegionTag region={account.homeRegion} />
            </Detail>
            <Detail label="添加时间">{formatDate(account.createdAt, true)}</Detail>
            <Detail label="Tenancy OCID" wide>
              <Identifier value={account.tenancyId} label="Tenancy OCID" />
            </Detail>
            <Detail label="User OCID" wide>
              <Identifier value={account.userId} label="User OCID" />
            </Detail>
            <Detail label="API 密钥指纹" wide>
              <Identifier value={account.fingerprint} label="API 密钥指纹" />
            </Detail>
            <Detail label="同步区域" wide>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {account.regions.map((region) => (
                  <RegionTag key={region} region={region} />
                ))}
              </div>
            </Detail>
          </dl>
          {account.lastError && <Alert tone="error">{account.lastError}</Alert>}
        </section>

        {inventory && (
          <section className={sectionClassName} aria-label="已同步资源">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">已同步资源</h3>
              {inventory.partial && <StatusBadge tone="warning">部分资源未更新</StatusBadge>}
            </div>
            <div className="grid grid-cols-5 gap-4 max-sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2 max-sm:col-span-full">
                <span className="text-xs text-muted-foreground">实例</span>
                <strong className="flex flex-wrap items-baseline gap-1 text-2xl leading-tight font-semibold">
                  {number(inventory.instances)}
                </strong>
                <small className="text-xs font-normal text-muted-foreground">
                  {number(inventory.running)} 运行中 · {number(inventory.stopped)} 已停止
                </small>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs text-muted-foreground">OCPU</span>
                <strong className="flex flex-wrap items-baseline gap-1 text-2xl leading-tight font-semibold">
                  {number(inventory.ocpus, 2)}
                </strong>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs text-muted-foreground">内存</span>
                <strong className="flex flex-wrap items-baseline gap-1 text-2xl leading-tight font-semibold">
                  {number(inventory.memoryGb, 2)}
                  <small className="text-xs font-normal text-muted-foreground">GiB</small>
                </strong>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs text-muted-foreground">启动卷</span>
                <strong className="flex flex-wrap items-baseline gap-1 text-2xl leading-tight font-semibold">
                  {number(inventory.bootVolumeGb, 2)}
                  <small className="text-xs font-normal text-muted-foreground">GiB</small>
                </strong>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-xs text-muted-foreground">公网 IPv4</span>
                <strong className="flex flex-wrap items-baseline gap-1 text-2xl leading-tight font-semibold">
                  {number(inventory.publicIps)}
                </strong>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
              <span>当前配置区域内的资源快照</span>
              {inventory.lastSyncedAt && (
                <time dateTime={inventory.lastSyncedAt}>
                  同步于 {formatDate(inventory.lastSyncedAt, true)}
                </time>
              )}
            </div>
          </section>
        )}

        {resource.loading && <LoadingState label="正在读取 OCI 账号信息…" />}
        {cloud && (
          <>
            <section className={sectionClassName} aria-label="OCI 租户">
              <h3 className="text-sm font-semibold">OCI 租户</h3>
              {tenancyError && <Alert tone="warning">{tenancyError}</Alert>}
              {cloud.tenancy && (
                <dl className={detailGridClassName}>
                  <Detail label="租户名称">{cloud.tenancy.name}</Detail>
                  <Detail label="OCI 主区域">
                    {home ? (
                      <RegionTag region={home.name} />
                    ) : cloud.tenancy.homeRegionKey ? (
                      <CodeTag>{cloud.tenancy.homeRegionKey}</CodeTag>
                    ) : (
                      "—"
                    )}
                  </Detail>
                  {cloud.tenancy.description && (
                    <Detail label="描述" wide>
                      {cloud.tenancy.description}
                    </Detail>
                  )}
                </dl>
              )}
            </section>
            <section className={sectionClassName} aria-label="OCI 身份用户">
              <h3 className="text-sm font-semibold">OCI 身份用户</h3>
              {userError && <Alert tone="warning">{userError}</Alert>}
              {cloud.user && (
                <dl className={detailGridClassName}>
                  <Detail label="用户名称">{cloud.user.name}</Detail>
                  <Detail label="状态">
                    {cloud.user.state ? <CodeTag>{cloud.user.state}</CodeTag> : "—"}
                  </Detail>
                  <Detail label="电子邮箱">{cloud.user.email || "—"}</Detail>
                  <Detail label="创建时间">{formatDate(cloud.user.createdAt, true)}</Detail>
                  <Detail label="OCI 用户 MFA">
                    {cloud.user.mfaActivated == null
                      ? "未返回"
                      : cloud.user.mfaActivated
                        ? "已启用"
                        : "未启用"}
                  </Detail>
                  {cloud.user.description && (
                    <Detail label="描述" wide>
                      {cloud.user.description}
                    </Detail>
                  )}
                </dl>
              )}
            </section>
            <section className={sectionClassName} aria-label="OCI 已订阅区域">
              <h3 className="text-sm font-semibold">OCI 已订阅区域</h3>
              {regionError && <Alert tone="warning">{regionError}</Alert>}
              {cloud.regions &&
                (cloud.regions.length ? (
                  <div className="flex flex-col gap-3">
                    {cloud.regions.map((region) => (
                      <div
                        key={region.name}
                        className="flex flex-wrap items-center justify-between gap-3"
                      >
                        <RegionTag region={region.name} />
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          {region.home && <StatusBadge tone="info">主区域</StatusBadge>}
                          {account.regions.includes(region.name) && (
                            <StatusBadge>已启用同步</StatusBadge>
                          )}
                          <CodeTag>{region.status}</CodeTag>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">未返回已订阅区域。</p>
                ))}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
