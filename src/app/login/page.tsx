"use client";
import { useEffect, useRef, useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Layers3, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import type { SessionUser } from "@/lib/contracts";
import { generatePassword } from "@/lib/password-generator";
import { api, ApiError, errorMessage, send } from "@/components/api";
import { Alert, Button, ErrorState, Field, IconButton, LoadingState } from "@/components/ui";
import "./login.css";

type AuthMode = "loading" | "error" | "setup" | "login";

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
    <main className="login-screen">
      <section className="login-aside" aria-label="OCI Dash">
        <div className="brand">
          <img className="brand-symbol" src="/oci-logo.png" alt="" width={32} height={32} />
          <span>OCI Dash</span>
        </div>
        <h1>
          你的云资源，
          <br />
          清晰掌握。
        </h1>
        <p>连接你的账号，集中管理每一项云资源。</p>
        <div className="login-feature">
          <Layers3 size={18} />
          <span>统一查看多个账号与区域</span>
        </div>
        <div className="login-feature">
          <ShieldCheck size={18} />
          <span>精确操作资源，完整追踪结果</span>
        </div>
        <div className="login-decoration" aria-hidden="true">
          <div>
            <Server color="#3271d7" size={25} />
            <section>
              <span />
              <small />
            </section>
          </div>
          <div>
            <Server color="#58baa7" size={25} />
            <section>
              <span />
              <small />
            </section>
          </div>
        </div>
      </section>
      <section className="login-panel">
        {mode === "loading" || mode === "error" ? (
          <div className="login-form login-status">
            <h2>OCI Dash</h2>
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
          <form className="login-form" onSubmit={submit} noValidate aria-labelledby="login-heading">
            <h2 id="login-heading">{setup ? "创建管理员" : "欢迎回来"}</h2>
            <p>{setup ? "首次使用，请设置管理员账号与登录密码。" : "登录 OCI Dash 管理面板。"}</p>
            <Field label="用户名" required>
              <input
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
              <div className="password-field">
                <input
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
                <div className="setup-password-tools">
                  <span id="setup-password-hint">12–256 个字符，也可生成 32 位随机密码。</span>
                  <Button
                    type="button"
                    onClick={generateAndCopy}
                    loading={generating}
                    disabled={pending}
                  >
                    生成并复制
                  </Button>
                </div>
                <Field label="确认密码" required>
                  <div className="password-field">
                    <input
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
                      label={showConfirmation ? "隐藏确认密码" : "显示确认密码"}
                      disabled={disabled}
                      onClick={() => setShowConfirmation(!showConfirmation)}
                    >
                      {showConfirmation ? <EyeOff size={16} /> : <Eye size={16} />}
                    </IconButton>
                  </div>
                </Field>
                {copyState && (
                  <div className="login-feedback">
                    <Alert tone={copyState === "copied" ? "success" : "warning"}>
                      {copyState === "copied"
                        ? "密码已生成并复制，请保存到密码管理器。"
                        : "密码已填入两处，但无法复制到剪贴板。可显示并选中密码后手动复制。"}
                      {copyState === "failed" && (
                        <Button
                          type="button"
                          className="setup-manual-copy"
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
                <input
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
              <div className="login-feedback">
                <Alert tone="error">{error}</Alert>
              </div>
            )}
            <Button type="submit" variant="primary" loading={pending} disabled={generating}>
              {setup ? "创建管理员" : mfa ? "验证并登录" : "登录"}
            </Button>
            <div className="login-note">
              <LockKeyhole size={12} /> 仅供授权管理员访问
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
