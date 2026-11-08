/** Public API contracts. Never include private keys, password hashes, or encryption keys here. */
export type AccountStatus = "unchecked" | "connected" | "error";
export interface AccountSummary {
  id: string;
  name: string;
  tenancyId: string;
  userId: string;
  fingerprint: string;
  homeRegion: string;
  regions: string[];
  status: AccountStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export interface PublicIpBinding {
  privateIpId: string;
  privateIp: string;
  isPrimary: boolean;
  vnicId: string;
  publicIpId?: string;
  publicIp?: string;
  lifetime?: "EPHEMERAL" | "RESERVED";
  protected: boolean;
}
export interface VnicSummary {
  id: string;
  name: string;
  primary: boolean;
  subnetId: string;
  nsgIds: string[];
  privateIps: PublicIpBinding[];
  ipv6: string[];
}
export interface BootVolumeSummary {
  id: string;
  accountId: string;
  region: string;
  name: string;
  state: string;
  sizeGb: number;
  vpusPerGb: number;
  attachmentId?: string;
}
export interface InstanceSummary {
  id: string;
  accountId: string;
  accountName: string;
  displayName: string;
  region: string;
  availabilityDomain: string;
  compartmentId: string;
  state: string;
  shape: string;
  ocpus: number;
  memoryGb: number;
  os: string;
  createdAt: string;
  vnics: VnicSummary[];
  bootVolumes: BootVolumeSummary[];
  tags: Record<string, string>;
  syncedAt: string;
  /** Detail fields that could not be refreshed; retained values may predate syncedAt. */
  staleFields?: string[];
  metrics?: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    receivedMbps: number | null;
    sentMbps: number | null;
  };
}
export interface MetricPoint {
  timestamp: string;
  cpu: number | null;
  receivedBytes: number | null;
  sentBytes: number | null;
}
export interface MetricsResult {
  points: MetricPoint[];
  available: boolean;
  note?: string;
  source: "oci";
}
export interface InventoryResult {
  instances: InstanceSummary[];
  warnings: string[];
  regions: string[];
  /** Only successfully enumerated scopes authorize removal of absent instances. */
  completedScopes?: { region: string; compartmentId: string }[];
  /** Successful empty detail collections are distinct from failed reads. */
  details?: Record<string, InventoryDetailCoverage>;
}
export interface InventoryDetailCoverage {
  vnics: boolean;
  bootVolumes: boolean;
  os: boolean;
  vnicDetails: Record<string, { privateIps: boolean; ipv6: boolean; publicBindings: string[] }>;
}
export interface SelectOption {
  id: string;
  name: string;
}
export interface ShapeOption {
  name: string;
  ocpus: number;
  memoryGb: number;
  flexible: boolean;
  minOcpus?: number;
  maxOcpus?: number;
  minMemoryGb?: number;
  maxMemoryGb?: number;
}
export interface CreateOptions {
  availabilityDomains: string[];
  compartments: SelectOption[];
  shapes: ShapeOption[];
  images: SelectOption[];
  subnets: SelectOption[];
}
export interface SecurityRule {
  id: string;
  direction: "INGRESS" | "EGRESS";
  protocol: string;
  peer: string;
  peerType: string;
  description: string;
  stateless: boolean;
  portMin?: number;
  portMax?: number;
  icmpType?: number;
  icmpCode?: number;
}
export interface SecurityGroup {
  id: string;
  name: string;
  kind: "nsg" | "security-list";
  etag?: string;
  rules: SecurityRule[];
}
export type OperationKind =
  | "sync-account"
  | "instance-start"
  | "instance-stop"
  | "instance-reboot"
  | "instance-terminate"
  | "instance-rename"
  | "instance-create"
  | "public-ip-rotate"
  | "boot-volume-update"
  | "security-rule-add"
  | "security-rule-delete"
  | "ipv6-assign";
export interface OperationRequest {
  kind: OperationKind;
  accountId: string;
  region: string;
  resourceId?: string;
  payload: Record<string, unknown>;
  confirmation?: string;
  idempotencyKey?: string;
}
export type JobState =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "interrupted";
export interface JobSummary {
  id: string;
  kind: OperationKind;
  accountId: string;
  accountName: string;
  region: string;
  resourceId: string | null;
  state: JobState;
  attempt: number;
  maxAttempts: number;
  /** An accepted operation is being reconciled without spending another error attempt. */
  waitingForCompletion?: boolean;
  /** Persisted deadline for this execution window; an explicit manual retry starts a new window. */
  completionDeadlineAt?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextRunAt: string | null;
  lastError: string | null;
  result: Record<string, unknown> | null;
}
export interface InventoryRefreshAccount {
  accountId: string;
  status: "queued" | "active" | "fresh" | "backoff" | "throttled";
  jobId: string | null;
  lastSyncedAt: string | null;
  nextRefreshAt: string | null;
}
export interface JobListQuery {
  page: number;
  pageSize: number;
  query?: string;
  accountId?: string;
  resourceId?: string;
  state?: JobState;
  sort: "ascending" | "descending";
}
export interface JobPage {
  jobs: JobSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface InstanceJobContext {
  jobs: JobSummary[];
  recentJobs: JobSummary[];
}
export interface InventoryRefreshResult {
  jobs: JobSummary[];
  accounts: InventoryRefreshAccount[];
}
export interface JobEvent {
  id: number;
  jobId: string;
  level: "info" | "warning" | "error";
  message: string;
  detail: Record<string, unknown> | null;
  createdAt: string;
}
export interface AuditEvent {
  id: number;
  action: string;
  resource: string;
  result: string;
  createdAt: string;
}
export interface DashboardData {
  accounts: AccountSummary[];
  instances: InstanceSummary[];
  jobs: JobSummary[];
  activity: AuditEvent[];
  totals: {
    accounts: number;
    instances: number;
    running: number;
    stopped: number;
    storageGb: number;
    regions: number;
  };
}
export interface SessionUser {
  id: string;
  username: string;
  mfaEnabled: boolean;
}
export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: unknown;
}
