import type { AnalyticsAccountStatus, AnalyticsStatus } from "./analytics-contracts";

export type CpuCoverage = "complete" | "partial" | "unavailable";
export interface CpuHour {
  /** Beginning of one completed UTC hour. */
  timestamp: string;
  /** Mean of the valid 5-minute mean samples observed in this hour. */
  cpuPercent: number | null;
  sampleCount: number;
  expectedSamples: 12;
  coverage: CpuCoverage;
}
export interface CpuInstanceRow {
  instanceId: string;
  instanceName: string;
  accountId: string;
  accountName: string;
  region: string;
  /** Cached OCI lifecycle state; not a connectivity or health probe. */
  state: string;
  points: CpuHour[];
  averageCpuPercent: number | null;
  peakCpuPercent: number | null;
  sampleCount: number;
  coverage: CpuCoverage;
}
export interface CpuFleetPoint {
  timestamp: string;
  /** Equal-weight mean of the instances with an observed value in this hour. */
  cpuPercent: number | null;
  instanceCount: number;
  totalInstances: number;
  sampleCount: number;
  coverage: CpuCoverage;
}
export interface CpuReport {
  range: {
    startTime: string;
    endTime: string;
    granularity: "hourly";
    timeZone: "UTC";
  };
  rows: CpuInstanceRow[];
  points: CpuFleetPoint[];
  summary: {
    /** Mean of the available hourly fleet points above; identical to the sparkline's weighting. */
    averageCpuPercent: number | null;
    /** Highest observed instance-hour mean, matching the heatmap cells. */
    peakCpuPercent: number | null;
    instancesWithSamples: number;
    totalInstances: number;
    observedHours: number;
    totalSamples: number;
  };
  status: AnalyticsStatus;
  accounts: AnalyticsAccountStatus[];
  warnings: string[];
  generatedAt: string;
  cacheExpiresAt: string;
  cached: boolean;
  source: "oci" | "demo";
}
