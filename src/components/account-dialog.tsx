"use client";

import { useMemo, useState, type SubmitEvent } from "react";
import { Upload } from "lucide-react";
import type { AccountSummary, JobSummary } from "@/lib/contracts";
import { parseOciConfig } from "@/lib/oci-config";
import { send, useAction } from "./api";
import { useApp } from "./app-provider";
import { regionName, taskHref } from "./format";
import { Button, ErrorState, Field, Modal } from "./ui";

function suggestedName(file: File | null): string {
  return (file?.name ?? "")
    .replace(/\.(pem|key|txt)$/i, "")
    .replace(/[-_]\d{4}-\d{2}-\d{2}T.*$/, "")
    .trim()
    .slice(0, 80);
}

export function AccountDialog({
  account,
  onClose,
  onSaved,
}: {
  account?: AccountSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify } = useApp();
  const action = useAction();
  const [replaceCredentials, setReplaceCredentials] = useState(!account);
  const [recoverConsoleCleanup, setRecoverConsoleCleanup] = useState(false);
  const [configText, setConfigText] = useState("");
  const [keyFile, setKeyFile] = useState<File | null>(null);
  const [name, setName] = useState(account?.name ?? "");
  const [regions, setRegions] = useState(account?.regions.join("\n") ?? "");
  const parsedConfig = useMemo(() => {
    try {
      return parseOciConfig(configText);
    } catch {
      return null;
    }
  }, [configText]);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await action.run(async () => {
      const selectedRegions = regions.split(/[\s,，;；]+/).filter(Boolean);
      let body: Record<string, unknown>;
      if (account && !replaceCredentials) {
        body = {
          name: name.trim(),
          regions: [...new Set([account.homeRegion, ...selectedRegions])],
        };
      } else {
        const { profileName: _profile, ...config } = parseOciConfig(configText);
        if (!keyFile) throw new Error("请选择 API 私钥文件。");
        if (keyFile.size > 32768) throw new Error("私钥文件不能超过 32 KiB。");
        let privateKey: string;
        try {
          privateKey = (await keyFile.text()).trim();
        } catch {
          throw new Error("无法读取私钥文件，请重新选择。");
        }
        if (!/^-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(privateKey)) {
          throw new Error("请选择 PEM 格式的 OCI RSA API 私钥文件。");
        }
        body = {
          ...config,
          name:
            name.trim() || account?.name || suggestedName(keyFile) || `OCI-${config.homeRegion}`,
          regions: [...new Set([config.homeRegion, ...selectedRegions])],
          privateKey,
          ...(account && recoverConsoleCleanup
            ? {
                recoverConsoleCleanup: true,
                homeRegion: account.homeRegion,
                regions: account.regions,
              }
            : {}),
        };
      }
      return send<{ account: AccountSummary; job?: JobSummary; consoleCleanupRecovery?: boolean }>(
        account ? `/api/accounts/${encodeURIComponent(account.id)}` : "/api/accounts",
        body,
        account ? "PATCH" : "POST",
      );
    });
    if (response) {
      setKeyFile(null);
      setConfigText("");
      notify(
        response.consoleCleanupRecovery
          ? "恢复凭据已保存，后台将继续清理控制台。清理完成后请再连接并同步账号。"
          : account
            ? response.job
              ? "配置已保存，正在重新连接并同步资源。"
              : "账号配置已保存。"
            : "账号已添加，正在连接并同步资源。",
        response.job ? taskHref(response.job.id) : undefined,
      );
      onSaved();
      onClose();
    }
  };

  const nameField = (
    <Field label={account ? "账号名称" : "账号名称（选填）"} required={!!account}>
      <input
        autoFocus={!!account}
        required={!!account}
        maxLength={80}
        value={name}
        disabled={action.pending}
        onChange={(event) => setName(event.target.value)}
        placeholder={suggestedName(keyFile) || "留空时使用密钥文件名"}
      />
    </Field>
  );
  const regionsField = (
    <Field label="同步区域" hint="多个区域用逗号或换行分隔。配置中的区域始终包含在同步范围中。">
      <textarea
        className="mono"
        rows={2}
        value={recoverConsoleCleanup ? (account?.regions.join("\n") ?? regions) : regions}
        disabled={action.pending || recoverConsoleCleanup}
        onChange={(event) => setRegions(event.target.value)}
        placeholder={parsedConfig?.homeRegion || account?.homeRegion || "留空时仅同步配置中的区域"}
      />
    </Field>
  );

  return (
    <Modal
      open
      title={account ? "编辑账号" : "添加 OCI 账号"}
      description={
        account
          ? "修改名称、同步区域，或替换连接凭据。"
          : "粘贴 OCI 配置，并选择对应的 PEM 私钥文件。"
      }
      busy={action.pending}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button form="account-form" type="submit" variant="primary" loading={action.pending}>
            {account ? "保存更改" : "添加账号"}
          </Button>
        </>
      }
    >
      <form id="account-form" onSubmit={submit} className="stack">
        {account && (
          <>
            {nameField}
            {regionsField}
          </>
        )}
        {account && (
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={replaceCredentials}
              disabled={action.pending}
              onChange={(event) => {
                setReplaceCredentials(event.target.checked);
                if (!event.target.checked) setRecoverConsoleCleanup(false);
                action.clearError();
              }}
            />
            替换连接凭据
          </label>
        )}
        {replaceCredentials && (
          <>
            {account && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={recoverConsoleCleanup}
                  disabled={action.pending}
                  onChange={(event) => {
                    setRecoverConsoleCleanup(event.target.checked);
                    action.clearError();
                  }}
                />
                恢复控制台清理（旧 API 密钥已失效）
              </label>
            )}
            {account && recoverConsoleCleanup && (
              <p className="muted">
                先断开控制台并等待清理请求结束。仅可上传同一租户、同一用户的新密钥，区域保持原值；控制台占用会在验证清理成功后解除。
              </p>
            )}
            <Field
              label="OCI 配置文本"
              required
              hint={
                parsedConfig
                  ? `已识别区域：${regionName(parsedConfig.homeRegion)}（${parsedConfig.homeRegion}）`
                  : "直接粘贴 OCI 控制台生成的配置内容。"
              }
            >
              <textarea
                className="mono"
                autoFocus={!account}
                required
                rows={7}
                maxLength={16384}
                value={configText}
                disabled={action.pending}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setConfigText(event.target.value);
                  action.clearError();
                }}
                placeholder={
                  "[DEFAULT]\nuser=ocid1.user...\nfingerprint=aa:bb:cc:...\ntenancy=ocid1.tenancy...\nregion=ap-tokyo-1\nkey_file=<path to your private keyfile>"
                }
              />
            </Field>
            <Field label="API 私钥文件" required>
              <span className="file-upload">
                <Upload size={18} aria-hidden="true" />
                <input
                  type="file"
                  accept=".pem,.key,.txt"
                  required
                  disabled={action.pending}
                  onChange={(event) => {
                    setKeyFile(event.target.files?.[0] ?? null);
                    action.clearError();
                  }}
                />
              </span>
            </Field>
          </>
        )}
        {!account && (
          <details className="account-options">
            <summary>更多选项</summary>
            <div className="stack-sm">
              {nameField}
              {regionsField}
            </div>
          </details>
        )}
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
