"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InventoryRefreshResult, JobSummary } from "@/lib/contracts";
import { api, ApiError, errorMessage } from "./api";
import { useApp } from "./app-provider";

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);
const isFinished = (job: JobSummary) =>
  terminalStates.has(job.state) || (job.state === "interrupted" && !job.nextRunAt);

function pause(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}

/** Cloud refresh is explicit; ordinary GETs remain side-effect free. */
export function useInventoryRefresh({
  accountIds,
  onUpdated,
  enabled = true,
}: {
  accountIds?: string[];
  onUpdated: () => void | Promise<void>;
  enabled?: boolean;
}) {
  const { demo, reloadAccounts } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const updated = useRef(onUpdated);
  updated.current = onUpdated;
  const updateAccounts = useRef(reloadAccounts);
  updateAccounts.current = reloadAccounts;
  const scope = JSON.stringify(accountIds === undefined ? null : [...new Set(accountIds)].sort());
  const runner = useRef<(mode: "auto" | "manual") => Promise<void>>(async () => {});
  const refresh = useCallback(() => runner.current("manual"), []);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let running: Promise<void> | null = null;
    let currentMode: "auto" | "manual" = "auto";
    let observedCloudJob = false;
    let lastCheck = 0;
    setRefreshing(false);
    setError(null);
    const selected = JSON.parse(scope) as string[] | null;
    const visible = () => document.visibilityState === "visible";
    const complete = async () => {
      await Promise.all([updated.current(), updateAccounts.current()]);
    };
    const run = (mode: "auto" | "manual"): Promise<void> => {
      if (disposed || !enabled || !visible()) return Promise.resolve();
      if (running) {
        if (mode === "manual" && currentMode === "auto") {
          // A click during a freshness check must not be swallowed by an automatic cache hit.
          return running.then(() => (observedCloudJob ? undefined : run("manual")));
        }
        return running;
      }
      if (demo) return mode === "manual" ? Promise.resolve(updated.current()) : Promise.resolve();
      if (selected?.length === 0) return Promise.resolve(updated.current());
      const operation = new AbortController();
      controller = operation;
      currentMode = mode;
      observedCloudJob = false;
      lastCheck = Date.now();
      if (mode === "manual") setRefreshing(true);
      setError(null);
      running = (async () => {
        try {
          const response = await api<InventoryRefreshResult>("/api/inventory/refresh", {
            method: "POST",
            body: JSON.stringify({ mode, ...(selected ? { accountIds: selected } : {}) }),
            signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)]),
          });
          if (disposed || operation.signal.aborted) return;
          let jobs = response.jobs;
          observedCloudJob = jobs.length > 0;
          if (jobs.some((job) => !isFinished(job))) setRefreshing(true);
          const deadline = Date.now() + 120_000;
          while (jobs.some((job) => !isFinished(job))) {
            if (Date.now() >= deadline) {
              throw new Error("资源同步仍在后台执行，稍后将自动更新。可在账号页查看进度。");
            }
            await pause(2000, operation.signal);
            jobs = await Promise.all(
              jobs.map(async (job) => {
                if (isFinished(job)) return job;
                const status = await api<{ job: JobSummary }>(
                  `/api/jobs/${encodeURIComponent(job.id)}`,
                  {
                    signal: AbortSignal.any([operation.signal, AbortSignal.timeout(15_000)]),
                  },
                );
                return status.job;
              }),
            );
          }
          if (disposed || operation.signal.aborted) return;
          // Publish successful accounts even when another account's refresh failed.
          if (jobs.length || mode === "manual") await complete();
          if (disposed || operation.signal.aborted) return;
          const failures = jobs.filter((job) => job.state !== "succeeded");
          if (failures.length) {
            setError(
              failures
                .map((job) => `${job.accountName}：${job.lastError || "本次同步未完成"}`)
                .join("；"),
            );
          } else if (response.accounts.some((account) => account.status === "backoff")) {
            setError("部分账号上次同步失败，稍后自动重试；也可点击刷新立即重试。");
          }
        } catch (reason) {
          if (disposed || operation.signal.aborted) return;
          if (reason instanceof ApiError && reason.status === 401) {
            window.location.assign("/login");
            return;
          }
          setError(errorMessage(reason));
        } finally {
          if (controller === operation) controller = null;
          running = null;
          if (!disposed) setRefreshing(false);
        }
      })();
      return running;
    };
    runner.current = run;
    const resume = () => {
      if (!visible()) {
        // The durable job continues; only browser polling stops while this page is hidden.
        controller?.abort();
        lastCheck = 0;
      } else if (Date.now() - lastCheck >= 1000) {
        if (running) void running.then(() => run("auto"));
        else void run("auto");
      }
    };
    if (visible()) void run("auto");
    const timer = window.setInterval(() => {
      if (visible()) void run("auto");
    }, 60_000);
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      if (runner.current === run) runner.current = async () => {};
    };
  }, [demo, enabled, scope]);
  return { refresh, refreshing, error };
}
