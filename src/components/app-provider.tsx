"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, X } from "lucide-react";
import type { AccountSummary, SessionUser } from "@/lib/contracts";
import { api, ApiError, errorMessage, send, useResource } from "./api";
import { Button, ErrorState, IconButton, LoadingState } from "./ui";

interface Toast {
  id: string;
  message: string;
  href?: string;
}
interface AppContextValue {
  user: SessionUser;
  demo: boolean;
  accounts: AccountSummary[];
  accountsLoading: boolean;
  reloadAccounts: () => void;
  reloadSession: () => void;
  notify: (message: string, href?: string) => void;
  theme: "light" | "dark";
  setTheme: (theme: "light" | "dark") => void;
  logout: () => Promise<void>;
}
const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw Error("AppProvider is required");
  return context;
}
export function AppProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<{ user: SessionUser; demo: boolean } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setThemeState] = useState<"light" | "dark">("light");
  const accounts = useResource<{ accounts: AccountSummary[]; demo: boolean }>(
    session ? "/api/accounts" : null,
    30000,
  );
  const reloadSession = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    const saved = localStorage.getItem("oci-dash-theme");
    const value = saved === "dark" ? "dark" : "light";
    setThemeState(value);
    document.documentElement.dataset.theme = value;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setAuthError(null);
    api<{ user: SessionUser; demo: boolean }>("/api/auth/me", { signal: controller.signal })
      .then((data) => {
        if (!data.user) {
          router.replace("/login");
          return;
        }
        setSession(data);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof ApiError && error.status === 401) router.replace("/login");
        else setAuthError(errorMessage(error));
      });
    return () => controller.abort();
  }, [revision, router]);
  const notify = useCallback(
    (message: string, href?: string) =>
      setToasts((items) => [...items.slice(-3), { id: crypto.randomUUID(), message, href }]),
    [],
  );
  useEffect(() => {
    if (!toasts.length) return;
    const t = window.setTimeout(() => setToasts((items) => items.slice(1)), 6000);
    return () => window.clearTimeout(t);
  }, [toasts]);
  const setTheme = (value: "light" | "dark") => {
    setThemeState(value);
    document.documentElement.dataset.theme = value;
    localStorage.setItem("oci-dash-theme", value);
  };
  const logout = async () => {
    try {
      await send("/api/auth/logout");
      router.replace("/login");
      router.refresh();
    } catch (error) {
      notify(errorMessage(error));
    }
  };
  if (!session)
    return (
      <main className="auth-loading">
        {authError ? (
          <div className="auth-error">
            <ErrorState message={authError} retry={reloadSession} />
            <Link href="/login" className="text-link">
              返回登录
            </Link>
          </div>
        ) : (
          <LoadingState label="正在打开工作区…" />
        )}
      </main>
    );
  return (
    <AppContext.Provider
      value={{
        ...session,
        accounts: accounts.data?.accounts || [],
        accountsLoading: accounts.loading,
        reloadAccounts: accounts.reload,
        reloadSession,
        notify,
        theme,
        setTheme,
        logout,
      }}
    >
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="toast">
            <CheckCircle2 size={19} />
            <div>
              {toast.message}
              {toast.href && <Link href={toast.href}>查看详情 →</Link>}
            </div>
            <IconButton
              label="关闭提示"
              onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}
            >
              <X size={15} />
            </IconButton>
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
