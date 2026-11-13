"use client";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { Input } from "@/components/ui/input";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Layers3, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import type { SessionUser } from "@/lib/contracts";
import { generatePassword } from "@/lib/password-generator";
import { api, ApiError, errorMessage, send } from "@/components/api";
import { Alert, Button, ErrorState, Field, IconButton, LoadingState } from "@/components/ui";
import { Card, CardContent } from "@/components/ui/card";

type AuthMode = "loading" | "error" | "setup" | "login";

function LoginPreview({ secondary = false }: { secondary?: boolean }) {
  return (
    <Card className={secondary ? "ml-8" : undefined}>
      <CardContent className="flex items-center gap-4">
        <Server className={secondary ? "text-success" : "text-primary"} size={24} />
        <div className="flex flex-col gap-2">
          <span className="h-2 w-32 rounded-full bg-muted" />
          <span className="h-1.5 w-20 rounded-full bg-muted" />
        </div>
      </CardContent>
    </Card>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("loading");
  const [revision, setRevision] = useState(0);
  const [statusError, setStatusError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [pending, setPending] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [copyState, setCopyState] = useState<"copied" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const usernameInput = useRef<HTMLInputElement>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const confirmationInput = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const setup = mode === "setup";
  const disabled = pending || generating;

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
    api<{ setupRequired: boolean }>("/api/auth/status", { signal, cache: "no-store" })
      .then((response) => {
        if (controller.signal.aborted) return;
        if (typeof response.setupRequired !== "boolean") throw Error("无法确认管理员设置状态。");
        setMode(response.setupRequired ? "setup" : "login");
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setStatusError(errorMessage(reason));
        setMode("error");
      });
    api<{ user: SessionUser | null }>("/api/auth/me", { signal, cache: "no-store" })
      .then((response) => {
        if (!controller.signal.aborted && response.user) router.replace("/overview");
      })
      .catch(() => {});
    return () => controller.abort();
  }, [router, revision]);

  useEffect(() => {
    if (mode === "setup" || mode === "login") usernameInput.current?.focus();
  }, [mode]);

  const clearPasswords = () => {
    setPassword("");
    setConfirmation("");
    setCode("");
    setShowPassword(false);
    setShowConfirmation(false);
    setCopyState(null);
  };

  const generateAndCopy = async () => {
    if (busy.current || !setup) return;
    busy.current = true;
    setGenerating(true);
    setError(null);
    setCopyState(null);
    try {
      const generated = generatePassword();
      setPassword(generated);
      setConfirmation(generated);
      setShowPassword(false);
      setShowConfirmation(false);
      try {
        await navigator.clipboard.writeText(generated);
        setCopyState("copied");
      } catch {
        setCopyState("failed");
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      busy.current = false;
      setGenerating(false);
    }
  };

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || (mode !== "setup" && mode !== "login")) return;
    setError(null);
    if (!username.trim() || username.trim().length > 80) {
      setError("用户名长度须为 1–80 个字符。");
      usernameInput.current?.focus();
      return;
    }
    if (!password || (setup && (password.length < 12 || password.length > 256))) {
      setError(setup ? "密码长度须为 12–256 个字符。" : "请输入密码。");
      passwordInput.current?.focus();
      return;
    }
    if (setup && password !== confirmation) {
      setError("两次输入的密码不一致。");
      confirmationInput.current?.focus();
      return;
    }
    if (mfa && !code.trim()) {
      setError("请输入验证码或恢复码。");
      return;
    }
    busy.current = true;
    setPending(true);
    try {
      await send(setup ? "/api/auth/setup" : "/api/auth/login", {
        username: username.trim(),
        password,
        ...(!setup && code ? { code: code.trim() } : {}),
      });
      clearPasswords();
      router.replace("/overview");
      router.refresh();
    } catch (reason) {
      if (
        setup &&
        reason instanceof ApiError &&
        reason.status === 409 &&
        reason.code === "SETUP_ALREADY_COMPLETED"
      ) {
        clearPasswords();
        setMfa(false);
        setMode("login");
        setError("管理员已创建，请使用现有账号登录。");
      } else if (!setup && reason instanceof ApiError && reason.code === "MFA_REQUIRED") {
        setMfa(true);
      } else setError(errorMessage(reason));
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return (
    <main className="grid min-h-dvh min-w-0 bg-surface lg:grid-cols-2">
      <section
        className="relative hidden min-w-0 flex-col justify-center gap-6 bg-soft px-10 py-24 lg:flex xl:px-16"
        aria-label="OCI Dash"
      >
        <div className="brand absolute top-10 left-10 flex items-center gap-3 text-2xl font-semibold tracking-tight text-ink xl:left-16">
          <img
            className="size-8 shrink-0 object-contain"
            src="/oci-logo.png"
            alt=""
            width={32}
            height={32}
          />
          <span>OCI Dash</span>
        </div>
        <h1 className="max-w-lg text-4xl leading-snug font-semibold tracking-tight text-ink xl:text-5xl">
          你的云资源，
          <br />
          清晰掌握。
        </h1>
        <p className="max-w-sm text-muted-foreground">连接你的账号，集中管理每一项云资源。</p>
        <div className="flex flex-col gap-3 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <Layers3 className="text-primary" size={18} />
            <span>统一查看多个账号与区域</span>
          </div>
          <div className="flex items-center gap-3">
            <ShieldCheck className="text-primary" size={18} />
            <span>精确操作资源，完整追踪结果</span>
          </div>
        </div>
        <div className="mt-4 flex max-w-xs flex-col gap-3" aria-hidden="true">
          <LoginPreview />
          <LoginPreview secondary />
        </div>
      </section>
      <section className="login-panel flex min-h-dvh min-w-0 flex-col justify-center p-6 sm:p-8 lg:p-10">
        {mode === "loading" || mode === "error" ? (
          <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
            <h2 className="text-3xl font-semibold text-foreground">OCI Dash</h2>
            {mode === "loading" ? (
              <LoadingState label="正在检查登录状态…" />
            ) : (
              <ErrorState
                message={`无法检查登录状态：${statusError}`}
                retry={() => {
                  setMode("loading");
                  setRevision((value) => value + 1);
                }}
              />
            )}
          </div>
        ) : (
          <form
            className="mx-auto flex w-full max-w-sm flex-col gap-4"
            onSubmit={submit}
            noValidate
            aria-labelledby="login-heading"
          >
            <div className="mb-2 flex flex-col gap-2">
              <h2 id="login-heading" className="text-3xl font-semibold text-foreground">
                {setup ? "创建管理员" : "欢迎回来"}
              </h2>
              <p className="text-sm text-muted-foreground">
                {setup ? "首次使用，请设置管理员账号与登录密码。" : "登录 OCI Dash 管理面板。"}
              </p>
            </div>
            <Field label="用户名" required>
              <Input
                ref={usernameInput}
                aria-label="用户名"
                autoComplete="username"
                required
                maxLength={80}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="管理员用户名"
                disabled={disabled}
              />
            </Field>
            <Field label="密码" required>
              <div className="relative">
                <Input
                  className="pr-12"
                  ref={passwordInput}
                  aria-label="密码"
                  aria-describedby={setup ? "setup-password-hint" : undefined}
                  type={showPassword ? "text" : "password"}
                  autoComplete={setup ? "new-password" : "current-password"}
                  required
                  minLength={setup ? 12 : undefined}
                  maxLength={setup ? 256 : undefined}
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setCopyState(null);
                  }}
                  placeholder={setup ? "至少 12 个字符" : "输入密码"}
                  disabled={disabled}
                />
                <IconButton
                  className="absolute top-1/2 right-1 -translate-y-1/2"
                  label={showPassword ? "隐藏密码" : "显示密码"}
                  disabled={disabled}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </IconButton>
              </div>
            </Field>
            {setup && (
              <>
                <div className="-mt-2 flex flex-wrap items-center gap-3">
                  <span
                    id="setup-password-hint"
                    className="min-w-0 flex-1 basis-48 text-xs leading-relaxed text-muted-foreground"
                  >
                    12–256 个字符，也可生成 32 位随机密码。
                  </span>
                  <Button
                    className="shrink-0"
                    type="button"
                    onClick={generateAndCopy}
                    loading={generating}
                    disabled={pending}
                  >
                    生成并复制
                  </Button>
                </div>
                <Field label="确认密码" required>
                  <div className="relative">
                    <Input
                      className="pr-12"
                      ref={confirmationInput}
                      aria-label="确认密码"
                      type={showConfirmation ? "text" : "password"}
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={256}
                      value={confirmation}
                      onChange={(e) => {
                        setConfirmation(e.target.value);
                        setCopyState(null);
                      }}
                      placeholder="再次输入密码"
                      disabled={disabled}
                    />
                    <IconButton
                      className="absolute top-1/2 right-1 -translate-y-1/2"
                      label={showConfirmation ? "隐藏确认密码" : "显示确认密码"}
                      disabled={disabled}
                      onClick={() => setShowConfirmation(!showConfirmation)}
                    >
                      {showConfirmation ? <EyeOff size={16} /> : <Eye size={16} />}
                    </IconButton>
                  </div>
                </Field>
                {copyState && (
                  <div>
                    <Alert tone={copyState === "copied" ? "success" : "warning"}>
                      {copyState === "copied"
                        ? "密码已生成并复制，请保存到密码管理器。"
                        : "密码已填入两处，但无法复制到剪贴板。可显示并选中密码后手动复制。"}
                      {copyState === "failed" && (
                        <Button
                          type="button"
                          className="mt-2 flex"
                          disabled={disabled}
                          onClick={() => {
                            setShowPassword(true);
                            passwordInput.current?.focus();
                            passwordInput.current?.select();
                          }}
                        >
                          显示并选中密码
                        </Button>
                      )}
                    </Alert>
                  </div>
                )}
              </>
            )}
            {mfa && (
              <Field label="双重验证" required hint="输入验证器中的 6 位验证码，或使用一条恢复码。">
                <Input
                  autoFocus
                  required
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="验证码或恢复码"
                  disabled={disabled}
                />
              </Field>
            )}
            {error && (
              <div>
                <Alert tone="error">{error}</Alert>
              </div>
            )}
            <Button
              className="w-full"
              type="submit"
              variant="default"
              loading={pending}
              disabled={generating}
            >
              {setup ? "创建管理员" : mfa ? "验证并登录" : "登录"}
            </Button>
            <div className="mt-2 flex items-center justify-center gap-2 text-center text-xs text-muted-foreground">
              <LockKeyhole size={12} /> 仅供授权管理员访问
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
