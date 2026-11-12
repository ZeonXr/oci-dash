import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  and,
  asc,
  count,
  desc,
  DrizzleQueryError,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { ormFor } from "../database/client";
import {
  jobs as jobTable,
  jobEvents,
  jobResources,
  jobWorkers,
  inventoryRefreshState,
} from "../database/schema";
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
type PendingColumns = {
  [
    Key in "state" | "nextRunAt" | "waitingForCompletion" | "attempt" | "maxAttempts"
  ]: AnySQLiteColumn;
};
const pendingCondition = (table: PendingColumns) =>
  or(
    inArray(table.state, ["queued", "running", "retrying", "cancel_requested"]),
    and(
      eq(table.state, "interrupted"),
      isNotNull(table.nextRunAt),
      or(eq(table.waitingForCompletion, 1), lt(table.attempt, table.maxAttempts)),
    ),
  )!;
const labelCase = sql<string>`CASE ${jobTable.kind} ${sql.join(
  Object.entries(operationLabels).map(([kind, label]) => sql`WHEN ${kind} THEN ${label}`),
  sql` `,
)} ELSE ${jobTable.kind} END`;

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

type JobRow = typeof jobTable.$inferSelect;
type InventoryRefreshRow = typeof inventoryRefreshState.$inferSelect;
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
    accountId: r.accountId,
    accountName: r.accountName,
    region: r.region,
    resourceId: r.resourceId,
    state: r.state,
    attempt: r.attempt,
    maxAttempts: r.maxAttempts,
    waitingForCompletion: Boolean(r.waitingForCompletion),
    completionDeadlineAt: r.completionDeadlineAt,
    createdAt: r.createdAt,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    nextRunAt: r.nextRunAt,
    lastError: r.lastError,
    result: r.resultJson ? JSON.parse(r.resultJson) : null,
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
  const orm = ormFor(db);
  const timestamp = () => now().toISOString();
  const row = (id: string) => orm.select().from(jobTable).where(eq(jobTable.id, id)).get();
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
    orm
      .insert(jobEvents)
      .values({
        jobId: id,
        level,
        message: safeErrorMessage(new Error(message)),
        detailJson: detail ? encode(detail, true, 64_000) : null,
        createdAt: timestamp(),
      })
      .run();
  }
  function owned(id: string, workerId: string): JobRow {
    const found = required(id);
    if (
      found.leaseOwner !== workerId ||
      !found.leaseExpiresAt ||
      found.leaseExpiresAt <= timestamp() ||
      !["running", "cancel_requested"].includes(found.state)
    )
      throw new LeaseLostError();
    return found;
  }
  function activeAccountSync(accountId: string): JobRow | undefined {
    return orm
      .select()
      .from(jobTable)
      .where(
        and(
          eq(jobTable.accountId, accountId),
          eq(jobTable.kind, "sync-account"),
          eq(jobTable.cancelRequested, 0),
          or(
            inArray(jobTable.state, ["queued", "running", "retrying"]),
            and(
              eq(jobTable.state, "interrupted"),
              isNotNull(jobTable.nextRunAt),
              or(lt(jobTable.attempt, jobTable.maxAttempts), eq(jobTable.waitingForCompletion, 1)),
            ),
          ),
        ),
      )
      .orderBy(desc(jobTable.createdAt), desc(sql`${jobTable}.rowid`))
      .limit(1)
      .get();
  }
  function refreshState(accountId: string): InventoryRefreshRow {
    orm.insert(inventoryRefreshState).values({ accountId }).onConflictDoNothing().run();
    return orm
      .select()
      .from(inventoryRefreshState)
      .where(eq(inventoryRefreshState.accountId, accountId))
      .get()!;
  }
  function pruneAutomaticHistory(accountId: string): void {
    // Retain the latest finished automatic refresh and every live or explicit task.
    const obsolete = orm
      .select({ id: jobTable.id })
      .from(jobTable)
      .where(
        and(
          eq(jobTable.accountId, accountId),
          eq(jobTable.kind, "sync-account"),
          eq(jobTable.background, 1),
          isNull(jobTable.leaseOwner),
          or(
            inArray(jobTable.state, ["succeeded", "failed", "cancelled"]),
            and(eq(jobTable.state, "interrupted"), isNull(jobTable.nextRunAt)),
          ),
        ),
      )
      .orderBy(
        desc(sql`coalesce(${jobTable.finishedAt}, ${jobTable.createdAt})`),
        desc(sql`${jobTable}.rowid`),
      )
      // SQLite's unlimited limit must be bound; Drizzle omits negative literals.
      .limit(sql.placeholder("historyLimit"))
      .offset(1)
      .all({ historyLimit: -1 });
    for (const { id } of obsolete) {
      orm.delete(jobEvents).where(eq(jobEvents.jobId, id)).run();
      orm.delete(jobResources).where(eq(jobResources.jobId, id)).run();
      orm.delete(jobTable).where(eq(jobTable.id, id)).run();
    }
  }
  function recordSyncOutcome(
    job: JobRow,
    state: "succeeded" | "failed" | "cancelled",
    result?: Record<string, unknown>,
  ): void {
    if (job.kind !== "sync-account") return;
    const previous = refreshState(job.accountId);
    const partial =
      state === "succeeded" && Array.isArray(result?.warnings) && result.warnings.length > 0;
    if (state === "succeeded" && !partial) {
      orm
        .update(inventoryRefreshState)
        .set({ failureCount: 0, lastFailureAt: null, retryAfter: null })
        .where(eq(inventoryRefreshState.accountId, job.accountId))
        .run();
    } else {
      const failures =
        state === "cancelled" ? previous.failureCount : Math.min(previous.failureCount + 1, 32);
      const wait =
        state === "cancelled"
          ? INVENTORY_FRESH_MS
          : Math.min(
              AUTO_REFRESH_BACKOFF_MAX_MS,
              INVENTORY_FRESH_MS * 2 ** Math.max(0, failures - 1),
            );
      orm
        .update(inventoryRefreshState)
        .set({
          failureCount: failures,
          lastFailureAt: timestamp(),
          retryAfter: new Date(now().getTime() + wait).toISOString(),
        })
        .where(eq(inventoryRefreshState.accountId, job.accountId))
        .run();
    }
    pruneAutomaticHistory(job.accountId);
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
          const previous = orm
            .select()
            .from(jobTable)
            .where(and(eq(jobTable.accountId, account.id), eq(jobTable.idempotencyKey, key)))
            .get();
          if (previous) {
            if (previous.payloadHash !== hash)
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
        orm
          .insert(jobTable)
          .values({
            id,
            kind: operation.kind,
            accountId: account.id,
            accountName: account.name,
            region: operation.region,
            resourceId: operation.resourceId || null,
            resourceLock: `${account.id}:${resource}`,
            state: "queued",
            maxAttempts: MAX_ATTEMPTS,
            createdAt: created,
            nextRunAt: created,
            operationJson: serialized,
            requestedBy,
            idempotencyKey: key,
            payloadHash: hash,
          })
          .run();
        for (const resourceKey of resourceKeys(normalized))
          orm.insert(jobResources).values({ jobId: id, resourceKey }).run();
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
          orm.update(jobTable).set({ background: 0 }).where(eq(jobTable.id, existing.id)).run();
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
            orm.update(jobTable).set({ background: 0 }).where(eq(jobTable.id, job.id)).run();
            orm
              .update(inventoryRefreshState)
              .set({ manualRequestedAt: timestamp(), manualJobId: job.id })
              .where(eq(inventoryRefreshState.accountId, accountId))
              .run();
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
            metadata.lastFailureAt &&
            lastSync > Date.parse(metadata.lastFailureAt)
          ) {
            orm
              .update(inventoryRefreshState)
              .set({ failureCount: 0, lastFailureAt: null, retryAfter: null })
              .where(eq(inventoryRefreshState.accountId, accountId))
              .run();
            metadata.failureCount = 0;
            metadata.lastFailureAt = null;
            metadata.retryAfter = null;
          }
          if (mode === "auto") {
            if (metadata.retryAfter && Date.parse(metadata.retryAfter) > currentTime) {
              add("backoff", null, metadata.retryAfter);
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
          } else if (metadata.manualRequestedAt && metadata.manualJobId) {
            const requested = Date.parse(metadata.manualRequestedAt);
            const prior = row(metadata.manualJobId);
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
          orm
            .update(jobTable)
            .set({ background: mode === "auto" ? 1 : 0 })
            .where(eq(jobTable.id, created.id))
            .run();
          const job = required(created.id);
          if (mode === "manual") manual(job);
          add("queued", job);
        }
        return { jobs, accounts };
      })
      .immediate();
  }
  function listAccountSyncJobs(): JobSummary[] {
    const priority = or(
      inArray(jobTable.state, ["queued", "running", "retrying", "cancel_requested"]),
      and(
        eq(jobTable.state, "interrupted"),
        isNotNull(jobTable.nextRunAt),
        or(lt(jobTable.attempt, jobTable.maxAttempts), eq(jobTable.waitingForCompletion, 1)),
        eq(jobTable.cancelRequested, 0),
      ),
    );
    const ranked = orm
      .select({
        ...getTableColumns(jobTable),
        insertionOrder: sql<number>`${jobTable}.rowid`.as("insertion_order"),
        accountRank:
          sql<number>`row_number() over (partition by ${jobTable.accountId} order by case when ${priority} then 0 else 1 end, ${jobTable.createdAt} desc, ${jobTable}.rowid desc)`.as(
            "account_rank",
          ),
      })
      .from(jobTable)
      .where(eq(jobTable.kind, "sync-account"))
      .as("ranked_sync");
    return orm
      .select()
      .from(ranked)
      .where(eq(ranked.accountRank, 1))
      .orderBy(desc(ranked.createdAt), desc(ranked.insertionOrder))
      .all()
      .map(summary);
  }
  function cancelJob(id: string): JobSummary {
    return db
      .transaction(() => {
        const current = required(id);
        if (!isJobCancellable(summary(current))) return summary(current);
        if (current.state === "running" || current.state === "cancel_requested") {
          if (!current.cancelRequested) {
            orm
              .update(jobTable)
              .set({ state: "cancel_requested", cancelRequested: 1 })
              .where(eq(jobTable.id, id))
              .run();
            event(
              id,
              "warning",
              "Cancellation requested; the worker will stop at a safe boundary. Completed cloud changes are not undone.",
            );
          }
        } else {
          orm
            .update(jobTable)
            .set({
              state: "cancelled",
              cancelRequested: 1,
              finishedAt: timestamp(),
              nextRunAt: null,
              waitingForCompletion: 0,
            })
            .where(eq(jobTable.id, id))
            .run();
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
        if (current.leaseOwner)
          throw new JobError("The previous worker still owns this task.", "JOB_IS_RUNNING", 409);
        orm
          .update(jobTable)
          .set({
            state: "queued",
            cancelRequested: 0,
            finishedAt: null,
            nextRunAt: timestamp(),
            lastError: null,
            maxAttempts: current.attempt + MAX_ATTEMPTS,
            needsReconcile: current.attempt > 0 ? 1 : 0,
            background: 0,
            waitingForCompletion: 0,
            completionDeadlineAt: null,
          })
          .where(eq(jobTable.id, id))
          .run();
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
    const expired = orm
      .select()
      .from(jobTable)
      .where(
        and(
          inArray(jobTable.state, ["running", "cancel_requested"]),
          lte(jobTable.leaseExpiresAt, timestamp()),
        ),
      )
      .all();
    for (const current of expired) {
      const automatic = !current.cancelRequested && canResumeJob(summary(current));
      orm
        .update(jobTable)
        .set({
          state: "interrupted",
          leaseOwner: null,
          leaseExpiresAt: null,
          needsReconcile: 1,
          nextRunAt: automatic ? timestamp() : null,
          lastError:
            "The worker lease expired before the outcome was confirmed. Saved checkpoints must be reconciled with OCI.",
        })
        .where(eq(jobTable.id, current.id))
        .run();
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
        // The transaction shares resource locks and concurrency bounds across all schedulers.
        const active = alias(jobTable, "active_jobs");
        const candidate = alias(jobResources, "candidate_resources");
        const occupied = alias(jobResources, "occupied_resources");
        const resourceConflict = orm
          .select({ id: candidate.jobId })
          .from(candidate)
          .innerJoin(occupied, eq(occupied.resourceKey, candidate.resourceKey))
          .innerJoin(active, eq(active.id, occupied.jobId))
          .where(
            and(
              eq(candidate.jobId, jobTable.id),
              ne(active.id, jobTable.id),
              // Claimed work owns its resources through backoff and automatic recovery.
              ne(active.state, "queued"),
              pendingCondition(active),
            ),
          );
        const accountConflict = orm
          .select({ id: active.id })
          .from(active)
          .where(
            and(
              inArray(active.state, ["running", "cancel_requested"]),
              or(
                and(ne(jobTable.kind, "sync-account"), ne(active.kind, "sync-account")),
                and(
                  eq(active.accountId, jobTable.accountId),
                  or(eq(jobTable.kind, "sync-account"), eq(active.kind, "sync-account")),
                ),
              ),
            ),
          );
        const activeSyncs = orm
          .select({ total: count() })
          .from(active)
          .where(
            and(
              eq(active.kind, "sync-account"),
              inArray(active.state, ["running", "cancel_requested"]),
            ),
          );
        const current = orm
          .select()
          .from(jobTable)
          .where(
            and(
              inArray(jobTable.state, ["queued", "retrying", "interrupted"]),
              isNotNull(jobTable.nextRunAt),
              lte(jobTable.nextRunAt, timestamp()),
              or(lt(jobTable.attempt, jobTable.maxAttempts), eq(jobTable.waitingForCompletion, 1)),
              eq(jobTable.cancelRequested, 0),
              notExists(resourceConflict),
              notExists(accountConflict),
              or(
                ne(jobTable.kind, "sync-account"),
                lt(sql<number>`(${activeSyncs})`, MAX_CONCURRENT_ACCOUNT_SYNCS),
              ),
            ),
          )
          .orderBy(jobTable.background, jobTable.nextRunAt, jobTable.createdAt, jobTable.id)
          .limit(1)
          .get();
        if (!current) return null;
        orm
          .update(jobTable)
          .set({
            state: "running",
            attempt: sql`${jobTable.attempt}+case when ${jobTable.waitingForCompletion}=1 then 0 else 1 end`,
            startedAt: sql`coalesce(${jobTable.startedAt},${timestamp()})`,
            finishedAt: null,
            nextRunAt: null,
            leaseOwner: workerId,
            leaseExpiresAt: new Date(now().getTime() + leaseMs).toISOString(),
            completionDeadlineAt: sql`coalesce(${jobTable.completionDeadlineAt},${current.kind === "sync-account" ? null : new Date(now().getTime() + completionTimeoutMs).toISOString()})`,
          })
          .where(eq(jobTable.id, current.id))
          .run();
        event(
          current.id,
          "info",
          current.needsReconcile
            ? "Recovery started; reconciling saved checkpoints with OCI."
            : "Execution started.",
          { attempt: current.attempt + (current.waitingForCompletion ? 0 : 1), workerId },
        );
        const claimed = required(current.id);
        return {
          summary: summary(claimed),
          operation: JSON.parse(claimed.operationJson),
          checkpoints: JSON.parse(claimed.checkpointsJson),
          requestedBy: claimed.requestedBy,
          needsReconcile: Boolean(claimed.needsReconcile),
        };
      })
      .immediate();
  }
  function renewLease(id: string, workerId: string, leaseMs = DEFAULT_LEASE_MS): boolean {
    return (
      orm
        .update(jobTable)
        .set({ leaseExpiresAt: new Date(now().getTime() + leaseMs).toISOString() })
        .where(
          and(
            eq(jobTable.id, id),
            eq(jobTable.leaseOwner, workerId),
            inArray(jobTable.state, ["running", "cancel_requested"]),
            gt(jobTable.leaseExpiresAt, timestamp()),
          ),
        )
        .run().changes === 1
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
      const data = JSON.parse(owned(id, workerId).checkpointsJson) as Record<string, unknown>;
      data[key] = value;
      orm
        .update(jobTable)
        .set({ checkpointsJson: encode(data) })
        .where(eq(jobTable.id, id))
        .run();
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
      orm
        .update(jobTable)
        .set({
          state,
          resultJson: result ? encode(result, true) : null,
          lastError: error || null,
          finishedAt: timestamp(),
          nextRunAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          needsReconcile: 0,
          waitingForCompletion: 0,
        })
        .where(eq(jobTable.id, id))
        .run();
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
      if (current.cancelRequested) {
        finish(
          id,
          workerId,
          "cancelled",
          undefined,
          "Cancellation requested before the retry was scheduled.",
        );
        return;
      }
      if (current.attempt >= current.maxAttempts) {
        finish(id, workerId, "failed", undefined, error);
        return;
      }
      const due = new Date(now().getTime() + Math.max(0, delayMs)).toISOString();
      orm
        .update(jobTable)
        .set({
          state: "retrying",
          lastError: error,
          nextRunAt: due,
          needsReconcile: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
          waitingForCompletion: 0,
        })
        .where(eq(jobTable.id, id))
        .run();
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
    if (current.completionDeadlineAt && current.completionDeadlineAt <= timestamp())
      throw new JobError(COMPLETION_TIMEOUT_MESSAGE, "COMPLETION_TIMEOUT");
  }
  function waitForCompletion(id: string, workerId: string, message: string): void {
    db.transaction(() => {
      const current = owned(id, workerId);
      if (current.cancelRequested) {
        finish(
          id,
          workerId,
          "cancelled",
          undefined,
          "Cancellation requested while OCI was processing the operation.",
        );
        return;
      }
      // Reopening, lease recovery and successful status reads never extend the saved deadline.
      const deadline =
        current.completionDeadlineAt ??
        new Date(now().getTime() + completionTimeoutMs).toISOString();
      if (deadline <= timestamp()) {
        finish(id, workerId, "failed", undefined, COMPLETION_TIMEOUT_MESSAGE);
        return;
      }
      const due = new Date(Math.min(now().getTime() + 5000, Date.parse(deadline))).toISOString();
      orm
        .update(jobTable)
        .set({
          state: "retrying",
          lastError: null,
          nextRunAt: due,
          needsReconcile: 1,
          waitingForCompletion: 1,
          completionDeadlineAt: deadline,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(jobTable.id, id))
        .run();
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
      orm
        .update(jobTable)
        .set({
          state: "interrupted",
          lastError: reason,
          nextRunAt:
            canResumeJob(summary(current)) && !current.cancelRequested ? timestamp() : null,
          needsReconcile: 1,
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(jobTable.id, id))
        .run();
      event(
        id,
        "warning",
        "Worker stopped before confirming the outcome. Recovery will reconcile remote state.",
        { reason },
      );
      if (!canResumeJob(summary(current)) || current.cancelRequested)
        recordSyncOutcome(current, current.cancelRequested ? "cancelled" : "failed");
    }).immediate();
  }
  function heartbeat(workerId: string, leaseMs = DEFAULT_LEASE_MS): void {
    const time = timestamp(),
      leaseSeconds = Math.ceil(leaseMs / 1000);
    orm
      .insert(jobWorkers)
      .values({
        id: workerId,
        startedAt: time,
        lastHeartbeatAt: time,
        leaseSeconds,
        stoppedAt: null,
      })
      .onConflictDoUpdate({
        target: jobWorkers.id,
        set: { lastHeartbeatAt: time, leaseSeconds, stoppedAt: null },
      })
      .run();
  }
  function getWorkerStatus(): WorkerStatus {
    const latest =
      orm
        .select()
        .from(jobWorkers)
        .where(isNull(jobWorkers.stoppedAt))
        .orderBy(desc(jobWorkers.lastHeartbeatAt))
        .limit(1)
        .get() ||
      orm.select().from(jobWorkers).orderBy(desc(jobWorkers.lastHeartbeatAt)).limit(1).get();
    const active = orm
      .select({ total: count() })
      .from(jobTable)
      .where(
        and(
          inArray(jobTable.state, ["running", "cancel_requested"]),
          gt(jobTable.leaseExpiresAt, timestamp()),
        ),
      )
      .get()!;
    return {
      online: Boolean(
        latest &&
        !latest.stoppedAt &&
        Date.parse(latest.lastHeartbeatAt) + latest.leaseSeconds * 1000 > now().getTime(),
      ),
      workerId: latest?.id || null,
      lastHeartbeatAt: latest?.lastHeartbeatAt || null,
      activeJobs: active.total,
      leaseSeconds: latest?.leaseSeconds || DEFAULT_LEASE_MS / 1000,
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
      orm
        .update(jobWorkers)
        .set({ stoppedAt: timestamp() })
        .where(eq(jobWorkers.id, workerId))
        .run();
    },
    getJob(id: string): JobSummary | null {
      const found = row(id);
      return found ? summary(found) : null;
    },
    listJobs(limit = 100): JobSummary[] {
      return orm
        .select()
        .from(jobTable)
        .where(eq(jobTable.background, 0))
        .orderBy(desc(jobTable.createdAt), desc(jobTable.id))
        .limit(Math.max(1, Math.min(1000, Math.floor(Number.isFinite(limit) ? limit : 100))))
        .all()
        .map(summary);
    },
    queryJobs(input: JobListQuery): JobPage {
      const conditions: SQL[] = [eq(jobTable.background, 0)];
      if (input.accountId) conditions.push(eq(jobTable.accountId, input.accountId));
      if (input.resourceId) conditions.push(eq(jobTable.resourceId, input.resourceId));
      if (input.state) conditions.push(eq(jobTable.state, input.state));
      if (input.query)
        conditions.push(
          sql`job_search_includes(${jobTable.id} || ' ' || ${labelCase} || ' ' || ${jobTable.accountName} || ' ' || coalesce(${jobTable.resourceId},'') || ' ' || coalesce(${jobTable.lastError},''), ${input.query})`,
        );
      const where = and(...conditions),
        order = input.sort === "ascending" ? asc : desc;
      return db.transaction(() => {
        const total = orm.select({ total: count() }).from(jobTable).where(where).get()!.total;
        const pageSize = Math.max(1, Math.min(100, input.pageSize));
        const page = Math.max(1, Math.min(input.page, Math.max(1, Math.ceil(total / pageSize))));
        const rows = orm
          .select()
          .from(jobTable)
          .where(where)
          .orderBy(order(jobTable.createdAt), order(jobTable.id))
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .all();
        return { jobs: rows.map(summary), total, page, pageSize };
      })();
    },
    listActiveJobs(): JobSummary[] {
      const sync = alias(jobTable, "following_sync");
      const followup = orm
        .select({ id: sync.id })
        .from(sync)
        .where(
          and(
            eq(
              sync.id,
              sql<string>`json_extract(${jobTable.resultJson},'$.synchronization.jobId')`,
            ),
            eq(sync.accountId, jobTable.accountId),
            eq(sync.kind, "sync-account"),
            sql`json_extract(${jobTable.resultJson},'$.synchronization.status')='queued'`,
            pendingCondition(sync),
          ),
        );
      return orm
        .select()
        .from(jobTable)
        .where(
          and(
            eq(jobTable.background, 0),
            or(pendingCondition(jobTable), and(eq(jobTable.state, "succeeded"), exists(followup))),
          ),
        )
        .orderBy(desc(jobTable.createdAt), desc(jobTable.id))
        .all()
        .map(summary);
    },
    getJobEvents(id: string): JobEvent[] {
      required(id);
      return orm
        .select()
        .from(jobEvents)
        .where(eq(jobEvents.jobId, id))
        .orderBy(jobEvents.id)
        .all()
        .map((e) => ({
          id: e.id,
          jobId: e.jobId,
          level: e.level,
          message: e.message,
          detail: e.detailJson ? JSON.parse(e.detailJson) : null,
          createdAt: e.createdAt,
        }));
    },
    cancellationRequested(id: string): boolean {
      return Boolean(required(id).cancelRequested);
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
          if (current.cancelRequested) return false;
          action();
          return true;
        })
        .immediate();
    },
  };
}
export type JobStore = ReturnType<typeof createJobStore>;
