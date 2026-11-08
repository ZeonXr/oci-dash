import type { InstanceSummary, MetricsResult } from "@/lib/contracts";
import { getCredentialSnapshot } from "./accounts";
import { AppError } from "./errors";
import { getInstance } from "./inventory";
import { ociAdapter } from "./oci/adapter";

interface MetricsOptions {
  read?: typeof ociAdapter.metrics;
  access?: typeof getCredentialSnapshot;
  instance?: typeof getInstance;
  now?: () => number;
  timeoutMs?: number;
}
interface PendingMetrics {
  value: Promise<MetricsResult>;
  controller: AbortController;
  waiters: number;
}
const cancelled = () => new AppError("监控查询已取消", 499, "METRICS_CANCELLED");
const scopeOf = (value: InstanceSummary | undefined) =>
  value &&
  JSON.stringify([
    value.accountId,
    value.id,
    value.region,
    value.compartmentId,
    value.vnics.map((vnic) => vnic.id).sort(),
  ]);

/** Bound the response without releasing the adapter's actual RPC slots or clients early. */
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? cancelled());
    if (!signal.aborted) signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

export function createInstanceMetricsService(options: MetricsOptions = {}) {
  const read = options.read ?? ((...args) => ociAdapter.metrics(...args));
  const access = options.access ?? getCredentialSnapshot;
  const instance = options.instance ?? getInstance;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Invalid metrics deadline");
  const cache = new Map<string, { expires: number; value: MetricsResult }>();
  const inflight = new Map<string, PendingMetrics>();
  return {
    async query(
      target: InstanceSummary,
      range: "1h" | "24h" | "7d",
      callerSignal?: AbortSignal,
    ): Promise<MetricsResult> {
      if (callerSignal?.aborted) throw cancelled();
      const snapshot = access(target.accountId, target.region);
      const scope = scopeOf(target);
      const key = JSON.stringify([
        scope,
        snapshot.revision,
        snapshot.credentials.tenancyId,
        snapshot.credentials.userId,
        range,
      ]);
      const assertCurrent = () => {
        const current = access(target.accountId, target.region);
        if (current.revision !== snapshot.revision)
          throw new AppError("账号配置已变更，请重新读取监控", 409, "ACCOUNT_CHANGED");
        if (scopeOf(instance(target.id)) !== scope)
          throw new AppError("实例监控范围已变更，请重新读取", 409, "RESOURCE_CHANGED");
      };
      assertCurrent();
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return structuredClone(cached.value);
      let pending = inflight.get(key);
      if (pending?.controller.signal.aborted) {
        inflight.delete(key);
        pending = undefined;
      }
      if (!pending) {
        if (inflight.size >= 4)
          throw new AppError("已有监控查询正在执行，请稍后重试", 429, "METRICS_BUSY");
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new AppError("监控查询超时，请稍后重试", 504, "METRICS_TIMEOUT")),
          timeoutMs,
        );
        timer.unref();
        const entry: PendingMetrics = {
          controller,
          waiters: 0,
          value: Promise.resolve().then(() =>
            read(snapshot.credentials, target, range, controller.signal),
          ),
        };
        entry.value = bounded(entry.value, controller.signal)
          .then((value) => {
            if (controller.signal.aborted) throw controller.signal.reason;
            assertCurrent();
            for (const [oldKey, old] of cache) if (old.expires <= now()) cache.delete(oldKey);
            if (cache.size >= 100) cache.delete(cache.keys().next().value!);
            cache.set(key, { expires: now() + 60_000, value: structuredClone(value) });
            return value;
          })
          .finally(() => {
            clearTimeout(timer);
            if (inflight.get(key) === entry) inflight.delete(key);
          });
        inflight.set(key, entry);
        pending = entry;
      }
      pending.waiters++;
      try {
        const value = callerSignal
          ? await bounded(pending.value, callerSignal)
          : await pending.value;
        assertCurrent();
        return structuredClone(value);
      } catch (error) {
        if (callerSignal?.aborted) throw cancelled();
        throw error;
      } finally {
        pending.waiters--;
        if (!pending.waiters) pending.controller.abort(cancelled());
      }
    },
  };
}
export const instanceMetricsService = createInstanceMetricsService();
