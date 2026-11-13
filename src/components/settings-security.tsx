"use client";
import { useId, useState, type SubmitEvent } from "react";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useRouter } from "next/navigation";
import { KeyRound, LockKeyhole, ShieldCheck } from "lucide-react";
import { useApp } from "@/components/app-provider";
import { send, useAction, useResource } from "@/components/api";
import {
  Badge,
  Button,
  Card,
  CopyButton,
  ErrorState,
  Field,
  LoadingState,
  Modal,
} from "@/components/ui";
import type { SettingsResult } from "@/lib/settings-contracts";
import { SettingsSection } from "./settings-section";
interface MfaSetup {
  secret: string;
  uri: string;
  qrDataUrl: string;
}
export function SettingsSecurity() {
  const recoverySavedId = useId();
  const router = useRouter();
  const { notify, reloadSession } = useApp();
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
  const changePassword = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (newPassword !== repeat) return;
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
  const prepareMfa = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await action.run(() => send<MfaSetup>("/api/settings/mfa/setup", { password }));
    if (result) {
      setSetup(result);
      setPassword("");
    }
  };
  const confirmMfa = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
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
  const disableMfa = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
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
      <div className="flex flex-col gap-5">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        <SettingsSection title="登录安全" description="保护管理员账号和 OCI 账号凭据。">
          <Card>
            <div className="flex items-center gap-3 border-b border-border py-3.5 last:border-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground">
                <KeyRound size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <strong>管理员账号</strong>
                <p className="text-muted-foreground text-xs">{settings.username}</p>
              </div>
              <Badge>管理员</Badge>
            </div>
            <div className="flex items-center gap-3 border-b border-border py-3.5 last:border-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground">
                <LockKeyhole size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <strong>登录密码</strong>
                <p className="text-muted-foreground text-xs">修改后需要重新登录。</p>
              </div>
              <Button onClick={() => open("password")}>修改密码</Button>
            </div>
            <div className="flex items-center gap-3 border-b border-border py-3.5 last:border-0">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-canvas text-muted-foreground">
                <ShieldCheck size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <strong>双重验证 (MFA)</strong>
                <p className="text-muted-foreground text-xs">
                  {settings.mfaEnabled
                    ? "已启用验证器验证码保护。"
                    : "通过验证器应用增加一道登录验证。"}
                </p>
              </div>
              <Button onClick={() => open(settings.mfaEnabled ? "mfa-disable" : "mfa-setup")}>
                {settings.mfaEnabled ? "关闭" : "设置"}
              </Button>
            </div>
          </Card>
        </SettingsSection>
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
                disabled={newPassword !== repeat}
              >
                更新密码
              </Button>
            </>
          }
        >
          <form id="password-form" onSubmit={changePassword} className="flex flex-col gap-5">
            <Field label="当前密码" required>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="新密码" required hint="至少 12 个字符。">
              <Input
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
              <Input
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
              >
                {setup ? "开启双重验证" : "继续"}
              </Button>
            </>
          }
        >
          {setup ? (
            <form id="mfa-confirm-form" className="flex flex-col gap-5" onSubmit={confirmMfa}>
              {setup.qrDataUrl.startsWith("data:image/") && (
                <img
                  src={setup.qrDataUrl}
                  className="mx-auto block size-45 rounded-lg bg-white p-1"
                  alt="验证器绑定二维码"
                />
              )}
              <Field label="无法扫码时，手动输入密钥">
                <div className="flex items-center justify-between gap-2.5 overflow-auto rounded-lg border border-border bg-canvas px-4 py-3 [&_code]:wrap-anywhere">
                  <code>{setup.secret}</code>
                  <CopyButton value={setup.secret} />
                </div>
              </Field>
              <Field label="验证码" required>
                <Input
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
            <form id="mfa-setup-form" className="flex flex-col gap-5" onSubmit={prepareMfa}>
              <Field label="当前密码" required>
                <Input
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
          initialFocus="title"
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
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-2.5 rounded-lg bg-canvas p-4">
              {codes.map((value) => (
                <code key={value}>{value}</code>
              ))}
            </div>
            <div className="flex items-center gap-2.5">
              <CopyButton value={codes.join("\n")} label="复制全部恢复码" />
              <span className="text-xs text-muted-foreground">复制全部恢复码并妥善保存</span>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id={recoverySavedId}
                checked={saved}
                onCheckedChange={(checked) => setSaved(checked === true)}
              />
              <Label htmlFor={recoverySavedId}>我已保存这些恢复码</Label>
            </div>
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
              >
                关闭双重验证
              </Button>
            </>
          }
        >
          <form id="mfa-disable-form" className="flex flex-col gap-5" onSubmit={disableMfa}>
            <Field label="当前密码" required>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="验证码或恢复码" required>
              <Input
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
