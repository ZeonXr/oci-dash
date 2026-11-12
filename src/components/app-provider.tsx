"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { AccountSummary, SessionUser } from "@/lib/contracts";
import { api, ApiError, errorMessage, send, useResource } from "./api";
import { ErrorState, LoadingState } from "./ui";
import { Toaster } from "./ui/sonner";
interface AppContextValue {
  user: SessionUser;
  accounts: AccountSummary[];
  accountsLoading: boolean;
  accountsReady: boolean;
  accountsError: string | null;
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
  const [session, setSession] = useState<{ user: SessionUser } | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [theme, setThemeState] = useState<"light" | "dark">("light");
  const accounts = useResource<{ accounts: AccountSummary[] }>(
    session ? "/api/accounts" : null,
    30000,
  );
  const reloadSession = useCallback(() => setRevision((n) => n + 1), []);
  useEffect(() => {
    let value: "light" | "dark" = "light";
    try {
      const saved = localStorage.getItem("oci-dash-theme");
      value = saved === "dark" ? "dark" : "light";
    } catch {
      // The theme still works for this visit when browser storage is unavailable.
    }
    setThemeState(value);
    document.documentElement.dataset.theme = value;
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setAuthError(null);
    api<{ user: SessionUser }>("/api/auth/me", { signal: controller.signal })
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
    (message: string, href?: string) => {
      toast(
        message,
        href ? { action: { label: "查看详情", onClick: () => router.push(href) } } : undefined,
      );
    },
    [router],
  );
  useEffect(
    () => () => {
      toast.dismiss();
    },
    [],
  );
  const setTheme = (value: "light" | "dark") => {
    setThemeState(value);
    document.documentElement.dataset.theme = value;
    try {
      localStorage.setItem("oci-dash-theme", value);
    } catch {
      // Persisting this preference is optional.
    }
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
      <main className="flex min-h-dvh items-center justify-center p-6">
        {authError ? (
          <div className="grid w-full max-w-lg gap-4">
            <ErrorState message={authError} retry={reloadSession} />
            <Link href="/login" className="text-sm text-primary hover:underline">
              返回登录
            </Link>
          </div>
        ) : (
          <LoadingState label="正在加载…" />
        )}
      </main>
    );
  return (
    <AppContext.Provider
      value={{
        ...session,
        accounts: accounts.data?.accounts || [],
        accountsLoading: accounts.loading,
        accountsReady: accounts.data !== undefined,
        accountsError: accounts.error,
        reloadAccounts: accounts.reload,
        reloadSession,
        notify,
        theme,
        setTheme,
        logout,
      }}
    >
      {children}
      <Toaster theme={theme} closeButton />
    </AppContext.Provider>
  );
}
