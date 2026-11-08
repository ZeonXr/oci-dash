import type { MetricPoint, MetricsResult } from "@/lib/contracts";
import { formatDate } from "./format";

export interface MetricSample {
  value: number;
  timestamp: string;
}

function latestSample(points: MetricPoint[], field: "cpu" | "receivedBytes" | "sentBytes") {
  let latest: MetricSample | undefined;
  let latestTime = -Infinity;
  for (const point of points) {
    const value = point[field],
      time = Date.parse(point.timestamp);
    if (value == null || !Number.isFinite(value) || value < 0 || !Number.isFinite(time)) continue;
    if (time > latestTime) {
      latest = { value, timestamp: point.timestamp };
      latestTime = time;
    }
  }
  return latest;
}

/** Each series can end at a different time; missing samples must not erase earlier observations. */
export function instanceMetrics(data?: MetricsResult) {
  const points = data?.points ?? [];
  const rate = (field: "receivedBytes" | "sentBytes"): MetricSample | undefined => {
    const sample = latestSample(points, field),
      interval = data?.intervalSeconds;
    if (!sample || interval == null || !Number.isFinite(interval) || interval <= 0) return;
    const value = (sample.value * 8) / interval / 1_000_000;
    return Number.isFinite(value) ? { ...sample, value } : undefined;
  };
  return {
    cpu: latestSample(points, "cpu"),
    received: rate("receivedBytes"),
    sent: rate("sentBytes"),
  };
}

export function metricSampleNote(sample?: MetricSample, intervalSeconds?: number) {
  if (!sample) return "暂无可用采样";
  const interval =
    intervalSeconds && Number.isFinite(intervalSeconds) && intervalSeconds > 0
      ? intervalSeconds % 3600 === 0
        ? `${intervalSeconds / 3600} 小时平均 · `
        : intervalSeconds % 60 === 0
          ? `${intervalSeconds / 60} 分钟平均 · `
          : `${intervalSeconds} 秒平均 · `
      : "采样于 ";
  return `${interval}${formatDate(sample.timestamp)}`;
}
