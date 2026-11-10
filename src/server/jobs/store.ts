import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DrizzleQueryError } from "drizzle-orm";
import { safeMessage } from "../errors";
import { canResumeJob, isJobCancellable, isJobRetryable } from "@/lib/job-state";
import type {
  AccountSummary,
  JobEvent,
  JobState,
  JobSummary,
  InventoryRefreshResult,
  JobListQuery,
  JobPage,
  OperationKind,
  OperationRequest,
} from "@/lib/contracts";
import { operationLabels } from "@/lib/operation-labels";

const kinds = new Set<OperationKind>([
  "sync-account",
  "instance-start",
  "instance-stop",
  "instance-reboot",
  "instance-terminate",
  "instance-rename",
  "instance-create",
  "public-ip-rotate",
  "boot-volume-update",
  "security-rule-add",
  "security-rule-delete",
  "ipv6-assign",
]);
const MAX_ATTEMPTS = 4;
const INVENTORY_FRESH_MS = 60_000;
const MANUAL_REFRESH_THROTTLE_MS = 2_000;
const AUTO_REFRESH_BACKOFF_MAX_MS = 15 * 60_000;
export const DEFAULT_LEASE_MS = 30_000;
export const MAX_CONCURRENT_ACCOUNT_SYNCS = 2;
export const DEFAULT_COMPLETION_TIMEOUT_MS = 30 * 60_000;
export const COMPLETION_TIMEOUT_MESSAGE =
  "等待 OCI 完成已超过本轮执行期限。云端操作可能仍在继续，请核对资源后重试；重试会保留检查点。";
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g;
const secretField =
  /(?:private[_-]?key|password|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|^secret$|^credentials?$|^cookies?$)/i;
const queryFunctions = new WeakSet<Database.Database>();
const pendingCondition = (alias: string) =>
  `(${alias}.state IN ('queued','running','retrying','cancel_requested') OR (${alias}.state='interrupted' AND ${alias}.next_run_at IS NOT NULL AND (${alias}.waiting_for_completion=1 OR ${alias}.attempt<${alias}.max_attempts)))`;
const labelCase = `CASE kind ${Object.entries(operationLabels)
  .map(([kind, label]) => `WHEN '${kind}' THEN '${label.replaceAll("'", "''")}'`)
  .join(" ")} ELSE kind END`;

export class JobError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "JobError";
  }
}
export class LeaseLostError extends Error {
  constructor() {
    super("This worker no longer owns the job lease.");
    this.name = "LeaseLostError";
  }
}

function jsonValue(value: unknown, redact: boolean, depth = 0): unknown {
  if (depth > 32) throw new JobError("Job data is nested too deeply.", "INVALID_JOB_DATA");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const clean = value.replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
    if (!redact && clean !== value)
      throw new JobError("Private keys cannot be stored in job data.", "SENSITIVE_JOB_DATA");
    return clean;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((v) => jsonValue(v, redact, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      if (secretField.test(key)) {
        if (!redact)
          throw new JobError("Credentials cannot be stored in job data.", "SENSITIVE_JOB_DATA");
        output[key] = "[REDACTED]";
      } else output[key] = jsonValue(child, redact, depth + 1);
    }
    return output;
  }
  throw new JobError("Job data must contain JSON values only.", "INVALID_JOB_DATA");
}
export function safeErrorMessage(error: unknown, secrets: string[] = []): string {
  let message =
    error instanceof DrizzleQueryError
      ? safeMessage(error)
      : error instanceof Error
        ? error.message
        : "The operation could not be completed.";
  message = message.replace(PRIVATE_KEY, "[REDACTED PRIVATE KEY]");
  for (const secret of secrets)
    if (secret.length > 8) message = message.split(secret).join("[REDACTED]");
  return message.slice(0, 2000);
}
function encode(value: unknown, redact = false, maximum = 128_000): string {
  const text = JSON.stringify(jsonValue(value, redact));
  if (text.length > maximum) throw new JobError("Job data is too large.", "INVALID_JOB_DATA");
  return text;
}

interface JobRow {
  id: string;
  kind: OperationKind;
  account_id: string;
  account_name: string;
  region: string;
  resource_id: string | null;
  resource_lock: string;
  state: JobState;
  attempt: number;
  max_attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  result_json: string | null;
  operation_json: string;
  requested_by: string;
  idempotency_key: string | null;
  payload_hash: string;
  checkpoints_json: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  cancel_requested: number;
  needs_reconcile: number;
  background: number;
  waiting_for_completion: number;
  completion_deadline_at: string | null;
}
interface InventoryRefreshRow {
  account_id: string;
  failure_count: number;
  last_failure_at: string | null;
  retry_after: string | null;
  manual_requested_at: string | null;
  manual_job_id: string | null;
}
export interface ClaimedJob {
  summary: JobSummary;
  operation: OperationRequest;
  checkpoints: Record<string, unknown>;
  requestedBy: string;
  needsReconcile: boolean;
}
export interface WorkerStatus {
  online: boolean;
  lastHeartbeatAt: string | null;
  workerId: string | null;
  activeJobs: number;
  leaseSeconds: number;
}
export interface JobStoreOptions {
  db: Database.Database;
  getAccount(id: string): AccountSummary | null;
  now?: () => Date;
  completionTimeoutMs?: number;
}
function summary(r: JobRow): JobSummary {
  return {
    id: r.id,
    kind: r.kind,
    accountId: r.account_id,
    accountName: r.account_name,
    region: r.region,
    resourceId: r.resource_id,
    state: r.state,
    attempt: r.attempt,
    maxAttempts: r.max_attempts,
    waitingForCompletion: Boolean(r.waiting_for_completion),
    completionDeadlineAt: r.completion_deadline_at,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    nextRunAt: r.next_run_at,
    lastError: r.last_error,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  };
}
function resourceKeys(operation: OperationRequest): string[] {
  const target =
    operation.kind === "sync-account"
      ? "sync-account"
      : operation.resourceId || `${operation.kind}:${operation.region}`;
  const keys = [`${operation.accountId}:${target}`];
  const fields = operation.kind.startsWith("security-rule-")
    ? ["groupId"]
    : operation.kind === "boot-volume-update"
      ? ["bootVolumeId", "volumeId"]
      : operation.kind === "public-ip-rotate"
        ? ["privateIpId"]
        : [];
  for (const field of fields) {
    const id = operation.payload[field];
    if (typeof id === "string" && id) keys.push(`${operation.accountId}:${id}`);
  }
  return [...new Set(keys)].sort();
}
export function createJobStore({
  db,
  getAccount,
  now = () => new Date(),
  completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
}: JobStoreOptions) {
  if (!Number.isFinite(completionTimeoutMs) || completionTimeoutMs <= 0)
    throw new JobError("The completion timeout must be finite and positive.", "INVALID_TIMEOUT");
  if (!queryFunctions.has(db)) {
    // Keep the previous JavaScript includes semantics, including Unicode case
    // folding and literal %/_ characters, while filtering before pagination.
    db.function("job_search_includes", { deterministic: true }, (text, query) =>
      String(text).toLowerCase().includes(String(query).toLowerCase()) ? 1 : 0,
    );
    queryFunctions.add(db);
  }
  const timestamp = () => now().toISOString();
  const row = (id: string) =>
    db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as JobRow | undefined;
  function required(id: string): JobRow {
    const found = row(id);
    if (!found) throw new JobError("Task not found.", "JOB_NOT_FOUND", 404);
    return found;
  }
  function event(
    id: string,
    level: JobEvent["level"],
    message: string,
    detail?: Record<string, unknown>,
  ): void {
    db.prepare(
      "INSERT INTO job_events(job_id,level,message,detail_json,created_at) VALUES(?,?,?,?,?)",
    ).run(
      id,
      level,
      safeErrorMessage(new Error(message)),
      detail ? encode(detail, true, 64_000) : null,
      timestamp(),
    );
  }
  function owned(id: string, workerId: string): JobRow {
    const found = required(id);
    if (
      found.lease_owner !== workerId ||
      !found.lease_expires_at ||
      found.lease_expires_at <= timestamp() ||
      !["running", "cancel_requested"].includes(found.state)
    )
      throw new LeaseLostError();
    return found;
  }
  function activeAccountSync(accountId: string): JobRow | undefined {
    return db
      .prepare(
        `SELECT * FROM jobs WHERE account_id=? AND kind='sync-account' AND cancel_requested=0
        AND (state IN ('queued','running','retrying') OR
          (state='interrupted' AND next_run_at IS NOT NULL AND (attempt<max_attempts OR waiting_for_completion=1)))
        ORDER BY created_at DESC,rowid DESC LIMIT 1`,
      )
      .get(accountId) as JobRow | undefined;
  }
  function refreshState(accountId: string): InventoryRefreshRow {
    db.prepare("INSERT OR IGNORE INTO inventory_refresh_state(account_id) VALUES(?)").run(
      accountId,
    );
    return db
      .prepare("SELECT * FROM inventory_refresh_state WHERE account_id=?")
      .get(accountId) as InventoryRefreshRow;
  }
  function pruneAutomaticHistory(accountId: string): void {
    // Keep the latest completed automatic refresh, plus every live job. Explicit user
    // jobs and their references/events are never removed by this retention policy.
    const obsolete = db
      .prepare(
        `SELECT id FROM jobs WHERE account_id=? AND kind='sync-account' AND background=1
        AND lease_owner IS NULL AND (state IN ('succeeded','failed','cancelled') OR
          (state='interrupted' AND next_run_at IS NULL))
        ORDER BY COALESCE(finished_at,created_at) DESC,rowid DESC LIMIT -1 OFFSET 1`,
      )
      .all(accountId) as { id: string }[];
    for (const { id } of obsolete) {
      db.prepare("DELETE FROM job_events WHERE job_id=?").run(id);
      db.prepare("DELETE FROM job_resources WHERE job_id=?").run(id);
      db.prepare("DELETE FROM jobs WHERE id=?").run(id);
    }
  }
  function recordSyncOutcome(
    job: JobRow,
    state: "succeeded" | "failed" | "cancelled",
    result?: Record<string, unknown>,
  ): void {
    if (job.kind !== "sync-account") return;
    const previous = refreshState(job.account_id);
    const partial =
      state === "succeeded" && Array.isArray(result?.warnings) && result.warnings.length > 0;
    if (state === "succeeded" && !partial) {
      db.prepare(
        "UPDATE inventory_refresh_state SET failure_count=0,last_failure_at=NULL,retry_after=NULL WHERE account_id=?",
      ).run(job.account_id);
    } else {
      const failures =
        state === "cancelled" ? previous.failure_count : Math.min(previous.failure_count + 1, 32);
      const wait =
        state === "cancelled"
          ? INVENTORY_FRESH_MS
          : Math.min(
              AUTO_REFRESH_BACKOFF_MAX_MS,
              INVENTORY_FRESH_MS * 2 ** Math.max(0, failures - 1),
            );
      db.prepare(
        "UPDATE inventory_refresh_state SET failure_count=?,last_failure_at=?,retry_after=? WHERE account_id=?",
      ).run(failures, timestamp(), new Date(now().getTime() + wait).toISOString(), job.account_id);
    }
    pruneAutomaticHistory(job.account_id);
  }
  function enqueueOperation(operation: OperationRequest, requestedBy: string): JobSummary {
    if (
      !operation ||
      !kinds.has(operation.kind) ||
      !operation.accountId ||
      !operation.region ||
      !operation.payload ||
      Array.isArray(operation.payload) ||
      typeof operation.payload !== "object"
    )
      throw new JobError(
        "An account, region and supported operation are required.",
        "INVALID_OPERATION",
      );
    if (
      operation.kind !== "sync-account" &&
      operation.kind !== "instance-create" &&
      !operation.resourceId
    )
      throw new JobError("The target resource is required.", "RESOURCE_REQUIRED");
    if (!requestedBy || requestedBy.length > 200)
      throw new JobError("The requesting user is required.", "INVALID_REQUESTER");
    const account = getAccount(operation.accountId);
    if (!account) throw new JobError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
    if (![account.homeRegion, ...account.regions].includes(operation.region))
      throw new JobError("The region is not enabled for this account.", "REGION_NOT_ENABLED");
    const key = operation.idempotencyKey?.trim() || null;
    if (key && key.length > 200)
      throw new JobError("The idempotency key is too long.", "INVALID_IDEMPOTENCY_KEY");
    const normalized: OperationRequest = {
      kind: operation.kind,
      accountId: operation.accountId,
      region: operation.region,
      payload: operation.payload,
      ...(operation.resourceId ? { resourceId: operation.resourceId } : {}),
      ...(operation.confirmation !== undefined ? { confirmation: operation.confirmation } : {}),
    };
    const serialized = encode(normalized);
    const hash = createHash("sha256")
      .update(serialized)
      .update("\n" + requestedBy)
      .digest("hex");
    return db
      .transaction(() => {
        if (key) {
          const previous = db
            .prepare("SELECT * FROM jobs WHERE account_id=? AND idempotency_key=?")
            .get(account.id, key) as JobRow | undefined;
          if (previous) {
            if (previous.payload_hash !== hash)
              throw new JobError(
                "This idempotency key was used for a different request.",
                "IDEMPOTENCY_CONFLICT",
                409,
              );
            return summary(previous);
          }
        }
        const id = randomUUID(),
          created = timestamp();
        const resource =
          operation.kind === "sync-account"
            ? "sync-account"
            : operation.resourceId || `${operation.kind}:${operation.region}`;
        db.prepare(
          `INSERT INTO jobs(id,kind,account_id,account_name,region,resource_id,resource_lock,state,
        max_attempts,created_at,next_run_at,operation_json,requested_by,idempotency_key,payload_hash)
        VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?,?,?,?)`,
        ).run(
          id,
          operation.kind,
          account.id,
          account.name,
          operation.region,
          operation.resourceId || null,
          `${account.id}:${resource}`,
          MAX_ATTEMPTS,
          created,
          created,
          serialized,
          requestedBy,
          key,
          hash,
        );
        for (const resourceKey of resourceKeys(normalized))
          db.prepare("INSERT INTO job_resources(job_id,resource_key) VALUES(?,?)").run(
            id,
            resourceKey,
          );
        event(id, "info", "Task accepted and saved.", { requestedBy });
        return summary(required(id));
      })
      .immediate();
  }
  function enqueueAccountSync(accountId: string, requestedBy: string): JobSummary {
    return db
      .transaction(() => {
        const account = getAccount(accountId);
        if (!account) throw new JobError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
        if (!requestedBy || requestedBy.length > 200)
          throw new JobError("The requesting user is required.", "INVALID_REQUESTER");
        const existing = activeAccountSync(accountId);
        if (existing) {
          db.prepare("UPDATE jobs SET background=0 WHERE id=?").run(existing.id);
          return summary(existing);
        }
        return enqueueOperation(
          { kind: "sync-account", accountId, region: account.homeRegion, payload: {} },
          requestedBy,
        );
      })
      .immediate();
  }
  function refreshInventory(
    accountIds: string[],
    mode: "auto" | "manual",
    requestedBy: string,
  ): InventoryRefreshResult {
    if (!["auto", "manual"].includes(mode) || !requestedBy || requestedBy.length > 200)
      throw new JobError(
        "A valid refresh mode and requesting user are required.",
        "INVALID_REFRESH",
      );
    return db
      .transaction(() => {
        const jobs: JobSummary[] = [];
        const accounts: InventoryRefreshResult["accounts"] = [];
        for (const accountId of new Set(accountIds)) {
          const account = getAccount(accountId);
          if (!account) throw new JobError("Account not found.", "ACCOUNT_NOT_FOUND", 404);
          const metadata = refreshState(accountId);
          const add = (
            status: InventoryRefreshResult["accounts"][number]["status"],
            job: JobRow | null = null,
            nextRefreshAt: string | null = null,
          ) => {
            if (job) jobs.push(summary(job));
            accounts.push({
              accountId,
              status,
              jobId: job?.id ?? null,
              lastSyncedAt: account.lastSyncAt,
              nextRefreshAt,
            });
          };
          const manual = (job: JobRow) => {
            db.prepare("UPDATE jobs SET background=0 WHERE id=?").run(job.id);
            db.prepare(
              "UPDATE inventory_refresh_state SET manual_requested_at=?,manual_job_id=? WHERE account_id=?",
            ).run(timestamp(), job.id, accountId);
          };
          const existing = activeAccountSync(accountId);
          if (existing) {
            if (mode === "manual") manual(existing);
            add("active", existing);
            continue;
          }
          const currentTime = now().getTime();
          const lastSync = account.lastSyncAt ? Date.parse(account.lastSyncAt) : NaN;
          // A successful post-operation inventory read also repairs prior sync failures.
          if (
            account.status === "connected" &&
            Number.isFinite(lastSync) &&
            metadata.last_failure_at &&
            lastSync > Date.parse(metadata.last_failure_at)
          ) {
            db.prepare(
              "UPDATE inventory_refresh_state SET failure_count=0,last_failure_at=NULL,retry_after=NULL WHERE account_id=?",
            ).run(accountId);
            metadata.failure_count = 0;
            metadata.last_failure_at = null;
            metadata.retry_after = null;
          }
          if (mode === "auto") {
            if (metadata.retry_after && Date.parse(metadata.retry_after) > currentTime) {
              add("backoff", null, metadata.retry_after);
              continue;
            }
            if (
              account.status === "connected" &&
              Number.isFinite(lastSync) &&
              currentTime >= lastSync &&
              currentTime - lastSync < INVENTORY_FRESH_MS
            ) {
              add("fresh", null, new Date(lastSync + INVENTORY_FRESH_MS).toISOString());
              continue;
            }
          } else if (metadata.manual_requested_at && metadata.manual_job_id) {
            const requested = Date.parse(metadata.manual_requested_at);
            const prior = row(metadata.manual_job_id);
            if (
              prior &&
              currentTime >= requested &&
              currentTime - requested < MANUAL_REFRESH_THROTTLE_MS
            ) {
              add(
                "throttled",
                prior,
                new Date(requested + MANUAL_REFRESH_THROTTLE_MS).toISOString(),
              );
              continue;
            }
          }
          const created = enqueueOperation(
            { kind: "sync-account", accountId, region: account.homeRegion, payload: {} },
            requestedBy,
          );
          db.prepare("UPDATE jobs SET background=? WHERE id=?").run(
            mode === "auto" ? 1 : 0,
            created.id,
          );
          const job = required(created.id);
          if (mode === "manual") manual(job);
          add("queued", job);
        }
        return { jobs, accounts };
      })
      .immediate();
  }
  function listAccountSyncJobs(): JobSummary[] {
    return (
      db
        .prepare(
          `SELECT * FROM (
            SELECT j.*,j.rowid AS insertion_order,
              ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY
                CASE WHEN state IN ('queued','running','retrying','cancel_requested') OR
                  (state='interrupted' AND next_run_at IS NOT NULL AND (attempt<max_attempts OR waiting_for_completion=1) AND cancel_requested=0)
                  THEN 0 ELSE 1 END,
                created_at DESC,j.rowid DESC) AS account_rank
            FROM jobs j WHERE kind='sync-account'
          ) WHERE account_rank=1 ORDER BY created_at DESC,insertion_order DESC`,
        )
        .all() as JobRow[]
    ).map(summary);
  }
  function cancelJob(id: string): JobSummary {
    return db
      .transaction(() => {
        const current = required(id);
        if (!isJobCancellable(summary(current))) return summary(current);
        if (current.state === "running" || current.state === "cancel_requested") {
          if (!current.cancel_requested) {
            db.prepare(
              "UPDATE jobs SET state='cancel_requested',cancel_requested=1 WHERE id=?",
            ).run(id);
            event(
              id,
              "warning",
              "Cancellation requested; the worker will stop at a safe boundary. Completed cloud changes are not undone.",
            );
          }
        } else {
          db.prepare(
            "UPDATE jobs SET state='cancelled',cancel_requested=1,finished_at=?,next_run_at=NULL,waiting_for_completion=0 WHERE id=?",
          ).run(timestamp(), id);
          event(
            id,
            "warning",
            "Pending execution cancelled. Previously accepted cloud operations may still require reconciliation.",
          );
          recordSyncOutcome(current, "cancelled");
        }
        return summary(required(id));
      })
      .immediate();
  }
  function retryJob(id: string): JobSummary {
    return db
      .transaction(() => {
        const current = required(id);
        if (!isJobRetryable(summary(current)))
          throw new JobError(
            "Only failed, cancelled or interrupted tasks can be retried.",
            "JOB_NOT_RETRYABLE",
            409,
          );
        if (current.lease_owner)
          throw new JobError("The previous worker still owns this task.", "JOB_IS_RUNNING", 409);
        db.prepare(
          `UPDATE jobs SET state='queued',cancel_requested=0,finished_at=NULL,next_run_at=?,last_error=NULL,
        max_attempts=?,needs_reconcile=?,background=0,waiting_for_completion=0,completion_deadline_at=NULL WHERE id=?`,
        ).run(timestamp(), current.attempt + MAX_ATTEMPTS, current.attempt > 0 ? 1 : 0, id);
        event(
          id,
          "info",
          "Retry requested. Saved checkpoints will be reconciled with OCI before further changes.",
        );
        return summary(required(id));
      })
      .immediate();
  }
  function reclaimExpired(): void {
    const expired = db
      .prepare(
        "SELECT * FROM jobs WHERE state IN ('running','cancel_requested') AND lease_expires_at<=?",
      )
      .all(timestamp()) as JobRow[];
    for (const current of expired) {
      const automatic = !current.cancel_requested && canResumeJob(summary(current));
      db.prepare(
        `UPDATE jobs SET state='interrupted',lease_owner=NULL,lease_expires_at=NULL,needs_reconcile=1,
        next_run_at=?,last_error=? WHERE id=?`,
      ).run(
        automatic ? timestamp() : null,
        "The worker lease expired before the outcome was confirmed. Saved checkpoints must be reconciled with OCI.",
        current.id,
      );
      event(
        current.id,
        "warning",
        automatic
          ? "Worker lease expired; recovery is queued."
          : "Worker lease expired; automatic execution stopped and manual review is required.",
        { attempt: current.attempt },
      );
      if (!automatic) recordSyncOutcome(current, "failed");
    }
  }
  function claimNext(workerId: string, leaseMs = DEFAULT_LEASE_MS): ClaimedJob | null {
    return db
      .transaction(() => {
        reclaimExpired();
        // All schedulers share these bounds, not just one process's promise pool:
        // two account reads, one write, and no read/write overlap within an account.
        const current = db
          .prepare(
            `SELECT j.* FROM jobs j WHERE j.state IN ('queued','retrying','interrupted')
        AND j.next_run_at IS NOT NULL AND j.next_run_at<=? AND (j.attempt<j.max_attempts OR j.waiting_for_completion=1) AND j.cancel_requested=0
        AND NOT EXISTS(SELECT 1 FROM job_resources candidate JOIN job_resources occupied ON occupied.resource_key=candidate.resource_key
          JOIN jobs active ON active.id=occupied.job_id WHERE candidate.job_id=j.id AND active.state IN ('running','cancel_requested'))
        AND NOT EXISTS(SELECT 1 FROM jobs active WHERE active.state IN ('running','cancel_requested') AND (
          (j.kind<>'sync-account' AND active.kind<>'sync-account') OR
          (active.account_id=j.account_id AND (j.kind='sync-account' OR active.kind='sync-account'))
        ))
        AND (j.kind<>'sync-account' OR (SELECT COUNT(*) FROM jobs active
          WHERE active.kind='sync-account' AND active.state IN ('running','cancel_requested')) < ?)
        ORDER BY j.background,j.next_run_at,j.created_at,j.id LIMIT 1`,
          )
          .get(timestamp(), MAX_CONCURRENT_ACCOUNT_SYNCS) as JobRow | undefined;
        if (!current) return null;
        db.prepare(
          `UPDATE jobs SET state='running',attempt=attempt+CASE WHEN waiting_for_completion=1 THEN 0 ELSE 1 END,started_at=COALESCE(started_at,?),
        finished_at=NULL,next_run_at=NULL,lease_owner=?,lease_expires_at=?,
        completion_deadline_at=COALESCE(completion_deadline_at,?) WHERE id=?`,
        ).run(
          timestamp(),
          workerId,
          new Date(now().getTime() + leaseMs).toISOString(),
          current.kind === "sync-account"
            ? null
            : new Date(now().getTime() + completionTimeoutMs).toISOString(),
          current.id,
        );
        event(
          current.id,
          "info",
          current.needs_reconcile
            ? "Recovery started; reconciling saved checkpoints with OCI."
            : "Execution started.",
          { attempt: current.attempt + (current.waiting_for_completion ? 0 : 1), workerId },
        );
        const claimed = required(current.id);
        return {
          summary: summary(claimed),
          operation: JSON.parse(claimed.operation_json),
          checkpoints: JSON.parse(claimed.checkpoints_json),
          requestedBy: claimed.requested_by,
          needsReconcile: Boolean(claimed.needs_reconcile),
        };
      })
      .immediate();
  }
  function renewLease(id: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): boolean {
    return (
      db
        .prepare(
          `UPDATE jobs SET lease_expires_at=? WHERE id=? AND lease_owner=?
      AND state IN ('running','cancel_requested') AND lease_expires_at>?`,
        )
        .run(new Date(now().getTime() + leaseMs).toISOString(), id, workerId, timestamp())
        .changes === 1
    );
  }
  function checkpoint(id: string, workerId: string, key: string, value: unknown): void {
    if (
      !key ||
      key.length > 200 ||
      secretField.test(key) ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      throw new JobError("This checkpoint key cannot be persisted.", "INVALID_CHECKPOINT");
    db.transaction(() => {
      const data = JSON.parse(owned(id, workerId).checkpoints_json) as Record<string, unknown>;
      data[key] = value;
      db.prepare("UPDATE jobs SET checkpoints_json=? WHERE id=?").run(encode(data), id);
      event(id, "info", "Checkpoint saved.", { checkpoint: key });
    }).immediate();
  }
  function finish(
    id: string,
    workerId: string,
    state: "succeeded" | "failed" | "cancelled",
    result?: Record<string, unknown>,
    error?: string,
  ): void {
    db.transaction(() => {
      const current = owned(id, workerId);
      db.prepare(
        `UPDATE jobs SET state=?,result_json=?,last_error=?,finished_at=?,next_run_at=NULL,
        lease_owner=NULL,lease_expires_at=NULL,needs_reconcile=0,waiting_for_completion=0 WHERE id=?`,
      ).run(state, result ? encode(result, true) : null, error || null, timestamp(), id);
      event(
        id,
        state === "failed" ? "error" : state === "cancelled" ? "warning" : "info",
        state === "succeeded"
          ? "Task completed."
          : state === "cancelled"
            ? "Execution cancelled at a safe boundary. Cloud changes already accepted are not rolled back."
            : "Task failed.",
        error ? { error } : undefined,
      );
      recordSyncOutcome(current, state, result);
    }).immediate();
  }
  function retryLater(id: string, workerId: string, error: string, delayMs: number): void {
    db.transaction(() => {
      const current = owned(id, workerId);
      if (current.cancel_requested) {
        finish(
          id,
          workerId,
          "cancelled",
          undefined,
          "Cancellation requested before the retry was scheduled.",
        );
        return;
      }
      if (current.attempt >= current.max_attempts) {
        finish(id, workerId, "failed", undefined, error);
        return;
      }
      const due = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
      db.prepare(
        `UPDATE jobs SET state='retrying',last_error=?,next_run_at=?,needs_reconcile=1,
        lease_owner=NULL,lease_expires_at=NULL,waiting_for_completion=0 WHERE id=?`,
      ).run(error, due, id);
      event(
        id,
        "warning",
        "A retryable error occurred. The next attempt will first reconcile remote state.",
        { error, nextRunAt: due, attempt: current.attempt },
      );
    }).immediate();
  }
  function assertCompletionWindow(id: string, workerId: string): void {
    const current = owned(id, workerId);
    if (current.completion_deadline_at && current.completion_deadline_at <= timestamp())
      throw new JobError(COMPLETION_TIMEOUT_MESSAGE, "COMPLETION_TIMEOUT");
  }
  function waitForCompletion(id: string, workerId: string, message: string): void {
    db.transaction(() => {
      const current = owned(id, workerId);
      if (current.cancel_requested) {
        finish(
          id,
          workerId,
          "cancelled",
          undefined,
          "Cancellation requested while OCI was processing the operation.",
        );
        return;
      }
      // The deadline was persisted on the first claim. Reopening the database,
      // recovering a lease, or repeating a successful status read never extends it.
      const deadline =
        current.completion_deadline_at ??
        new Date(now().getTime() + completionTimeoutMs).toISOString();
      if (deadline <= timestamp()) {
        finish(id, workerId, "failed", undefined, COMPLETION_TIMEOUT_MESSAGE);
        return;
      }
      const due = new Date(Math.min(now().getTime() + 5000, Date.parse(deadline))).toISOString();
      db.prepare(
        `UPDATE jobs SET state='retrying',last_error=NULL,next_run_at=?,needs_reconcile=1,
        waiting_for_completion=1,completion_deadline_at=?,lease_owner=NULL,lease_expires_at=NULL WHERE id=?`,
      ).run(due, deadline, id);
      event(id, "info", message, {
        waitingForCompletion: true,
        nextRunAt: due,
        completionDeadlineAt: deadline,
      });
    }).immediate();
  }
  function interrupt(id: string, workerId: string, reason: string): void {
    db.transaction(() => {
      const current = owned(id, workerId);
      db.prepare(
        `UPDATE jobs SET state='interrupted',last_error=?,next_run_at=?,needs_reconcile=1,
        lease_owner=NULL,lease_expires_at=NULL WHERE id=?`,
      ).run(
        reason,
        canResumeJob(summary(current)) && !current.cancel_requested ? timestamp() : null,
        id,
      );
      event(
        id,
        "warning",
        "Worker stopped before confirming the outcome. Recovery will reconcile remote state.",
        { reason },
      );
      if (!canResumeJob(summary(current)) || current.cancel_requested)
        recordSyncOutcome(current, current.cancel_requested ? "cancelled" : "failed");
    }).immediate();
  }
  function heartbeat(workerId: string, leaseMs = DEFAULT_LEASE_MS): void {
    db.prepare(
      `INSERT INTO job_workers(id,started_at,last_heartbeat_at,lease_seconds,stopped_at) VALUES(?,?,?,?,NULL)
      ON CONFLICT(id) DO UPDATE SET last_heartbeat_at=excluded.last_heartbeat_at,lease_seconds=excluded.lease_seconds,stopped_at=NULL`,
    ).run(workerId, timestamp(), timestamp(), Math.ceil(leaseMs / 1000));
  }
  function getWorkerStatus(): WorkerStatus {
    const latest = (db
      .prepare(
        "SELECT * FROM job_workers WHERE stopped_at IS NULL ORDER BY last_heartbeat_at DESC LIMIT 1",
      )
      .get() ||
      db.prepare("SELECT * FROM job_workers ORDER BY last_heartbeat_at DESC LIMIT 1").get()) as
      | { id: string; last_heartbeat_at: string; lease_seconds: number; stopped_at: string | null }
      | undefined;
    const active = db
      .prepare(
        "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('running','cancel_requested') AND lease_expires_at>?",
      )
      .get(timestamp()) as { count: number };
    return {
      online: Boolean(
        latest &&
        !latest.stopped_at &&
        new Date(latest.last_heartbeat_at).getTime() + latest.lease_seconds * 1000 >
          now().getTime(),
      ),
      workerId: latest?.id || null,
      lastHeartbeatAt: latest?.last_heartbeat_at || null,
      activeJobs: active.count,
      leaseSeconds: latest?.lease_seconds || DEFAULT_LEASE_MS / 1000,
    };
  }
  return {
    enqueueOperation,
    enqueueAccountSync,
    refreshInventory,
    listAccountSyncJobs,
    cancelJob,
    retryJob,
    claimNext,
    renewLease,
    checkpoint,
    finish,
    retryLater,
    waitForCompletion,
    assertCompletionWindow,
    interrupt,
    heartbeat,
    getWorkerStatus,
    getAccount,
    stopWorker(workerId: string) {
      db.prepare("UPDATE job_workers SET stopped_at=? WHERE id=?").run(timestamp(), workerId);
    },
    getJob(id: string): JobSummary | null {
      const found = row(id);
      return found ? summary(found) : null;
    },
    listJobs(limit = 100): JobSummary[] {
      return (
        db
          .prepare("SELECT * FROM jobs WHERE background=0 ORDER BY created_at DESC,id DESC LIMIT ?")
          .all(
            Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : 100))),
          ) as JobRow[]
      ).map(summary);
    },
    queryJobs(input: JobListQuery): JobPage {
      const conditions = ["background=0"];
      const values: (string | number)[] = [];
      for (const [column, value] of [
        ["account_id", input.accountId],
        ["resource_id", input.resourceId],
        ["state", input.state],
      ]) {
        if (value) {
          conditions.push(`${column}=?`);
          values.push(value);
        }
      }
      if (input.query) {
        conditions.push(
          `job_search_includes(id || ' ' || ${labelCase} || ' ' || account_name || ' ' || COALESCE(resource_id,'') || ' ' || COALESCE(last_error,''), ?)`,
        );
        values.push(input.query);
      }
      const where = conditions.join(" AND ");
      const order = input.sort === "ascending" ? "ASC" : "DESC";
      return db.transaction(() => {
        const total = db
          .prepare(`SELECT count(*) FROM jobs WHERE ${where}`)
          .pluck()
          .get(...values) as number;
        const pageSize = Math.max(1, Math.min(100, input.pageSize));
        const page = Math.max(1, Math.min(input.page, Math.max(1, Math.ceil(total / pageSize))));
        const rows = db
          .prepare(
            `SELECT * FROM jobs WHERE ${where} ORDER BY created_at ${order},id ${order} LIMIT ? OFFSET ?`,
          )
          .all(...values, pageSize, (page - 1) * pageSize) as JobRow[];
        return { jobs: rows.map(summary), total, page, pageSize };
      })();
    },
    listActiveJobs(): JobSummary[] {
      return (
        db
          .prepare(
            `
        SELECT j.* FROM jobs j WHERE j.background=0 AND (
          ${pendingCondition("j")} OR (
            j.state='succeeded' AND EXISTS (
              SELECT 1 FROM jobs sync
              WHERE sync.id=json_extract(j.result_json,'$.synchronization.jobId')
                AND sync.account_id=j.account_id
                AND sync.kind='sync-account'
                AND json_extract(j.result_json,'$.synchronization.status')='queued'
                AND ${pendingCondition("sync")}
            )
          )
        ) ORDER BY j.created_at DESC,j.id DESC
      `,
          )
          .all() as JobRow[]
      ).map(summary);
    },
    getJobEvents(id: string): JobEvent[] {
      required(id);
      return (
        db.prepare("SELECT * FROM job_events WHERE job_id=? ORDER BY id").all(id) as {
          id: number;
          job_id: string;
          level: JobEvent["level"];
          message: string;
          detail_json: string | null;
          created_at: string;
        }[]
      ).map((e) => ({
        id: e.id,
        jobId: e.job_id,
        level: e.level,
        message: e.message,
        detail: e.detail_json ? JSON.parse(e.detail_json) : null,
        createdAt: e.created_at,
      }));
    },
    cancellationRequested(id: string): boolean {
      return Boolean(required(id).cancel_requested);
    },
    progress(id: string, workerId: string, message: string, detail?: Record<string, unknown>) {
      db.transaction(() => {
        owned(id, workerId);
        event(id, "info", message, detail);
      }).immediate();
    },
    warning(id: string, workerId: string, message: string, detail?: Record<string, unknown>) {
      db.transaction(() => {
        owned(id, workerId);
        event(id, "warning", message, detail);
      }).immediate();
    },
    assertLease(id: string, workerId: string) {
      owned(id, workerId);
    },
    withActiveLease(id: string, workerId: string, action: () => void): boolean {
      return db
        .transaction(() => {
          const current = owned(id, workerId);
          if (current.cancel_requested) return false;
          action();
          return true;
        })
        .immediate();
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
