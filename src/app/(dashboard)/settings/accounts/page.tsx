"use client";
import { useEffect, useState } from "react";
import { KeyRound, Plus, RefreshCw } from "lucide-react";
import type { AccountSummary, JobSummary } from "@/lib/contracts";
import { isJobPending as pendingSync } from "@/lib/job-state";
import { api, send, useAction, useResource } from "@/components/api";
import { AccountDialog } from "@/components/account-dialog";
import { useApp } from "@/components/app-provider";
import { useInventoryRefresh } from "@/components/inventory-refresh";
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
  Status,
} from "@/components/ui";
import { shortId, taskHref } from "@/components/format";
import { RegionLabel } from "@/components/region-label";
import { UpdatedAt } from "@/components/updated-at";

function connectionLabel(account: AccountSummary, job: JobSummary): string {
  if (job.state === "queued") return account.lastSyncAt ? "等待刷新" : "等待连接";
  if (job.state === "retrying") return "正在重试";
  if (job.state === "cancel_requested") return "正在取消";
  if (job.state === "interrupted") return "等待恢复";
  return account.lastSyncAt ? "刷新中" : "连接中";
}
function connectionAction(account: AccountSummary, job?: JobSummary): string {
  if (job && pendingSync(job)) return connectionLabel(account, job);
  if (
    account.status === "error" ||
    (job && ["failed", "cancelled", "interrupted"].includes(job.state))
  ) {
    return account.lastSyncAt ? "重试刷新" : "重试连接";
  }
  return account.status === "unchecked" ? "连接账号" : "刷新资源";
}

export default function AccountsPage() {
  const { demo, notify, reloadAccounts } = useApp();
  const [pollMs, setPollMs] = useState(30000);
  const resource = useResource<{
    accounts: AccountSummary[];
    syncJobs?: JobSummary[];
    demo: boolean;
  }>("/api/accounts", pollMs);
  const inventory = useInventoryRefresh({ onUpdated: resource.reload });
  useEffect(() => {
    const active = resource.data?.syncJobs?.some(pendingSync);
    setPollMs(active ? 3000 : 30000);
  }, [resource.data?.syncJobs]);
  const action = useAction();
  const [editing, setEditing] = useState<AccountSummary | null | undefined>(undefined);
  const [removing, setRemoving] = useState<AccountSummary | null>(null);
  const [removeName, setRemoveName] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const refresh = () => {
    resource.reload();
    reloadAccounts();
  };
  const sync = async (account: AccountSummary) => {
    if (demo) return;
    setBusyKey(`${account.id}:sync`);
    const response = await action.run(() =>
      send<{ job: JobSummary }>(`/api/accounts/${encodeURIComponent(account.id)}/sync`),
    );
    if (response) {
      notify(`${account.name} 正在检查连接并读取资源。`, taskHref(response.job.id));
      resource.setData((current) =>
        current
          ? {
              ...current,
              syncJobs: [
                ...(current.syncJobs ?? []).filter((job) => job.accountId !== account.id),
                response.job,
              ],
            }
          : current,
      );
      refresh();
    }
    setBusyKey("");
  };
  const remove = async () => {
    if (demo || !removing || removeName !== removing.name) return;
    const response = await action.run(() =>
      api(`/api/accounts/${encodeURIComponent(removing.id)}`, { method: "DELETE" }),
    );
    if (response) {
      notify("账号配置已移除。");
      setRemoving(null);
      refresh();
    }
  };
  const syncJobs = new Map((resource.data?.syncJobs ?? []).map((job) => [job.accountId, job]));
  return (
    <section className="settings-accounts" aria-label="OCI 账号">
      <div className="settings-account-toolbar">
        <p>管理 OCI 连接凭据与区域同步范围。</p>
        <Button variant="primary" disabled={demo} onClick={() => setEditing(null)}>
          <Plus size={16} />
          添加账号
        </Button>
      </div>
      <div className="stack">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        {inventory.error && <ErrorState message={inventory.error} retry={inventory.refresh} />}
        {action.error && !removing && <ErrorState message={action.error} />}
        {resource.loading ? (
          <LoadingState />
        ) : resource.data?.accounts.length ? (
          <div className="grid-3">
            {resource.data.accounts.map((account) => {
              const job = syncJobs.get(account.id);
              const syncing = Boolean(job && pendingSync(job));
              const error =
                account.lastError ||
                (job && ["failed", "interrupted"].includes(job.state) ? job.lastError : null);
              const label = connectionAction(account, job);
              const requesting = busyKey === `${account.id}:sync`;
              return (
                <Card key={account.id} className="account-card">
                  <div className="account-heading">
                    <span className="resource-icon">
                      <KeyRound size={20} />
                    </span>
                    <div className="grow">
                      <h2>{account.name}</h2>
                      <p className="muted small">
                        <RegionLabel region={account.homeRegion} /> · 主区域
                      </p>
                    </div>
                    {syncing && job ? (
                      <Badge tone="info">{connectionLabel(account, job)}</Badge>
                    ) : (
                      <Status value={account.status} />
                    )}
                  </div>
                  <div className="account-meta">
                    <div className="row">
                      <span>租户</span>
                      <span className="mono" title={account.tenancyId}>
                        {shortId(account.tenancyId)}
                      </span>
                      <CopyButton value={account.tenancyId} />
                    </div>
                    <div className="region-chips">
                      {account.regions.map((region) => (
                        <Badge key={region}>
                          <RegionLabel region={region} />
                        </Badge>
                      ))}
                    </div>
                    <UpdatedAt
                      value={account.lastSyncAt}
                      title="此账号最近一次从 OCI 获取资源快照的时间"
                    />
                  </div>
                  {!syncing && error && <Alert tone="error">{error}</Alert>}
                  <div className="account-actions">
                    <Button
                      className="button-sm"
                      disabled={demo || action.pending || syncing}
                      loading={requesting || syncing}
                      onClick={() => sync(account)}
                    >
                      {!requesting && !syncing && <RefreshCw size={13} />}
                      {label}
                    </Button>
                    <Button
                      className="button-sm"
                      variant="ghost"
                      disabled={demo}
                      onClick={() => setEditing(account)}
                    >
                      编辑
                    </Button>
                    <Button
                      className="button-sm danger-text"
                      variant="ghost"
                      disabled={demo || syncing}
                      onClick={() => {
                        setRemoving(account);
                        setRemoveName("");
                        action.clearError();
                      }}
                    >
                      移除
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        ) : (
          <Card>
            <EmptyState
              icon={<KeyRound size={25} />}
              title="添加你的第一个 OCI 账号"
              description="粘贴 OCI 配置并上传 PEM 私钥文件，即可添加账号。"
              action={
                <Button variant="primary" disabled={demo} onClick={() => setEditing(null)}>
                  <Plus size={15} />
                  添加账号
                </Button>
              }
            />
          </Card>
        )}
      </div>
      {editing !== undefined && (
        <AccountDialog
          account={editing || undefined}
          onClose={() => setEditing(undefined)}
          onSaved={refresh}
        />
      )}
      {removing && (
        <Modal
          open
          title="移除账号配置"
          description="只移除此应用中保存的账号配置，不会删除 OCI 云资源。"
          busy={action.pending}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button onClick={() => setRemoving(null)} disabled={action.pending}>
                取消
              </Button>
              <Button
                variant="danger"
                disabled={demo || removeName !== removing.name}
                loading={action.pending}
                onClick={remove}
              >
                移除配置
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label={`输入「${removing.name}」以确认`}>
              <input
                autoComplete="off"
                value={removeName}
                onChange={(e) => setRemoveName(e.target.value)}
                placeholder={removing.name}
              />
            </Field>
            {action.error && <ErrorState message={action.error} />}
          </div>
        </Modal>
      )}
    </section>
  );
}
