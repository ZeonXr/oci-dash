"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Layers3, LockKeyhole, Server, ShieldCheck } from "lucide-react";
import type { SessionUser } from "@/lib/contracts";
import { api, ApiError, errorMessage, send } from "@/components/api";
import { Alert, Button, Field, IconButton } from "@/components/ui";
export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api<{ user: SessionUser | null }>("/api/auth/me", { signal: controller.signal })
      .then((response) => {
        if (response.user) router.replace("/overview");
      })
      .catch(() => {});
    return () => controller.abort();
  }, [router]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await send("/api/auth/login", {
        username: username.trim(),
        password,
        ...(code ? { code: code.trim() } : {}),
      });
      setPassword("");
      setCode("");
      router.replace("/overview");
      router.refresh();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "MFA_REQUIRED") setMfa(true);
      else setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };
  return (
    <main className="login-screen">
      <section className="login-aside" aria-label="OCI Dash">
        <div className="brand">
          <span className="brand-symbol">
            <Server size={21} />
          </span>
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
        <form className="login-form" onSubmit={submit}>
          <h2>欢迎回来</h2>
          <p>登录 OCI Dash 管理面板。</p>
          <Field label="用户名" required>
            <input
              autoFocus
              autoComplete="username"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="管理员用户名"
              disabled={pending}
            />
          </Field>
          <Field label="密码" required>
            <div className="password-field">
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="输入密码"
                disabled={pending}
              />
              <IconButton
                label={showPassword ? "隐藏密码" : "显示密码"}
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </IconButton>
            </div>
          </Field>
          {mfa && (
            <Field label="双重验证" required hint="输入验证器中的 6 位验证码，或使用一条恢复码。">
              <input
                autoFocus
                required
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="验证码或恢复码"
                disabled={pending}
              />
            </Field>
          )}
          {error && (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="error">{error}</Alert>
            </div>
          )}
          <Button type="submit" variant="primary" loading={pending}>
            {mfa ? "验证并登录" : "登录"}
          </Button>
          <div className="login-note">
            <LockKeyhole size={12} /> 仅供授权管理员访问
          </div>
        </form>
      </section>
    </main>
  );
}
