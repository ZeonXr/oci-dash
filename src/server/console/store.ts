import type Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import type { ConsoleSessionSummary } from "../../lib/console-contracts";
import { getDatabase } from "../db";
import { ormFor } from "../database/client";
import { consoleSessions } from "../database/schema";
import { AppError } from "../errors";

type SessionRow = typeof consoleSessions.$inferSelect;
/** Durable cleanup metadata only. Credentials and websocket tickets must never enter this row. */
export type ConsoleSessionRecord = Omit<
  SessionRow,
  "cleanupPending" | "credentialRecoveryReady" | "slot"
> & {
  cleanupPending: boolean;
  credentialRecoveryReady: boolean;
  slot: 1 | null;
};

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

export function createConsoleStore(db: Database.Database = getDatabase()): ConsoleSessionStore {
  const orm = ormFor(db);
  const decode = (row: SessionRow | undefined): ConsoleSessionRecord | null =>
    row
      ? {
          ...row,
          cleanupPending: !!row.cleanupPending,
          credentialRecoveryReady: !!row.credentialRecoveryReady,
          slot: row.slot === 1 ? 1 : null,
        }
      : null;
  return {
    active: () =>
      decode(orm.select().from(consoleSessions).where(eq(consoleSessions.slot, 1)).get()),
    get: (id) => decode(orm.select().from(consoleSessions).where(eq(consoleSessions.id, id)).get()),
    reserve(record, validate) {
      db.transaction(() => {
        if (
          orm
            .select({ id: consoleSessions.id })
            .from(consoleSessions)
            .where(eq(consoleSessions.slot, 1))
            .get()
        )
          throw new AppError("已有控制台会话或清理任务，请先结束该会话", 409, "CONSOLE_BUSY");
        validate?.();
        orm
          .insert(consoleSessions)
          .values({
            ...record,
            cleanupPending: Number(record.cleanupPending),
            credentialRecoveryReady: Number(record.credentialRecoveryReady),
          })
          .run();
      }).immediate();
    },
    update(id, patch) {
      const { cleanupPending, credentialRecoveryReady, ...rest } = patch;
      if (!Object.keys(patch).length) return;
      orm
        .update(consoleSessions)
        .set({
          ...rest,
          ...(cleanupPending !== undefined ? { cleanupPending: Number(cleanupPending) } : {}),
          ...(credentialRecoveryReady !== undefined
            ? { credentialRecoveryReady: Number(credentialRecoveryReady) }
            : {}),
        })
        .where(and(eq(consoleSessions.id, id), eq(consoleSessions.slot, 1)))
        .run();
    },
    allowCredentialRecovery(id) {
      // A cleanup that has restarted in another process cannot be reopened by a stale read.
      orm
        .update(consoleSessions)
        .set({ credentialRecoveryReady: 1 })
        .where(
          and(
            eq(consoleSessions.id, id),
            eq(consoleSessions.slot, 1),
            eq(consoleSessions.state, "failed"),
            eq(consoleSessions.cleanupPending, 1),
          ),
        )
        .run();
    },
    finish(id, state, lastError) {
      orm
        .update(consoleSessions)
        .set({
          state,
          lastError,
          cleanupPending: 0,
          credentialRecoveryReady: 0,
          slot: null,
        })
        .where(and(eq(consoleSessions.id, id), eq(consoleSessions.slot, 1)))
        .run();
    },
  };
}
