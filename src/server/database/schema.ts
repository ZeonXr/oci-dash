import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { OperationKind } from "../../lib/contracts";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  mfaSecret: text("mfa_secret"),
  mfaPending: text("mfa_pending"),
  mfaPendingExpires: text("mfa_pending_expires"),
  recoveryCodes: text("recovery_codes").notNull().default("[]"),
  lastOtpStep: integer("last_otp_step").notNull().default(-1),
  createdAt: text("created_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("sessions_expiry").on(table.expiresAt)],
);

export const loginAttempts = sqliteTable("login_attempts", {
  subject: text("subject").primaryKey(),
  count: integer("count").notNull(),
  windowStart: integer("window_start").notNull(),
});

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tenancyId: text("tenancy_id").notNull(),
  userId: text("user_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  homeRegion: text("home_region").notNull(),
  regions: text("regions").notNull(),
  credential: text("credential").notNull(),
  status: text("status", { enum: ["unchecked", "connected", "error"] })
    .notNull()
    .default("unchecked"),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  revision: integer("revision").notNull().default(0),
  nameSource: text("name_source", { enum: ["custom", "pending", "tenancy"] })
    .notNull()
    .default("custom"),
});

export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    region: text("region").notNull(),
    data: text("data").notNull(),
    syncedAt: text("synced_at").notNull(),
  },
  (table) => [index("resources_account").on(table.accountId)],
);

export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  result: text("result").notNull(),
  createdAt: text("created_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull().$type<OperationKind>(),
    accountId: text("account_id").notNull(),
    accountName: text("account_name").notNull(),
    region: text("region").notNull(),
    resourceId: text("resource_id"),
    resourceLock: text("resource_lock").notNull(),
    state: text("state", {
      enum: [
        "queued",
        "running",
        "retrying",
        "succeeded",
        "failed",
        "cancel_requested",
        "cancelled",
        "interrupted",
      ],
    }).notNull(),
    attempt: integer("attempt").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(4),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    nextRunAt: text("next_run_at"),
    lastError: text("last_error"),
    resultJson: text("result_json"),
    operationJson: text("operation_json").notNull(),
    requestedBy: text("requested_by").notNull(),
    idempotencyKey: text("idempotency_key"),
    payloadHash: text("payload_hash").notNull(),
    checkpointsJson: text("checkpoints_json").notNull().default("{}"),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    cancelRequested: integer("cancel_requested").notNull().default(0),
    needsReconcile: integer("needs_reconcile").notNull().default(0),
    background: integer("background").notNull().default(0),
    waitingForCompletion: integer("waiting_for_completion").notNull().default(0),
    completionDeadlineAt: text("completion_deadline_at"),
  },
  (table) => [
    check(
      "jobs_state",
      sql`${table.state} IN ('queued','running','retrying','succeeded','failed','cancel_requested','cancelled','interrupted')`,
    ),
    check("jobs_background", sql`${table.background} IN (0,1)`),
    uniqueIndex("jobs_idempotency")
      .on(table.accountId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("jobs_due").on(table.state, table.nextRunAt, table.createdAt),
    index("jobs_account_sync").on(table.accountId, table.kind, table.createdAt),
    uniqueIndex("jobs_active_resource")
      .on(table.resourceLock)
      .where(sql`${table.state} IN ('running','cancel_requested')`),
    index("jobs_active_kind_account")
      .on(table.kind, table.accountId)
      .where(sql`${table.state} IN ('running','cancel_requested')`),
    index("jobs_background_history").on(table.accountId, table.background, table.finishedAt),
    index("jobs_manual_history")
      .on(sql`${table.createdAt} DESC`, sql`${table.id} DESC`)
      .where(sql`${table.background}=0`),
    index("jobs_manual_resource_history")
      .on(table.accountId, table.resourceId, sql`${table.createdAt} DESC`, sql`${table.id} DESC`)
      .where(sql`${table.background}=0`),
  ],
);

export const jobResources = sqliteTable(
  "job_resources",
  {
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    resourceKey: text("resource_key").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.jobId, table.resourceKey] }),
    index("job_resources_resource").on(table.resourceKey, table.jobId),
  ],
);

export const jobEvents = sqliteTable(
  "job_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    level: text("level").notNull(),
    message: text("message").notNull(),
    detailJson: text("detail_json"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("job_events_job").on(table.jobId, table.id)],
);

export const jobWorkers = sqliteTable("job_workers", {
  id: text("id").primaryKey(),
  startedAt: text("started_at").notNull(),
  lastHeartbeatAt: text("last_heartbeat_at").notNull(),
  leaseSeconds: integer("lease_seconds").notNull(),
  stoppedAt: text("stopped_at"),
});

export const inventoryRefreshState = sqliteTable("inventory_refresh_state", {
  accountId: text("account_id").primaryKey(),
  failureCount: integer("failure_count").notNull().default(0),
  lastFailureAt: text("last_failure_at"),
  retryAfter: text("retry_after"),
  manualRequestedAt: text("manual_requested_at"),
  manualJobId: text("manual_job_id"),
});

export const consoleSessions = sqliteTable(
  "console_sessions",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    instanceName: text("instance_name").notNull(),
    accountId: text("account_id").notNull(),
    region: text("region").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    ownerUsername: text("owner_username").notNull(),
    ownerSessionHash: text("owner_session_hash").notNull(),
    state: text("state", {
      enum: ["preparing", "ready", "connected", "closing", "closed", "failed"],
    }).notNull(),
    connectionId: text("connection_id"),
    compartmentId: text("compartment_id"),
    creationState: text("creation_state", {
      enum: ["not_attempted", "uncertain", "created", "rejected"],
    })
      .notNull()
      .default("not_attempted"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastActivityAt: text("last_activity_at").notNull(),
    readyAt: text("ready_at"),
    lastError: text("last_error"),
    cleanupPending: integer("cleanup_pending").notNull().default(0),
    credentialRecoveryReady: integer("credential_recovery_ready").notNull().default(0),
    slot: integer("slot").unique(),
  },
  (table) => [
    check(
      "console_sessions_state",
      sql`${table.state} IN ('preparing','ready','connected','closing','closed','failed')`,
    ),
    check(
      "console_sessions_creation_state",
      sql`${table.creationState} IN ('not_attempted','uncertain','created','rejected')`,
    ),
    check("console_sessions_cleanup_pending", sql`${table.cleanupPending} IN (0,1)`),
    check(
      "console_sessions_credential_recovery_ready",
      sql`${table.credentialRecoveryReady} IN (0,1)`,
    ),
    check("console_sessions_slot", sql`${table.slot} IS NULL OR ${table.slot}=1`),
    check(
      "console_sessions_cleanup_slot",
      sql`${table.slot} IS NOT NULL OR (${table.state} IN ('closed','failed') AND ${table.cleanupPending}=0)`,
    ),
    index("console_sessions_account").on(table.accountId, table.slot),
  ],
);

export const analyticsSnapshots = sqliteTable("analytics_snapshots", {
  cacheKey: text("cache_key").primaryKey(),
  reportJson: text("report_json").notNull(),
  expiresAt: integer("expires_at").notNull(),
  touchedAt: integer("touched_at").notNull(),
  bytes: integer("bytes").notNull(),
});
