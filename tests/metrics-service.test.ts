import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstanceSummary, MetricsResult } from "@/lib/contracts";
import { createInstanceMetricsService } from "@/server/instance-metrics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const target: InstanceSummary = {
  id: "instance",
  accountId: "account",
  accountName: "fixture",
  displayName: "fixture",
  region: "ap-test-1",
  availabilityDomain: "AD",
  compartmentId: "compartment",
  state: "RUNNING",
  shape: "shape",
  ocpus: 1,
  memoryGb: 1,
  os: "Linux",
  createdAt: "2026-01-01T00:00:00Z",
  syncedAt: "2026-01-01T00:00:00Z",
  vnics: [],
  bootVolumes: [],
  tags: {},
};
const result = (cpu = 12): MetricsResult => ({
  intervalSeconds: 60,
  source: "oci",
  available: true,
  points: [{ timestamp: "2026-11-09T00:00:00Z", cpu, receivedBytes: null, sentBytes: null }],
});
function fixture(timeoutMs = 20_000) {
  let revision = 1;
  const read = vi.fn(
    async (
      _credentials: unknown,
      _instance: InstanceSummary,
      _range: string,
      _signal?: AbortSignal,
    ) => result(),
  );
  const service = createInstanceMetricsService({
    read,
    timeoutMs,
    access: () => ({
      revision,
      credentials: {
        tenancyId: "tenancy",
        userId: "user",
        privateKey: "synthetic",
        fingerprint: "synthetic",
        region: target.region,
      },
    }),
    instance: () => target,
  });
  return {
    read,
    service,
    rotate: () => {
      revision++;
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("shared instance metrics reads", () => {
  it("coalesces matching reads and serves detached copies from cache", async () => {
    const f = fixture(),
      gate = deferred<MetricsResult>();
    f.read.mockReturnValueOnce(gate.promise);
    const a = f.service.query(target, "1h"),
      b = f.service.query(target, "1h");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    gate.resolve(result());
    const [first, second] = await Promise.all([a, b]);
    first.points[0].cpu = 99;
    expect(second.points[0].cpu).toBe(12);
    expect((await f.service.query(target, "1h")).points[0].cpu).toBe(12);
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation and keeps a shared read alive for another subscriber", async () => {
    const f = fixture(),
      gate = deferred<MetricsResult>(),
      caller = new AbortController();
    f.read.mockReturnValueOnce(gate.promise);
    const cancelled = f.service.query(target, "1h", caller.signal).catch((error) => error);
    const remaining = f.service.query(target, "1h");
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    const signal = f.read.mock.calls[0][3]!;
    caller.abort();
    expect(await cancelled).toMatchObject({ code: "METRICS_CANCELLED" });
    expect(signal.aborted).toBe(false);
    gate.resolve(result());
    expect((await remaining).points[0].cpu).toBe(12);
    await f.service.query(target, "1h");
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("aborts an abandoned read and never caches its eventual result", async () => {
    const f = fixture(),
      gate = deferred<MetricsResult>(),
      caller = new AbortController();
    f.read.mockReturnValueOnce(gate.promise);
    const pending = f.service.query(target, "1h", caller.signal).catch((error) => error);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    const signal = f.read.mock.calls[0][3]!;
    caller.abort();
    expect(await pending).toMatchObject({ code: "METRICS_CANCELLED" });
    expect(signal.aborted).toBe(true);
    gate.resolve(result(99));
    expect((await f.service.query(target, "1h")).points[0].cpu).toBe(12);
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("bounds the total response time even when a transport ignores abort", async () => {
    vi.useFakeTimers();
    const f = fixture(20_000),
      gate = deferred<MetricsResult>();
    f.read.mockReturnValueOnce(gate.promise);
    const pending = f.service.query(target, "1h").catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toMatchObject({ status: 504, code: "METRICS_TIMEOUT" });
    expect(f.read.mock.calls[0][3]!.aborted).toBe(true);
    gate.resolve(result(99));
    expect((await f.service.query(target, "1h")).points[0].cpu).toBe(12);
  });
  it("does not evict a valid earlier success when another range times out", async () => {
    vi.useFakeTimers();
    const f = fixture(100),
      gate = deferred<MetricsResult>();
    await f.service.query(target, "1h");
    f.read.mockReturnValueOnce(gate.promise);
    const pending = f.service.query(target, "24h").catch((error) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ code: "METRICS_TIMEOUT" });
    expect((await f.service.query(target, "1h")).points[0].cpu).toBe(12);
    expect(f.read).toHaveBeenCalledTimes(2);
    gate.resolve(result(99));
  });
  it("rejects results whose credential revision changed during the read", async () => {
    const f = fixture(),
      gate = deferred<MetricsResult>();
    f.read.mockReturnValueOnce(gate.promise);
    const pending = f.service.query(target, "1h").catch((error) => error);
    await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(1));
    f.rotate();
    gate.resolve(result(99));
    expect(await pending).toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect((await f.service.query(target, "1h")).points[0].cpu).toBe(12);
  });
  it("rejects pre-cancelled callers before creating any OCI work", async () => {
    const f = fixture(),
      caller = new AbortController();
    caller.abort();
    await expect(f.service.query(target, "1h", caller.signal)).rejects.toMatchObject({
      code: "METRICS_CANCELLED",
    });
    expect(f.read).not.toHaveBeenCalled();
  });
});
