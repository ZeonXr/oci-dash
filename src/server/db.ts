import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeMasterKey } from "./master-key";
import { ensureInitialAdmin } from "./initial-admin";
import { ormFor } from "./database/client";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { auditEvents } from "./database/schema";

const STARTUP_BUSY_TIMEOUT_MS = 10_000;
const RUNTIME_BUSY_TIMEOUT_MS = 250;

let connection: Database.Database | undefined;
let currentPath: string | undefined;
let initialization: { db: Database.Database; promise: Promise<void> } | undefined;

export function getDatabase(): Database.Database {
  const path = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "data/oci-dash.db");
  if (connection && path === currentPath) return connection;
  initialization = undefined;
  connection?.close();
  connection = undefined;
  currentPath = undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma(`busy_timeout = ${STARTUP_BUSY_TIMEOUT_MS}`);
    const prepareSchema = () => {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      migrate(ormFor(db), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    };
    try {
      prepareSchema();
    } catch (error) {
      if (db.inTransaction) throw error;
      // Another process may have enabled WAL or committed after history was read.
      // Retry once with fresh state; persistent schema errors still fail startup.
      prepareSchema();
    }
    initializeMasterKey(db, path);
    // A runtime lock conflict must not block HTTP handling and worker heartbeats for seconds.
    db.pragma(`busy_timeout = ${RUNTIME_BUSY_TIMEOUT_MS}`);
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows ACLs are managed by the host. */
  }
  connection = db;
  currentPath = path;
  return db;
}

export async function initializeDatabase(): Promise<void> {
  const db = getDatabase();
  if (initialization?.db === db) return initialization.promise;
  const pending = { db, promise: ensureInitialAdmin(db) };
  initialization = pending;
  try {
    await pending.promise;
  } catch (error) {
    if (initialization === pending) initialization = undefined;
    throw error;
  }
}

export function closeDatabase(): void {
  initialization = undefined;
  connection?.close();
  connection = undefined;
  currentPath = undefined;
}
export function audit(actor: string, action: string, resource: string, result: string): void {
  getOrm()
    .insert(auditEvents)
    .values({
      actor,
      action,
      resource: resource.slice(0, 300),
      result: result.slice(0, 1200),
      createdAt: new Date().toISOString(),
    })
    .run();
}

export const getOrm = () => ormFor(getDatabase());
