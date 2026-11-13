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
interface ResourceRead {
  promise: Promise<unknown>;
  controller: AbortController;
  subscribers: number;
  settled: boolean;
}
const reads = new Map<string, ResourceRead>();
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
      "/api/auth/setup",
      "/api/auth/logout",
      "/api/settings/password",
      "/api/settings/mfa/confirm",
      "/api/settings/mfa/disable",
    ].includes(url)
  ) {
    // A new login must never subscribe to an earlier login's pending request.
    const previous = [...reads.values()];
    reads.clear();
    for (const read of previous) read.controller.abort();
  }
  return body as T;
}
export const send = <T>(url: string, body: unknown = {}, method = "POST") =>
  api<T>(url, { method, body: JSON.stringify(body) });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请稍后重试。";

/** Share pending reads; abort only when the last consumer leaves and retain no completed response. */
export function readResource<T>(url: string) {
  let read = reads.get(url);
  if (!read) {
    const controller = new AbortController();
    const created: ResourceRead = {
      controller,
      subscribers: 0,
      settled: false,
      promise: api<unknown>(url, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
        cache: "no-store",
      })
        .then((value) => {
          controller.signal.throwIfAborted();
          return value;
        })
        .finally(() => {
          created.settled = true;
          if (reads.get(url) === created) reads.delete(url);
        }),
    };
    void created.promise.catch(() => undefined);
    reads.set(url, created);
    read = created;
  }
  const entry = read;
  entry.subscribers++;
  let released = false;
  return {
    promise: entry.promise as Promise<T>,
    signal: entry.controller.signal,
    release() {
      if (released) return;
      released = true;
      entry.subscribers--;
      if (!entry.subscribers && !entry.settled) {
        if (reads.get(url) === entry) reads.delete(url);
        entry.controller.abort();
      }
    },
  };
}

/** Keep rows during refresh; polling never aborts a slow read or changes page/filter state. */
export function useResource<T>(url: string | null, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const lastUrl = useRef(url);
  const loader = useRef<() => Promise<void>>(async () => {});
  const poller = useRef<() => Promise<void>>(async () => {});
  const reload = useCallback(() => loader.current(), []);
  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | null = null;
    let releaseRead: (() => void) | undefined;
    let lastStarted = 0;
    if (lastUrl.current !== url) {
      setData(undefined);
      setError(null);
      setUpdatedAt(null);
      setLoading(Boolean(url));
      lastUrl.current = url;
    }
    if (!url) {
      setLoading(false);
      setRefreshing(false);
      loader.current = async () => {};
      poller.current = async () => {};
      return;
    }
    const run = (): Promise<void> => {
      if (disposed) return Promise.resolve();
      if (pending) return pending;
      lastStarted = Date.now();
      setRefreshing(true);
      const read = readResource<T>(url);
      releaseRead = read.release;
      pending = read.promise
        .then((value) => {
          if (disposed || read.signal.aborted) return;
          setData(value);
          setError(null);
          setUpdatedAt(new Date().toISOString());
        })
        .catch((reason) => {
          if (disposed || read.signal.aborted) return;
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
          read.release();
          if (releaseRead === read.release) releaseRead = undefined;
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
      const current = pending ?? reads.get(url)?.promise;
      return current ? current.catch(() => undefined).then(run) : run();
    };
    loader.current = refresh;
    poller.current = run;
    const visible = () => document.visibilityState === "visible";
    const resume = () => {
      if (visible() && Date.now() - lastStarted >= 1000) void run();
    };
    if (visible()) void run();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true;
      releaseRead?.();
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      if (loader.current === refresh) loader.current = async () => {};
      if (poller.current === run) poller.current = async () => {};
    };
  }, [url]);
  // Changing the polling cadence must not dispose the URL loader, reset its
  // in-flight guard, or issue a new GET (especially when a task just completed).
  useEffect(() => {
    if (!url || !pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void poller.current();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [url, pollMs]);
  const currentData = lastUrl.current === url ? data : undefined;
  return {
    data: currentData,
    error: lastUrl.current === url ? error : null,
    loading: Boolean(url) && (lastUrl.current !== url || loading) && currentData === undefined,
    refreshing,
    updatedAt: lastUrl.current === url ? updatedAt : null,
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
