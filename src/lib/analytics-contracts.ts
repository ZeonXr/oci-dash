/** Public analytics DTOs. Calendar filters include both dates; wire time ranges are [start,end). */
export type AnalyticsStatus = "ok" | "partial" | "empty";
export interface AnalyticsRange {
  startDate: string;
  endDate: string;
  startTime: string;
  endTime: string;
  granularity: "hourly" | "daily" | "monthly";
  timeZone: "UTC";
}
export interface AnalyticsAccountStatus {
  accountId: string;
  accountName: string;
  status: AnalyticsStatus | "error" | "duplicate";
  message?: string;
}
export interface AnalyticsMetadata {
  range: AnalyticsRange;
  generatedAt: string;
  cacheExpiresAt: string;
  cached: boolean;
  source: "oci" | "demo";
  accounts: AnalyticsAccountStatus[];
}
export interface TrafficPoint {
  /** Beginning of a non-overlapping UTC hour/day bucket. */
  timestamp: string;
  receivedBytes: number | null;
  sentBytes: number | null;
  /** Partial points are observed subtotals, not a claim that missing samples are zero. */
  coverage?: "complete" | "partial" | "unavailable";
}
export interface TrafficRow {
  instanceId: string;
  instanceName: string;
  accountId: string;
  accountName: string;
  region: string;
  vnicId: string;
  vnicName: string;
  receivedBytes: number | null;
  sentBytes: number | null;
  coverage: "complete" | "partial" | "unavailable";
}
export interface TrafficAccountData {
  points: TrafficPoint[];
  rows: TrafficRow[];
  warnings: string[];
  status: AnalyticsStatus;
  /** Latest completed bucket boundary included in this response, when known. */
  dataThrough?: string;
}
export interface TrafficReport extends TrafficAccountData, AnalyticsMetadata {
  totals: {
    receivedBytes: number | null;
    sentBytes: number | null;
    totalBytes: number | null;
  };
}
export interface CostRow {
  accountId: string;
  accountName: string;
  tenancyId: string;
  /** Beginning of the OCI UTC billing day/month. */
  timestamp: string;
  service: string | null;
  region: string | null;
  resourceId: string | null;
  resourceName: string | null;
  currency: string | null;
  amount: string | null;
}
export interface CostTotal {
  currency: string | null;
  /** Decimal text; null is unknown, never a confirmed zero. */
  amount: string | null;
}
export interface CostPoint extends CostTotal {
  timestamp: string;
}
export interface CostAccountData {
  rows: CostRow[];
  totals: CostTotal[];
  points: CostPoint[];
  warnings: string[];
  status: AnalyticsStatus;
}
export interface CostReport extends CostAccountData, AnalyticsMetadata {}
