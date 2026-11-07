"use client";

import { useEffect } from "react";
import { useAnalytics } from "./analytics-query";

/** Each chart follows its server cache lifetime; hidden tabs never poll OCI. */
export function useOverviewQuery<T extends { cacheExpiresAt: string }>(url: string | null) {
  const query = useAnalytics<T>(url);
  const { data, error, refreshing, retry } = query;
  useEffect(() => {
    if (!url || refreshing || (!data && !error)) return;
    const expiry = data ? Date.parse(data.cacheExpiresAt) : NaN;
    const now = Date.now();
    // An already-expired response can be caused by client/server clock skew.
    // Give the server time to renew its cache instead of retrying it every second.
    const due =
      error || !Number.isFinite(expiry)
        ? now + 60_000
        : Math.max(now + (expiry <= now ? 30_000 : 0), expiry);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible" || !navigator.onLine) return;
      timer = setTimeout(
        () => {
          if (document.visibilityState === "visible" && navigator.onLine) void retry();
        },
        Math.max(1000, due - Date.now()),
      );
    };
    document.addEventListener("visibilitychange", schedule);
    window.addEventListener("online", schedule);
    window.addEventListener("offline", schedule);
    schedule();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
      window.removeEventListener("online", schedule);
      window.removeEventListener("offline", schedule);
    };
  }, [url, data, error, refreshing, retry]);
  return query;
}
