import { describe, expect, it } from "vitest";
import type { MetricPoint, MetricsResult } from "@/lib/contracts";
import { instanceMetrics, metricSampleNote } from "@/components/instance-metrics";

const point = (minute: number, values: Partial<MetricPoint> = {}): MetricPoint => ({
  timestamp: new Date(Date.UTC(2026, 10, 9, 12, minute)).toISOString(),
  cpu: null,
  receivedBytes: null,
  sentBytes: null,
  ...values,
});
const report = (points: MetricPoint[], intervalSeconds = 60): MetricsResult => ({
  points,
  intervalSeconds,
  available: points.length > 0,
  source: "oci",
});

describe("instance metric summaries", () => {
  it("selects each series' latest observation even when a newer timestamp only has network data", () => {
    const summary = instanceMetrics(
      report([
        point(2, { sentBytes: 150_000_000 }),
        point(0, { cpu: 15 }),
        point(3),
        point(1, { receivedBytes: 75_000_000 }),
        point(-1, { cpu: 75, receivedBytes: 1, sentBytes: 1 }),
      ]),
    );
    expect(summary).toEqual({
      cpu: { value: 15, timestamp: point(0).timestamp },
      received: { value: 10, timestamp: point(1).timestamp },
      sent: { value: 20, timestamp: point(2).timestamp },
    });
  });

  it.each([
    [60, 10],
    [300, 2],
    [3600, 1 / 6],
  ])("converts byte sums using the declared %i-second bucket", (interval, expected) => {
    const summary = instanceMetrics(report([point(0, { receivedBytes: 75_000_000 })], interval));
    expect(summary.received?.value).toBeCloseTo(expected);
    expect(summary.sent).toBeUndefined();
  });

  it("keeps observed zero and ignores invalid values or timestamps", () => {
    const summary = instanceMetrics(
      report([
        point(0, { cpu: 0, receivedBytes: 0, sentBytes: 0 }),
        point(1, { cpu: NaN, receivedBytes: Infinity, sentBytes: -1 }),
        point(2, { timestamp: "invalid", cpu: 99, receivedBytes: 1, sentBytes: 1 }),
      ]),
    );
    for (const sample of Object.values(summary))
      expect(sample).toEqual({ value: 0, timestamp: point(0).timestamp });
  });

  it.each([0, -1, NaN, Infinity])(
    "does not invent a network rate for invalid interval %s",
    (interval) => {
      const summary = instanceMetrics(
        report([point(0, { cpu: 15, receivedBytes: 1, sentBytes: 1 })], interval),
      );
      expect(summary.cpu?.value).toBe(15);
      expect(summary.received).toBeUndefined();
      expect(summary.sent).toBeUndefined();
    },
  );

  it("keeps missing metrics distinct from zero", () => {
    expect(instanceMetrics()).toEqual({ cpu: undefined, received: undefined, sent: undefined });
    expect(instanceMetrics(report([point(0)]))).toEqual(instanceMetrics());
    expect(metricSampleNote()).toBe("暂无可用采样");
  });

  it("labels averages with their aggregation interval and actual sample time", () => {
    const sample = { value: 10, timestamp: point(0).timestamp };
    expect(metricSampleNote(sample, 60)).toMatch(/^1 分钟平均 · .+$/);
    expect(metricSampleNote(sample, 300)).toMatch(/^5 分钟平均 · .+$/);
    expect(metricSampleNote(sample, 3600)).toMatch(/^1 小时平均 · .+$/);
    expect(metricSampleNote(sample)).toMatch(/^采样于 .+$/);
  });
});
