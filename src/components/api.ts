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
  return body as T;
}
export const send = <T>(url: string, body: unknown = {}, method = "POST") =>
  api<T>(url, { method, body: JSON.stringify(body) });
export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "请求未完成，请稍后重试。";

/** Retain the last successful snapshot while refreshing and ignore superseded requests. */
export function useResource<T>(url: string | null, pollMs = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(url));
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const lastUrl = useRef(url);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!url) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (lastUrl.current !== url) {
      setData(undefined);
      setLoading(true);
      lastUrl.current = url;
    }
    const controller = new AbortController();
    const current = ++sequence.current;
    setRefreshing(true);
    api<T>(url, { signal: controller.signal })
      .then((value) => {
        if (current === sequence.current) {
          setData(value);
          setError(null);
        }
      })
      .catch((reason) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        if (reason instanceof ApiError && reason.status === 401 && !url.startsWith("/api/auth/")) {
          window.location.assign("/login");
          return;
        }
        setError(errorMessage(reason));
      })
      .finally(() => {
        if (current === sequence.current) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      controller.abort();
      sequence.current += 1;
    };
  }, [url, revision]);
  useEffect(() => {
    if (!url || !pollMs) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, pollMs);
    return () => window.clearInterval(timer);
  }, [url, pollMs, reload]);
  return { data, error, loading: loading && data === undefined, refreshing, reload, setData };
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
