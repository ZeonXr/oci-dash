"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InventoryRefreshResult, JobSummary } from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
import { api, ApiError, errorMessage } from "./api";
import { useApp } from "./app-provider";

const isFinished = (job: JobSummary) => !isJobPending(job);

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

function whileVisible<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener("abort", stop);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (reason) => {
        signal.removeEventListener("abort", stop);
        reject(reason);
      },
    );
    if (signal.aborted) stop();
  });
}

const completionKey = (job: JobSummary) => JSON.stringify([job.state, job.attempt, job.finishedAt]);

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
  const snapshotRead = useRef<Promise<void> | null>(null);
  const refresh = useCallback(() => runner.current("manual"), []);

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let running: Promise<void> | null = null;
    let currentMode: "auto" | "manual" = "auto";
    let observedCloudJob = false;
    let lastCheck = 0;
    let automaticNotBefore = 0;
    // Keep unfinished observations across visibility changes; the refresh API may
    // omit a job that completed while the browser was not watching it.
    const tracked = new Map<string, JobSummary>();
    const published = new Map<string, string>();
    setRefreshing(false);
    setError(null);
    const selected = JSON.parse(scope) as string[] | null;
    const visible = () => document.visibilityState === "visible";
    const complete = async (signal: AbortSignal) => {
      while (snapshotRead.current) await whileVisible(snapshotRead.current, signal);
      if (disposed || signal.aborted || !visible()) return;
      const reading = Promise.all([updated.current(), updateAccounts.current()]).then(() => {});
      snapshotRead.current = reading;
      void reading
        .finally(() => {
          if (snapshotRead.current === reading) snapshotRead.current = null;
        })
        .catch(() => undefined);
      await whileVisible(reading, signal);
    };
    const run = (mode: "auto" | "manual"): Promise<void> => {
      if (disposed || !enabled || !visible()) return Promise.resolve();
      if (mode === "auto" && Date.now() < automaticNotBefore) return Promise.resolve();
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
          const jobs = new Map(tracked);
          for (const job of response.jobs) {
            jobs.set(job.id, job);
            if (isFinished(job) && published.get(job.id) === completionKey(job))
              tracked.delete(job.id);
            else tracked.set(job.id, job);
          }
          observedCloudJob = jobs.size > 0;
          const pending = () => [...jobs.values()].filter((job) => !isFinished(job));
          if (pending().length) setRefreshing(true);
          const deadline = Date.now() + 120_000;
          const budget = new AbortController();
          const waitTimer = setTimeout(() => budget.abort(), 120_000);
          const waiting = AbortSignal.any([operation.signal, budget.signal]);
          const active = () => !disposed && !waiting.aborted && visible();
          const pollErrors = new Map<string, string>();
          let publishError: string | null = null;
          let publishing: Promise<void> | null = null;
          const showErrors = () => {
            if (!active()) return;
            const failures = [...jobs.values()].filter(
              (job) => isFinished(job) && job.state !== "succeeded",
            );
            const messages = [
              ...failures.map((job) => `${job.accountName}：${job.lastError || "本次同步未完成"}`),
              ...pollErrors.values(),
              ...(publishError ? [publishError] : []),
            ];
            if (
              !messages.length &&
              response.accounts.some((account) => account.status === "backoff")
            )
              messages.push("部分账号上次同步失败，稍后自动重试；也可点击刷新立即重试。");
            setError(messages.length ? messages.join("；") : null);
          };
          const publishCompleted = (): Promise<void> => {
            if (publishing) return publishing;
            publishing = Promise.resolve()
              .then(async () => {
                while (active()) {
                  const completed = [...jobs.values()].filter(
                    (job) => isFinished(job) && published.get(job.id) !== completionKey(job),
                  );
                  if (!completed.length) return;
                  try {
                    await complete(waiting);
                  } catch (reason) {
                    if (active()) {
                      publishError = `资源快照刷新失败：${errorMessage(reason)}`;
                      showErrors();
                    }
                    return;
                  }
                  if (!active()) return;
                  for (const job of completed) {
                    published.set(job.id, completionKey(job));
                    if (tracked.get(job.id) && isFinished(tracked.get(job.id)!))
                      tracked.delete(job.id);
                  }
                  while (published.size > 512) published.delete(published.keys().next().value!);
                  publishError = null;
                  showErrors();
                }
              })
              .finally(() => {
                publishing = null;
              });
            return publishing;
          };
          const assertWaiting = () => {
            if (Date.now() >= deadline)
              throw new Error("资源同步仍在后台执行，稍后将自动更新。可在账号页查看进度。");
            waiting.throwIfAborted();
          };
          try {
            // Already-completed jobs are published immediately. Pending jobs get
            // their first status read now, without an unconditional initial delay.
            void publishCompleted();
            await Promise.all(
              pending().map(async (initial) => {
                let job = initial;
                while (!isFinished(job)) {
                  assertWaiting();
                  try {
                    const status = await api<{ job: JobSummary }>(
                      `/api/jobs/${encodeURIComponent(job.id)}`,
                      {
                        signal: AbortSignal.any([waiting, AbortSignal.timeout(15_000)]),
                        cache: "no-store",
                      },
                    );
                    if (!active()) return;
                    if (
                      !status.job ||
                      status.job.id !== job.id ||
                      status.job.accountId !== job.accountId
                    )
                      throw new Error("同步任务响应不完整，请重试");
                    job = status.job;
                    jobs.set(job.id, job);
                    tracked.set(job.id, job);
                    pollErrors.delete(job.id);
                    showErrors();
                    // Do not wait for another account's slow status response.
                    if (isFinished(job)) void publishCompleted();
                  } catch (reason) {
                    if (waiting.aborted || (reason instanceof ApiError && reason.status === 401))
                      throw reason;
                    pollErrors.set(job.id, `${job.accountName}：${errorMessage(reason)}`);
                    showErrors();
                  }
                  assertWaiting();
                  if (!isFinished(job)) await pause(Math.min(1000, deadline - Date.now()), waiting);
                }
              }),
            );
            if (!jobs.size && mode === "manual") await complete(waiting);
            else await publishCompleted();
            assertWaiting();
            showErrors();
          } catch (reason) {
            if (!operation.signal.aborted && Date.now() >= deadline) {
              // An interval due at this boundary must not immediately restart
              // waiting and erase the timeout notice. Manual refresh stays available.
              automaticNotBefore = Date.now() + 60_000;
              throw new Error("资源同步仍在后台执行，稍后将自动更新。可在账号页查看进度。");
            }
            throw reason;
          } finally {
            clearTimeout(waitTimer);
          }
        } catch (reason) {
          if (disposed || operation.signal.aborted) return;
          if (reason instanceof ApiError && reason.status === 401) {
            window.location.assign("/login");
            return;
          }
          setError(errorMessage(reason));
        } finally {
          operation.abort();
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
        automaticNotBefore = 0;
      } else if (Date.now() - lastCheck >= 1000) {
        if (running) {
          if (controller?.signal.aborted) void running.then(() => run("auto"));
        } else void run("auto");
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
