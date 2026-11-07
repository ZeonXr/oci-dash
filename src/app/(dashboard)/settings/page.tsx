"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Check, KeyRound, LockKeyhole, Moon, ShieldCheck, Sun } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { send, useAction, useResource } from "@/components/api";
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorState,
  Field,
  LoadingState,
  Modal,
  PageHeader,
} from "@/components/ui";
import { formatDate } from "@/components/format";
interface SettingsResult {
  username: string;
  mfaEnabled: boolean;
  demo: boolean;
  version: string;
  worker: { alive: boolean; lastSeenAt: string | null; runningJobs: number };
}
interface MfaSetup {
  secret: string;
  uri: string;
  qrDataUrl: string;
}
export default function SettingsPage() {
  const router = useRouter();
  const { demo, theme, setTheme, notify, reloadSession } = useApp();
  const resource = useResource<SettingsResult>("/api/settings", 30000);
  const action = useAction();
  const [modal, setModal] = useState<"password" | "mfa-setup" | "mfa-disable" | "recovery" | null>(
    null,
  );
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const close = () => {
    setModal(null);
    setPassword("");
    setNewPassword("");
    setRepeat("");
    setCode("");
    setSetup(null);
    setCodes([]);
    setSaved(false);
    action.clearError();
  };
  const open = (value: "password" | "mfa-setup" | "mfa-disable") => {
    close();
    setModal(value);
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (demo || newPassword !== repeat) return;
    const result = await action.run(() =>
      send<{ ok: boolean; relogin: boolean }>("/api/settings/password", {
        currentPassword: password,
        newPassword,
      }),
    );
    if (result) {
      notify("密码已更新，请重新登录。");
      close();
      router.replace("/login");
      router.refresh();
    }
  };
  const prepareMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (demo) return;
    const result = await action.run(() => send<MfaSetup>("/api/settings/mfa/setup", { password }));
    if (result) {
      setSetup(result);
      setPassword("");
    }
  };
  const confirmMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (demo) return;
    const result = await action.run(() =>
      send<{ recoveryCodes: string[] }>("/api/settings/mfa/confirm", { code }),
    );
    if (result) {
      setCodes(result.recoveryCodes);
      setSetup(null);
      setCode("");
      setModal("recovery");
      resource.reload();
      reloadSession();
      notify("双重验证已开启，请保存恢复码。");
    }
  };
  const disableMfa = async (event: FormEvent) => {
    event.preventDefault();
    if (demo) return;
    const result = await action.run(() =>
      send<{ ok: boolean }>("/api/settings/mfa/disable", { password, code }),
    );
    if (result) {
      notify("双重验证已关闭。");
      close();
      resource.reload();
      reloadSession();
    }
  };
  if (resource.loading) return <LoadingState />;
  const settings = resource.data;
  if (!settings)
    return <ErrorState message={resource.error || "无法加载设置。"} retry={resource.reload} />;
  return (
    <>
      <PageHeader title="设置" description="管理工作区外观、登录安全与运行状态。" />
      <div className="stack">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        <div className="settings-section">
          <div className="settings-copy">
            <h2>外观</h2>
            <p>主题偏好保存在当前浏览器中。</p>
          </div>
          <Card>
            <div className="theme-options">
              <button
                className={`theme-option ${theme === "light" ? "selected" : ""}`}
                onClick={() => setTheme("light")}
                aria-pressed={theme === "light"}
              >
                <Sun size={25} />
                <span>
                  浅色{theme === "light" && <Check size={13} style={{ marginLeft: 8 }} />}
                </span>
              </button>
              <button
                className={`theme-option ${theme === "dark" ? "selected" : ""}`}
                onClick={() => setTheme("dark")}
                aria-pressed={theme === "dark"}
              >
                <Moon size={25} />
                <span>深色{theme === "dark" && <Check size={13} style={{ marginLeft: 8 }} />}</span>
              </button>
            </div>
          </Card>
        </div>
        <div className="settings-section">
          <div className="settings-copy">
            <h2>登录安全</h2>
            <p>保护管理员账号和工作区内的云连接。</p>
          </div>
          <Card>
            <div className="inline-resource">
              <span className="resource-icon">
                <KeyRound size={18} />
              </span>
              <div className="grow">
                <strong>管理员账号</strong>
                <p className="muted small">{settings.username}</p>
              </div>
              <Badge>管理员</Badge>
            </div>
            <div className="inline-resource">
              <span className="resource-icon">
                <LockKeyhole size={18} />
              </span>
              <div className="grow">
                <strong>登录密码</strong>
                <p className="muted small">修改后需要重新登录。</p>
              </div>
              <Button disabled={demo} onClick={() => open("password")}>
                修改密码
              </Button>
            </div>
            <div className="inline-resource">
              <span className="resource-icon">
                <ShieldCheck size={18} />
              </span>
              <div className="grow">
                <strong>双重验证 (MFA)</strong>
                <p className="muted small">
                  {settings.mfaEnabled
                    ? "已启用验证器验证码保护。"
                    : "通过验证器应用增加一道登录验证。"}
                </p>
              </div>
              <Button
                disabled={demo}
                onClick={() => open(settings.mfaEnabled ? "mfa-disable" : "mfa-setup")}
              >
                {settings.mfaEnabled ? "关闭" : "设置"}
              </Button>
            </div>
          </Card>
        </div>
        <div className="settings-section">
          <div className="settings-copy">
            <h2>运行状态</h2>
            <p>查看当前应用与后台任务执行器状态。</p>
          </div>
          <Card>
            <dl className="details-list">
              <dt>应用版本</dt>
              <dd>{settings.version}</dd>
              <dt>当前模式</dt>
              <dd>
                <Badge tone={demo ? "info" : "success"}>
                  {demo ? "演示模式 · 只读" : "正常模式"}
                </Badge>
              </dd>
              <dt>任务执行器</dt>
              <dd>
                <Badge tone={settings.worker.alive ? "success" : "warning"}>
                  {settings.worker.alive ? "运行正常" : "未收到心跳"}
                </Badge>
              </dd>
              <dt>最近心跳</dt>
              <dd>{formatDate(settings.worker.lastSeenAt, true)}</dd>
              <dt>执行中任务</dt>
              <dd>{settings.worker.runningJobs}</dd>
            </dl>
            {!settings.worker.alive && !demo && (
              <div style={{ marginTop: 18 }}>
                <Alert>后台执行器尚未连接，已排队的任务会等待执行器恢复。</Alert>
              </div>
            )}
          </Card>
        </div>
      </div>
      {modal === "password" && (
        <Modal
          open
          title="修改登录密码"
          description="保存后当前登录会话将失效。"
          busy={action.pending}
          onClose={close}
          footer={
            <>
              <Button disabled={action.pending} onClick={close}>
                取消
              </Button>
              <Button
                form="password-form"
                type="submit"
                variant="primary"
                loading={action.pending}
                disabled={demo || newPassword !== repeat}
              >
                更新密码
              </Button>
            </>
          }
        >
          <form id="password-form" onSubmit={changePassword} className="stack">
            <Field label="当前密码" required>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="新密码" required hint="至少 12 个字符。">
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                maxLength={128}
                required
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
              />
            </Field>
            <Field label="再次输入新密码" required>
              <input
                type="password"
                autoComplete="new-password"
                minLength={12}
                required
                value={repeat}
                onChange={(e) => setRepeat(e.target.value)}
              />
            </Field>
            {repeat && repeat !== newPassword && <ErrorState message="两次输入的新密码不一致。" />}
            {action.error && <ErrorState message={action.error} />}
          </form>
        </Modal>
      )}
      {modal === "mfa-setup" && (
        <Modal
          open
          title="设置双重验证"
          description={
            setup
              ? "使用验证器扫描二维码，然后输入验证码完成绑定。"
              : "输入当前密码以生成验证器设置。"
          }
          busy={action.pending}
          onClose={close}
          footer={
            <>
              <Button onClick={close} disabled={action.pending}>
                取消
              </Button>
              <Button
                form={setup ? "mfa-confirm-form" : "mfa-setup-form"}
                type="submit"
                variant="primary"
                loading={action.pending}
                disabled={demo}
              >
                {setup ? "开启双重验证" : "继续"}
              </Button>
            </>
          }
        >
          {setup ? (
            <form id="mfa-confirm-form" className="stack" onSubmit={confirmMfa}>
              {setup.qrDataUrl.startsWith("data:image/") && (
                <img src={setup.qrDataUrl} className="qr-code" alt="验证器绑定二维码" />
              )}
              <Field label="无法扫码时，手动输入密钥">
                <div className="code-block">
                  <code>{setup.secret}</code>
                  <CopyButton value={setup.secret} />
                </div>
              </Field>
              <Field label="验证码" required>
                <input
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  minLength={6}
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                  placeholder="6 位验证码"
                />
              </Field>
              {action.error && <ErrorState message={action.error} />}
            </form>
          ) : (
            <form id="mfa-setup-form" className="stack" onSubmit={prepareMfa}>
              <Field label="当前密码" required>
                <input
                  autoFocus
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              {action.error && <ErrorState message={action.error} />}
            </form>
          )}
        </Modal>
      )}
      {modal === "recovery" && (
        <Modal
          open
          busy={!saved}
          title="保存恢复码"
          description="无法使用验证器时，每条恢复码可以登录一次。此内容只显示一次。"
          onClose={() => {
            if (saved) close();
          }}
          footer={
            <Button variant="primary" disabled={!saved} onClick={close}>
              已保存，完成设置
            </Button>
          }
        >
          <div className="stack">
            <div className="recovery-codes">
              {codes.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
            <div className="row">
              <CopyButton value={codes.join("\n")} label="复制全部恢复码" />
              <span className="small muted">复制全部恢复码并妥善保存</span>
            </div>
            <label className="checkbox-field">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              我已保存这些恢复码
            </label>
          </div>
        </Modal>
      )}
      {modal === "mfa-disable" && (
        <Modal
          open
          title="关闭双重验证"
          description="验证当前密码和验证码后，登录将只需要密码。"
          busy={action.pending}
          onClose={close}
          footer={
            <>
              <Button onClick={close} disabled={action.pending}>
                取消
              </Button>
              <Button
                form="mfa-disable-form"
                type="submit"
                variant="danger"
                loading={action.pending}
                disabled={demo}
              >
                关闭双重验证
              </Button>
            </>
          }
        >
          <form id="mfa-disable-form" className="stack" onSubmit={disableMfa}>
            <Field label="当前密码" required>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="验证码或恢复码" required>
              <input
                autoComplete="one-time-code"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </Field>
            {action.error && <ErrorState message={action.error} />}
          </form>
        </Modal>
      )}
    </>
  );
}
