"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
const reads = new Map<string, Promise<unknown>>();
export async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(body.error || `请求失败 (${response.status})`, response.status, body.code);
  if (
    options.method === "POST" &&
    [
      "/api/auth/login",
      "/api/auth/logout",
      "/api/settings/password",
      "/api/settings/mfa/confirm",
      "/api/settings/mfa/disable",
    ].includes(url)
  ) {
    // A new login must never subscribe to an earlier login's pending request.
    reads.clear();
  }
  return body as T;
}
export const send = <T>(url: string, body: unknown = {}, method = "POST") =>
  api<T>(url, { method, body: JSON.stringify(body) });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请稍后重试。";

/** Coalesce concurrent reads across components; retain no response after completion. */
function readResource<T>(url: string): Promise<T> {
  let request = reads.get(url);
  if (!request) {
    request = api<T>(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
    reads.set(url, request);
    void request
      .finally(() => {
        if (reads.get(url) === request) reads.delete(url);
      })
      .catch(() => undefined);
  }
  return request as Promise<T>;
}

/** Keep rows during refresh; polling never aborts a slow read or changes page/filter state. */
export function useResource<T>(url: string | null, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [refreshing, setRefreshing] = useState(false);
  const lastUrl = useRef(url);
  const loader = useRef<() => Promise<void>>(async () => {});
  const reload = useCallback(() => loader.current(), []);
  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | null = null;
    let lastStarted = 0;
    if (lastUrl.current !== url) {
      setData(undefined);
      setError(null);
      setLoading(Boolean(url));
      lastUrl.current = url;
    }
    if (!url) {
      setLoading(false);
      setRefreshing(false);
      loader.current = async () => {};
      return;
    }
    const run = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      lastStarted = Date.now();
      setRefreshing(true);
      pending = readResource<T>(url)
        .then((value) => {
          if (disposed) return;
          setData(value);
          setError(null);
        })
        .catch((reason) => {
          if (disposed) return;
          if (
            reason instanceof ApiError &&
            reason.status === 401 &&
            !url.startsWith("/api/auth/")
          ) {
            window.location.assign("/login");
            return;
          }
          setError(errorMessage(reason));
        })
        .finally(() => {
          pending = null;
          if (!disposed) {
            setLoading(false);
            setRefreshing(false);
          }
        });
      return pending;
    };
    // A deliberate refresh after a mutation must read again even if an older GET is pending.
    const refresh = () => {
      const current = pending ?? reads.get(url);
      return current ? current.catch(() => undefined).then(run) : run();
    };
    loader.current = refresh;
    const visible = () => document.visibilityState === "visible";
    const resume = () => {
      if (visible() && Date.now() - lastStarted >= 1000) void run();
    };
    if (visible()) void run();
    const timer = pollMs
      ? window.setInterval(() => {
          if (visible()) void run();
        }, pollMs)
      : undefined;
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      if (loader.current === refresh) loader.current = async () => {};
    };
  }, [url, pollMs, reload]);
  const currentData = lastUrl.current === url ? data : undefined;
  return {
    data: currentData,
    error: lastUrl.current === url ? error : null,
    loading: Boolean(url) && (lastUrl.current !== url || loading) && currentData === undefined,
    refreshing,
    reload,
    setData,
  };
}
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const run = async <T>(action: () => Promise<T>): Promise<T | undefined> => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      return await action();
    } catch (reason) {
      setError(errorMessage(reason));
      return undefined;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  return { run, pending, error, clearError: () => setError(null) };
}
