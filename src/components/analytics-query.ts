"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "./api";

/** Analytics are fetched on demand, never on a recurring polling timer. */
export function useAnalytics<T>(url: string | null) {
  const [result, setResult] = useState<{ url: string; data: T }>();
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const runner = useRef<(force: boolean) => Promise<void>>(async () => {});
  const refresh = useCallback(() => runner.current(true), []);
  const retry = useCallback(() => runner.current(false), []);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | undefined;
    let pending: Promise<void> | null = null;
    let pendingForce = false;
    setFailure(null);
    if (!url) {
      setRefreshing(false);
      runner.current = async () => {};
      return;
    }
    const run = (force: boolean): Promise<void> => {
      if (disposed) return Promise.resolve();
      // A manual refresh must still force a new read after a pending cache GET.
      if (pending) return force && !pendingForce ? pending.then(() => run(true)) : pending;
      pendingForce = force;
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      setRefreshing(true);
      setFailure(null);
      pending = api<T>(url, {
        method: force ? "POST" : "GET",
        signal,
        cache: "no-store",
      })
        .then((data) => {
          if (!disposed) setResult({ url, data });
        })
        .catch((reason) => {
          if (disposed) return;
          if (reason instanceof ApiError && reason.status === 401) {
            window.location.assign("/login");
            return;
          }
          setFailure({
            url,
            message: signal.aborted
              ? "查询用时较长，请稍后重试。已显示的数据会继续保留。"
              : errorMessage(reason),
          });
        })
        .finally(() => {
          pending = null;
          if (!disposed) setRefreshing(false);
        });
      return pending;
    };
    runner.current = run;
    void run(false);
    return () => {
      disposed = true;
      controller?.abort();
      if (runner.current === run) runner.current = async () => {};
    };
  }, [url]);

  const data = result?.url === url ? result.data : undefined;
  const error = failure?.url === url ? failure.message : null;
  return { data, error, refreshing, loading: Boolean(url) && !data && !error, refresh, retry };
}
