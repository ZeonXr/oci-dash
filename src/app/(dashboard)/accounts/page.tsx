"use client";
import { useState } from "react";
import { CheckCircle2, KeyRound, Plus, RefreshCw } from "lucide-react";
import type { AccountSummary, JobSummary } from "@/lib/contracts";
import { api, send, useAction, useResource } from "@/components/api";
import { AccountDialog } from "@/components/account-dialog";
import { useApp } from "@/components/app-provider";
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
  PageHeader,
  Status,
} from "@/components/ui";
import { formatDate, regionName, shortId, taskHref } from "@/components/format";

export default function AccountsPage() {
  const { demo, notify, reloadAccounts } = useApp();
  const resource = useResource<{ accounts: AccountSummary[]; demo: boolean }>(
    "/api/accounts",
    30000,
  );
  const action = useAction();
  const [editing, setEditing] = useState<AccountSummary | null | undefined>(undefined);
  const [removing, setRemoving] = useState<AccountSummary | null>(null);
  const [removeName, setRemoveName] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const refresh = () => {
    resource.reload();
    reloadAccounts();
  };
  const verify = async (account: AccountSummary) => {
    if (demo) return;
    setBusyKey(`${account.id}:verify`);
    const response = await action.run(() =>
      send(`/api/accounts/${encodeURIComponent(account.id)}/verify`),
    );
    if (response) {
      notify(`${account.name} 连接验证完成。`);
      refresh();
    }
    setBusyKey("");
  };
  const sync = async (account: AccountSummary) => {
    if (demo) return;
    setBusyKey(`${account.id}:sync`);
    const response = await action.run(() =>
      send<{ job: JobSummary }>(`/api/accounts/${encodeURIComponent(account.id)}/sync`),
    );
    if (response) {
      notify(`${account.name} 的资源同步已加入任务。`, taskHref(response.job.id));
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
  return (
    <>
      <PageHeader title="账号" description="管理 OCI 连接凭据与区域同步范围。">
        <Button onClick={refresh} loading={resource.refreshing}>
          <RefreshCw size={15} />
          刷新
        </Button>
        <Button variant="primary" disabled={demo} onClick={() => setEditing(null)}>
          <Plus size={16} />
          添加账号
        </Button>
      </PageHeader>
      <div className="stack">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        {action.error && !removing && <ErrorState message={action.error} />}
        {resource.loading ? (
          <LoadingState />
        ) : resource.data?.accounts.length ? (
          <div className="grid-3">
            {resource.data.accounts.map((account) => (
              <Card key={account.id} className="account-card">
                <div className="account-heading">
                  <span className="resource-icon">
                    <KeyRound size={20} />
                  </span>
                  <div className="grow">
                    <h2>{account.name}</h2>
                    <p className="muted small">{regionName(account.homeRegion)} · 主区域</p>
                  </div>
                  <Status value={account.status} />
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
                      <Badge key={region}>{regionName(region)}</Badge>
                    ))}
                  </div>
                  <span>最近同步 {formatDate(account.lastSyncAt, true)}</span>
                </div>
                {account.lastError && <Alert tone="error">{account.lastError}</Alert>}
                <div className="account-actions">
                  <Button
                    className="button-sm"
                    disabled={demo || action.pending}
                    loading={busyKey === `${account.id}:verify`}
                    onClick={() => verify(account)}
                  >
                    <CheckCircle2 size={13} />
                    验证
                  </Button>
                  <Button
                    className="button-sm"
                    disabled={demo || action.pending}
                    loading={busyKey === `${account.id}:sync`}
                    onClick={() => sync(account)}
                  >
                    <RefreshCw size={13} />
                    同步
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
                    disabled={demo}
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
            ))}
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
    </>
  );
}
