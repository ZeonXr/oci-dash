import type Database from "better-sqlite3";
import type { ConsoleSessionState, ConsoleSessionSummary } from "../../lib/console-contracts";
import { getDatabase } from "../db";
import { AppError } from "../errors";
import type { ConsoleCreationState } from "./types";

/** Durable cleanup metadata only. Credentials and websocket tickets must never enter this row. */
export interface ConsoleSessionRecord {
  id: string;
  instanceId: string;
  instanceName: string;
  accountId: string;
  region: string;
  ownerUserId: string;
  ownerUsername: string;
  ownerSessionHash: string;
  state: ConsoleSessionState;
  connectionId: string | null;
  /** Verified OCI scope, retained after the parent instance disappears. */
  compartmentId: string | null;
  creationState: ConsoleCreationState;
  createdAt: string;
  expiresAt: string;
  lastActivityAt: string;
  readyAt: string | null;
  lastError: string | null;
  cleanupPending: boolean;
  /** True only after local work and the last cloud cleanup attempt have settled. */
  credentialRecoveryReady: boolean;
  slot: 1 | null;
}

type SessionPatch = Partial<
  Pick<
    ConsoleSessionRecord,
    | "state"
    | "connectionId"
    | "compartmentId"
    | "creationState"
    | "lastActivityAt"
    | "readyAt"
    | "lastError"
    | "cleanupPending"
    | "credentialRecoveryReady"
  >
>;

export interface ConsoleSessionStore {
  active(): ConsoleSessionRecord | null;
  get(id: string): ConsoleSessionRecord | null;
  reserve(record: ConsoleSessionRecord, validate?: () => void): void;
  update(id: string, patch: SessionPatch): void;
  allowCredentialRecovery(id: string): void;
  finish(id: string, state: "closed" | "failed", lastError: string | null): void;
}

export function consoleSummary(record: ConsoleSessionRecord): ConsoleSessionSummary {
  return {
    id: record.id,
    instanceId: record.instanceId,
    instanceName: record.instanceName,
    accountId: record.accountId,
    state: record.state,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastError: record.lastError,
    cleanupPending: record.cleanupPending,
  };
}

const columns = {
  id: "id",
  instanceId: "instance_id",
  instanceName: "instance_name",
  accountId: "account_id",
  region: "region",
  ownerUserId: "owner_user_id",
  ownerUsername: "owner_username",
  ownerSessionHash: "owner_session_hash",
  state: "state",
  connectionId: "connection_id",
  compartmentId: "compartment_id",
  creationState: "creation_state",
  createdAt: "created_at",
  expiresAt: "expires_at",
  lastActivityAt: "last_activity_at",
  readyAt: "ready_at",
  lastError: "last_error",
  cleanupPending: "cleanup_pending",
  credentialRecoveryReady: "credential_recovery_ready",
  slot: "slot",
} satisfies Record<keyof ConsoleSessionRecord, string>;

const select = Object.entries(columns)
  .map(([name, column]) => `${column} AS ${name}`)
  .join(",");

export function createConsoleStore(db: Database.Database = getDatabase()): ConsoleSessionStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_sessions (
      id TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      instance_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      region TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      owner_username TEXT NOT NULL,
      owner_session_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('preparing','ready','connected','closing','closed','failed')),
      connection_id TEXT,
      compartment_id TEXT,
      creation_state TEXT NOT NULL DEFAULT 'not_attempted'
        CHECK(creation_state IN ('not_attempted','uncertain','created','rejected')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      ready_at TEXT,
      last_error TEXT,
      cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK(cleanup_pending IN (0,1)),
      credential_recovery_ready INTEGER NOT NULL DEFAULT 0 CHECK(credential_recovery_ready IN (0,1)),
      slot INTEGER UNIQUE CHECK(slot IS NULL OR slot=1),
      CHECK(slot IS NOT NULL OR (state IN ('closed','failed') AND cleanup_pending=0))
    );
    CREATE INDEX IF NOT EXISTS console_sessions_account ON console_sessions(account_id,slot);
  `);
  db.transaction(() => {
    const present = db.prepare("PRAGMA table_info(console_sessions)").all() as { name: string }[];
    if (!present.some((column) => column.name === "compartment_id"))
      db.exec("ALTER TABLE console_sessions ADD COLUMN compartment_id TEXT");
    if (!present.some((column) => column.name === "credential_recovery_ready"))
      db.exec(
        "ALTER TABLE console_sessions ADD COLUMN credential_recovery_ready INTEGER NOT NULL DEFAULT 0 CHECK(credential_recovery_ready IN (0,1))",
      );
    if (!present.some((column) => column.name === "creation_state")) {
      db.exec(
        "ALTER TABLE console_sessions ADD COLUMN creation_state TEXT NOT NULL DEFAULT 'not_attempted' CHECK(creation_state IN ('not_attempted','uncertain','created','rejected'))",
      );
      // Previous versions did not record the request boundary. Never assume an active
      // row without an ID means OCI did not receive its create before the restart.
      db.exec(
        "UPDATE console_sessions SET creation_state=CASE WHEN connection_id IS NOT NULL THEN 'created' ELSE 'uncertain' END WHERE slot=1",
      );
    }
  }).immediate();
  const decode = (value: unknown): ConsoleSessionRecord | null => {
    if (!value) return null;
    const row = value as ConsoleSessionRecord;
    return {
      ...row,
      cleanupPending: !!row.cleanupPending,
      credentialRecoveryReady: !!row.credentialRecoveryReady,
    };
  };
  return {
    active: () => decode(db.prepare(`SELECT ${select} FROM console_sessions WHERE slot=1`).get()),
    get: (id) => decode(db.prepare(`SELECT ${select} FROM console_sessions WHERE id=?`).get(id)),
    reserve(record, validate) {
      db.transaction(() => {
        if (db.prepare("SELECT id FROM console_sessions WHERE slot=1").get())
          throw new AppError("已有控制台会话或清理任务，请先结束该会话", 409, "CONSOLE_BUSY");
        validate?.();
        const keys = Object.keys(columns) as (keyof ConsoleSessionRecord)[];
        db.prepare(
          `INSERT INTO console_sessions(${keys.map((key) => columns[key]).join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
        ).run(
          ...keys.map((key) =>
            ["cleanupPending", "credentialRecoveryReady"].includes(key)
              ? Number(record[key])
              : record[key],
          ),
        );
      }).immediate();
    },
    update(id, patch) {
      const keys = Object.keys(patch) as (keyof SessionPatch)[];
      if (!keys.length) return;
      db.prepare(
        `UPDATE console_sessions SET ${keys.map((key) => `${columns[key]}=?`).join(",")} WHERE id=? AND slot=1`,
      ).run(
        ...keys.map((key) =>
          ["cleanupPending", "credentialRecoveryReady"].includes(key)
            ? Number(patch[key])
            : patch[key],
        ),
        id,
      );
    },
    allowCredentialRecovery(id) {
      // The gateway and account HTTP handlers use separate processes. A cleanup
      // that has already restarted must never be reopened by a stale read.
      db.prepare(
        "UPDATE console_sessions SET credential_recovery_ready=1 WHERE id=? AND slot=1 AND state='failed' AND cleanup_pending=1",
      ).run(id);
    },
    finish(id, state, lastError) {
      db.prepare(
        "UPDATE console_sessions SET state=?,last_error=?,cleanup_pending=0,credential_recovery_ready=0,slot=NULL WHERE id=? AND slot=1",
      ).run(state, lastError, id);
    },
  };
}
