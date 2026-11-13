"use client";

import type { ReactNode } from "react";
import type { AccountSummary } from "@/lib/contracts";
import type { AccountDetails } from "@/lib/account-details-contracts";
import { useResource } from "./api";
import { CodeTag } from "./code-tag";
import { formatDate, number } from "./format";
import { RegionTag } from "./region-label";
import {
  Alert,
  Badge,
  Button,
  CopyButton,
  ErrorState,
  LoadingState,
  Modal,
  RefreshButton,
  Status,
} from "./ui";
const styles = {
  content: "flex min-w-0 flex-col gap-6",
  section:
    "flex min-w-0 flex-col gap-4 [&+section]:border-t [&+section]:border-border [&+section]:pt-6 [&_h3]:text-sm [&_h3]:font-semibold",
  sectionHeading: "flex flex-wrap items-center justify-between gap-3",
  sectionNote: "flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground",
  details:
    "m-0 grid grid-cols-2 gap-6 max-sm:grid-cols-1 [&_dt]:text-xs [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:min-w-0 [&_dd]:text-sm [&_dd]:wrap-anywhere",
  detail: "flex min-w-0 flex-col gap-2",
  wideDetail: "col-span-full flex min-w-0 flex-col gap-2",
  identifier:
    "flex min-w-0 items-center gap-2 *:first:min-w-0 *:first:whitespace-normal *:first:wrap-anywhere *:last:shrink-0",
  tags: "flex min-w-0 flex-wrap items-center gap-2",
  stats:
    "grid grid-cols-5 gap-4 max-sm:grid-cols-2 [&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>div]:gap-2 [&_span]:text-xs [&_span]:text-muted-foreground [&_small]:text-xs [&_small]:font-normal [&_small]:text-muted-foreground [&_strong]:flex [&_strong]:flex-wrap [&_strong]:items-baseline [&_strong]:gap-1 [&_strong]:text-2xl [&_strong]:font-semibold [&_strong]:leading-tight max-sm:[&>div:first-child]:col-span-full",
  regionList: "flex flex-col gap-3",
  regionRow: "flex flex-wrap items-center justify-between gap-3",
  empty: "text-xs text-muted-foreground",
};

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
    <div className={wide ? styles.wideDetail : styles.detail}>
      <dt>{label}</dt>
      <dd>{children}</dd>
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
      <div className={styles.content}>
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        <section className={styles.section} aria-label="连接配置">
          <div className={styles.sectionHeading}>
            <h3>连接配置</h3>
            <Status value={account.status} />
          </div>
          <dl className={styles.details}>
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
              <div className={styles.tags}>
                {account.regions.map((region) => (
                  <RegionTag key={region} region={region} />
                ))}
              </div>
            </Detail>
          </dl>
          {account.lastError && <Alert tone="error">{account.lastError}</Alert>}
        </section>

        {inventory && (
          <section className={styles.section} aria-label="已同步资源">
            <div className={styles.sectionHeading}>
              <h3>已同步资源</h3>
              {inventory.partial && <Badge tone="warning">部分资源未更新</Badge>}
            </div>
            <div className={styles.stats}>
              <div>
                <span>实例</span>
                <strong>{number(inventory.instances)}</strong>
                <small>
                  {number(inventory.running)} 运行中 · {number(inventory.stopped)} 已停止
                </small>
              </div>
              <div>
                <span>OCPU</span>
                <strong>{number(inventory.ocpus, 2)}</strong>
              </div>
              <div>
                <span>内存</span>
                <strong>
                  {number(inventory.memoryGb, 2)}
                  <small>GiB</small>
                </strong>
              </div>
              <div>
                <span>启动卷</span>
                <strong>
                  {number(inventory.bootVolumeGb, 2)}
                  <small>GiB</small>
                </strong>
              </div>
              <div>
                <span>公网 IPv4</span>
                <strong>{number(inventory.publicIps)}</strong>
              </div>
            </div>
            <div className={styles.sectionNote}>
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
            <section className={styles.section} aria-label="OCI 租户">
              <h3>OCI 租户</h3>
              {tenancyError && <Alert tone="warning">{tenancyError}</Alert>}
              {cloud.tenancy && (
                <dl className={styles.details}>
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
            <section className={styles.section} aria-label="OCI 身份用户">
              <h3>OCI 身份用户</h3>
              {userError && <Alert tone="warning">{userError}</Alert>}
              {cloud.user && (
                <dl className={styles.details}>
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
            <section className={styles.section} aria-label="OCI 已订阅区域">
              <h3>OCI 已订阅区域</h3>
              {regionError && <Alert tone="warning">{regionError}</Alert>}
              {cloud.regions &&
                (cloud.regions.length ? (
                  <div className={styles.regionList}>
                    {cloud.regions.map((region) => (
                      <div key={region.name} className={styles.regionRow}>
                        <RegionTag region={region.name} />
                        <div className={styles.tags}>
                          {region.home && <Badge tone="info">主区域</Badge>}
                          {account.regions.includes(region.name) && <Badge>已启用同步</Badge>}
                          <CodeTag>{region.status}</CodeTag>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={styles.empty}>未返回已订阅区域。</p>
                ))}
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}
