import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  AccountSummary,
  JobEvent,
  JobState,
  JobSummary,
  OperationKind,
  OperationRequest,
} from "@/lib/contracts";

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
const terminal = new Set<JobState>(["succeeded", "failed", "cancelled"]);
const MAX_ATTEMPTS = 4;
export const DEFAULT_LEASE_MS = 30_000;
const PRIVATE_KEY = /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g;
const secretField =
  /(?:private[_-]?key|password|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret|^secret$|^credentials?$|^cookies?$)/i;

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
  let message = error instanceof Error ? error.message : "The operation could not be completed.";
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
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    nextRunAt: r.next_run_at,
    lastError: r.last_error,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  };
}
function resourceKeys(operation: OperationRequest): string[] {
  const keys = [
    `${operation.accountId}:${operation.resourceId || `${operation.kind}:${operation.region}`}`,
  ];
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
export function ensureJobSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
      region TEXT NOT NULL, resource_id TEXT, resource_lock TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','running','retrying','succeeded','failed','cancel_requested','cancelled','interrupted')),
      attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 4,
      created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, next_run_at TEXT, last_error TEXT,
      result_json TEXT, operation_json TEXT NOT NULL, requested_by TEXT NOT NULL,
      idempotency_key TEXT, payload_hash TEXT NOT NULL, checkpoints_json TEXT NOT NULL DEFAULT '{}',
      lease_owner TEXT, lease_expires_at TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
      needs_reconcile INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_idempotency ON jobs(account_id,idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(state,next_run_at,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_active_resource ON jobs(resource_lock) WHERE state IN ('running','cancel_requested');
    CREATE TABLE IF NOT EXISTS job_resources (
      job_id TEXT NOT NULL REFERENCES jobs(id), resource_key TEXT NOT NULL, PRIMARY KEY(job_id,resource_key)
    );
    CREATE INDEX IF NOT EXISTS job_resources_resource ON job_resources(resource_key,job_id);
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
      level TEXT NOT NULL, message TEXT NOT NULL, detail_json TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS job_events_job ON job_events(job_id,id);
    CREATE TABLE IF NOT EXISTS job_workers (
      id TEXT PRIMARY KEY, started_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL,
      lease_seconds INTEGER NOT NULL, stopped_at TEXT
    );
  `);
  // Backfill locks for jobs saved before a worker was started or after a schema upgrade.
  db.transaction(() => {
    const insert = db.prepare(
      "INSERT OR IGNORE INTO job_resources(job_id,resource_key) VALUES(?,?)",
    );
    for (const job of db.prepare("SELECT id,operation_json FROM jobs").all() as {
      id: string;
      operation_json: string;
    }[]) {
      for (const key of resourceKeys(JSON.parse(job.operation_json) as OperationRequest))
        insert.run(job.id, key);
    }
  }).immediate();
}

export function createJobStore({ db, getAccount, now = () => new Date() }: JobStoreOptions) {
  ensureJobSchema(db);
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
        const resource = operation.resourceId || `${operation.kind}:${operation.region}`;
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
  function cancelJob(id: string): JobSummary {
    return db
      .transaction(() => {
        const current = required(id);
        if (terminal.has(current.state)) return summary(current);
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
            "UPDATE jobs SET state='cancelled',cancel_requested=1,finished_at=?,next_run_at=NULL WHERE id=?",
          ).run(timestamp(), id);
          event(
            id,
            "warning",
            "Pending execution cancelled. Previously accepted cloud operations may still require reconciliation.",
          );
        }
        return summary(required(id));
      })
      .immediate();
  }
  function retryJob(id: string): JobSummary {
    return db
      .transaction(() => {
        const current = required(id);
        if (!["failed", "cancelled", "interrupted"].includes(current.state))
          throw new JobError(
            "Only failed, cancelled or interrupted tasks can be retried.",
            "JOB_NOT_RETRYABLE",
            409,
          );
        if (current.lease_owner)
          throw new JobError("The previous worker still owns this task.", "JOB_IS_RUNNING", 409);
        db.prepare(
          `UPDATE jobs SET state='queued',cancel_requested=0,finished_at=NULL,next_run_at=?,last_error=NULL,
        max_attempts=?,needs_reconcile=? WHERE id=?`,
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
      const automatic = !current.cancel_requested && current.attempt < current.max_attempts;
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
    }
  }
  function claimNext(workerId: string, leaseMs = DEFAULT_LEASE_MS): ClaimedJob | null {
    return db
      .transaction(() => {
        reclaimExpired();
        const current = db
          .prepare(
            `SELECT j.* FROM jobs j WHERE j.state IN ('queued','retrying','interrupted')
        AND j.next_run_at IS NOT NULL AND j.next_run_at<=? AND j.attempt<j.max_attempts AND j.cancel_requested=0
        AND NOT EXISTS(SELECT 1 FROM job_resources candidate JOIN job_resources occupied ON occupied.resource_key=candidate.resource_key
          JOIN jobs active ON active.id=occupied.job_id WHERE candidate.job_id=j.id AND active.state IN ('running','cancel_requested'))
        ORDER BY j.next_run_at,j.created_at,j.id LIMIT 1`,
          )
          .get(timestamp()) as JobRow | undefined;
        if (!current) return null;
        db.prepare(
          `UPDATE jobs SET state='running',attempt=attempt+1,started_at=COALESCE(started_at,?),
        finished_at=NULL,next_run_at=NULL,lease_owner=?,lease_expires_at=? WHERE id=?`,
        ).run(timestamp(), workerId, new Date(now().getTime() + leaseMs).toISOString(), current.id);
        event(
          current.id,
          "info",
          current.needs_reconcile
            ? "Recovery started; reconciling saved checkpoints with OCI."
            : "Execution started.",
          { attempt: current.attempt + 1, workerId },
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
      owned(id, workerId);
      db.prepare(
        `UPDATE jobs SET state=?,result_json=?,last_error=?,finished_at=?,next_run_at=NULL,
        lease_owner=NULL,lease_expires_at=NULL,needs_reconcile=0 WHERE id=?`,
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
        lease_owner=NULL,lease_expires_at=NULL WHERE id=?`,
      ).run(error, due, id);
      event(
        id,
        "warning",
        "A retryable error occurred. The next attempt will first reconcile remote state.",
        { error, nextRunAt: due, attempt: current.attempt },
      );
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
        current.attempt < current.max_attempts && !current.cancel_requested ? timestamp() : null,
        id,
      );
      event(
        id,
        "warning",
        "Worker stopped before confirming the outcome. Recovery will reconcile remote state.",
        { reason },
      );
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
    cancelJob,
    retryJob,
    claimNext,
    renewLease,
    checkpoint,
    finish,
    retryLater,
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
          .prepare("SELECT * FROM jobs ORDER BY created_at DESC,id DESC LIMIT ?")
          .all(
            Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : 100))),
          ) as JobRow[]
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
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
