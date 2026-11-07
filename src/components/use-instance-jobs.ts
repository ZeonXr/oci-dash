"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { JobSummary } from "@/lib/contracts";
import { isJobPending as isPending } from "@/lib/job-state";
import { api, ApiError, errorMessage } from "./api";

function synchronizationId(job: JobSummary): string | null {
  const sync = job.result?.synchronization;
  if (job.state !== "succeeded" || !sync || typeof sync !== "object") return null;
  const value = sync as { status?: unknown; jobId?: unknown };
  return value.status === "queued" &&
    typeof value.jobId === "string" &&
    value.jobId &&
    value.jobId.length <= 200 &&
    value.jobId !== job.id
    ? value.jobId
    : null;
}

/** Observe durable jobs only. This hook never submits cloud operations or sync mutations. */
export function useInstanceJobs(onUpdated: () => void | Promise<void>) {
  const known = useRef(new Map<string, JobSummary>());
  const watched = useRef(new Set<string>());
  const syncInstances = useRef(new Map<string, Set<string>>());
  const notified = useRef(new Set<string>());
  const dirty = useRef(0);
  const delivered = useRef(0);
  const refreshInstances = useRef(new Set<string>());
  const trackVersion = useRef(0);
  const trackedAt = useRef(new Map<string, number>());
  const updated = useRef(onUpdated);
  const runner = useRef<() => Promise<void>>(async () => {});
  const [snapshot, setSnapshot] = useState<{ jobs: JobSummary[]; busyInstanceIds: Set<string> }>({
    jobs: [],
    busyInstanceIds: new Set(),
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    updated.current = onUpdated;
  }, [onUpdated]);

  const publish = useCallback(() => {
    const jobs = [...known.current.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    );
    const busyInstanceIds = new Set(refreshInstances.current);
    for (const job of jobs)
      if (job.resourceId && isPending(job)) busyInstanceIds.add(job.resourceId);
    for (const [id, instances] of syncInstances.current) {
      const sync = known.current.get(id);
      if (!sync || isPending(sync)) for (const instance of instances) busyInstanceIds.add(instance);
    }
    setSnapshot({ jobs, busyInstanceIds });
  }, []);

  const accept = useCallback((job: JobSummary, explicit = false) => {
    const wasWatched = watched.current.has(job.id);
    known.current.set(job.id, job);
    if (isPending(job)) watched.current.add(job.id);
    else {
      watched.current.delete(job.id);
      if (wasWatched || explicit) {
        const completion = JSON.stringify([
          job.id,
          job.state,
          job.attempt,
          job.maxAttempts,
          job.finishedAt,
        ]);
        if (!notified.current.has(completion)) {
          notified.current.add(completion);
          dirty.current++;
          if (job.resourceId) refreshInstances.current.add(job.resourceId);
          for (const instance of syncInstances.current.get(job.id) ?? [])
            refreshInstances.current.add(instance);
        }
      }
    }
    const syncId = synchronizationId(job);
    if (syncId) {
      const instances = syncInstances.current.get(syncId) ?? new Set<string>();
      if (job.resourceId) instances.add(job.resourceId);
      syncInstances.current.set(syncId, instances);
      const sync = known.current.get(syncId);
      if (!sync || isPending(sync)) watched.current.add(syncId);
    }
  }, []);

  const reload = useCallback(() => runner.current(), []);
  const track = useCallback(
    (job: JobSummary) => {
      trackedAt.current.set(job.id, ++trackVersion.current);
      accept(job, true);
      publish();
      void runner.current();
    },
    [accept, publish],
  );

  useEffect(() => {
    let disposed = false;
    let pending: Promise<void> | null = null;
    let controller: AbortController | undefined;
    const visible = () => document.visibilityState === "visible";
    const unauthorized = (reason: unknown) => {
      if (!(reason instanceof ApiError) || reason.status !== 401) return false;
      window.location.assign("/login");
      return true;
    };
    const run = (): Promise<void> => {
      if (disposed || !visible()) return Promise.resolve();
      if (pending) return pending;
      controller = new AbortController();
      const stop = controller.signal;
      pending = (async () => {
        const errors = new Set<string>();
        const request = <T>(path: string) =>
          api<T>(path, {
            cache: "no-store",
            signal: AbortSignal.any([stop, AbortSignal.timeout(30_000)]),
          });
        const version = trackVersion.current;
        try {
          const result = await request<{ jobs: JobSummary[] }>("/api/jobs");
          if (disposed || stop.aborted) return;
          if (!Array.isArray(result.jobs)) throw new Error("任务列表响应不完整，请重试");
          // A submission can complete while this older list request is still in flight.
          for (const job of result.jobs)
            if ((trackedAt.current.get(job.id) ?? 0) <= version) accept(job);
          publish();
        } catch (reason) {
          if (disposed || stop.aborted) return;
          if (unauthorized(reason)) return;
          errors.add(`任务列表读取失败：${errorMessage(reason)}`);
        }
        // List omission never completes a task. Exact-ID reads also cover background syncs.
        if (!disposed && visible()) {
          const ids = [...watched.current];
          let cursor = 0;
          await Promise.all(
            Array.from({ length: Math.min(4, ids.length) }, async () => {
              while (!disposed && !stop.aborted && visible() && cursor < ids.length) {
                const id = ids[cursor++];
                const detailVersion = trackVersion.current;
                try {
                  const result = await request<{ job: JobSummary }>(
                    `/api/jobs/${encodeURIComponent(id)}`,
                  );
                  if (disposed || stop.aborted) return;
                  if (!result.job || result.job.id !== id)
                    throw new Error("任务状态响应不完整，请重试");
                  if ((trackedAt.current.get(id) ?? 0) <= detailVersion) accept(result.job);
                } catch (reason) {
                  if (disposed || stop.aborted) return;
                  if (unauthorized(reason)) return;
                  errors.add(`任务状态读取失败：${errorMessage(reason)}`);
                  // Keep the previous pending state, parent association and busy lock on failure.
                }
              }
            }),
          );
        }
        if (disposed || stop.aborted) return;
        publish();
        if (visible() && dirty.current !== delivered.current) {
          const versionToPublish = dirty.current;
          try {
            await updated.current();
            if (disposed) return;
            delivered.current = versionToPublish;
            if (dirty.current === versionToPublish) refreshInstances.current.clear();
            publish();
          } catch (reason) {
            if (disposed) return;
            errors.add(`实例数据刷新失败：${errorMessage(reason)}`);
          }
        }
        if (!disposed) {
          setLoading(false);
          setError(errors.size ? [...errors].join("；") : null);
        }
      })().finally(() => {
        pending = null;
      });
      return pending;
    };
    // Explicit reload/track after an in-flight read observes the newly submitted job next.
    const refresh = () => (pending ? pending.catch(() => {}).then(run) : run());
    runner.current = refresh;
    void run();
    const timer = window.setInterval(() => {
      if (visible()) void run();
    }, 5_000);
    const resume = () => {
      if (visible()) void run();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    return () => {
      disposed = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("online", resume);
      if (runner.current === refresh) runner.current = async () => {};
    };
  }, [accept, publish]);

  return { ...snapshot, loading, error, reload, track };
}
