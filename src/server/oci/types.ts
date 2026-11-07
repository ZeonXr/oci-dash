import type { AccountSummary, CreateOptions, InstanceSummary, InventoryResult, MetricsResult, OperationRequest, SecurityGroup } from "@/lib/contracts";

/** Server-only credentials. Never return this type from an HTTP handler. */
export interface OciCredentials { tenancyId: string; userId: string; fingerprint: string; privateKey: string; region: string; }
export interface ExecutionContext {
  jobId: string; signal: AbortSignal; checkpoints: Record<string, unknown>;
  progress(message: string, detail?: Record<string, unknown>): Promise<void>;
  checkpoint(key: string, value: unknown): Promise<void>;
}
export interface OperationResult { message: string; details?: Record<string, unknown>; }
export interface OciAdapter {
  verify(credentials: OciCredentials): Promise<{ tenancyName: string; homeRegion: string; regions: string[] }>;
  inventory(credentials: OciCredentials, account: AccountSummary, regions: string[], context?: ExecutionContext): Promise<InventoryResult>;
  metrics(credentials: OciCredentials, instance: InstanceSummary, range: "1h" | "24h" | "7d"): Promise<MetricsResult>;
  createOptions(credentials: OciCredentials, compartmentId?: string): Promise<CreateOptions>;
  securityGroups(credentials: OciCredentials, instance: InstanceSummary): Promise<SecurityGroup[]>;
  execute(credentials: OciCredentials, operation: OperationRequest, context: ExecutionContext): Promise<OperationResult>;
}
export class CloudError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable = false, public readonly requestId?: string) { super(message); this.name = "CloudError"; }
}
