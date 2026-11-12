import Database from "better-sqlite3";
import { count, eq, inArray, isNotNull, or } from "drizzle-orm";
import { resolve } from "node:path";
import { ormFor } from "../database/client";
import { accounts, consoleSessions, jobs, users } from "../database/schema";
import { verifyStoredMasterKey } from "../master-key";

export interface DataCheckSummary {
  administrators: number;
  accounts: number;
  encryptedSecrets: number;
  pendingTasks: number;
  consoleSessions: number;
}

/** Inspect a stopped/restored dataset without migrations, writes, or cloud access. */
export function checkRestoredData(
  path = process.env.DATABASE_PATH ?? "data/oci-dash.db",
): DataCheckSummary {
  const databasePath = resolve(path);
  const database = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
    timeout: 1000,
  });
  try {
    const integrity = database.pragma("integrity_check") as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new Error("Database integrity check failed; restore a consistent backup");
    const encryptedSecrets = verifyStoredMasterKey(database, databasePath);
    const orm = ormFor(database);
    return {
      administrators: orm.select({ value: count() }).from(users).get()!.value,
      accounts: orm.select({ value: count() }).from(accounts).get()!.value,
      encryptedSecrets,
      pendingTasks: orm
        .select({ value: count() })
        .from(jobs)
        .where(
          inArray(jobs.state, ["queued", "running", "retrying", "cancel_requested", "interrupted"]),
        )
        .get()!.value,
      consoleSessions: orm
        .select({ value: count() })
        .from(consoleSessions)
        .where(or(isNotNull(consoleSessions.slot), eq(consoleSessions.cleanupPending, 1)))
        .get()!.value,
    };
  } finally {
    database.close();
  }
}
