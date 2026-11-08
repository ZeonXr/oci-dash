import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as schema from "./schema";
import { initializeMasterKey } from "./master-key";
import { ensureInitialAdmin } from "./initial-admin";

let connection: Database.Database | undefined;
let currentPath: string | undefined;

const migration = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 mfa_secret TEXT, mfa_pending TEXT, mfa_pending_expires TEXT, recovery_codes TEXT NOT NULL DEFAULT '[]',
 last_otp_step INTEGER NOT NULL DEFAULT -1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (subject TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, tenancy_id TEXT NOT NULL, user_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL, home_region TEXT NOT NULL, regions TEXT NOT NULL, credential TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'unchecked', last_sync_at TEXT, last_error TEXT, created_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS resources (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 region TEXT NOT NULL, data TEXT NOT NULL, synced_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS resources_account ON resources(account_id);
CREATE TABLE IF NOT EXISTS audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
 resource TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export function getDatabase(): Database.Database {
  const path = resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "data/oci-dash.db");
  if (connection && path === currentPath) return connection;
  connection?.close();
  connection = undefined;
  currentPath = undefined;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 10000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.transaction(() => {
      db.exec(migration);
      const columns = db.prepare("PRAGMA table_info(accounts)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "revision"))
        db.exec("ALTER TABLE accounts ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
      db.prepare("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,?)").run(
        new Date().toISOString(),
      );
    }).immediate();
    initializeMasterKey(db, path);
    ensureInitialAdmin(db, path);
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

export const getOrm = () => drizzle(getDatabase(), { schema });
export function closeDatabase(): void {
  connection?.close();
  connection = undefined;
  currentPath = undefined;
}
export function audit(actor: string, action: string, resource: string, result: string): void {
  getDatabase()
    .prepare("INSERT INTO audit_events(actor,action,resource,result,created_at) VALUES(?,?,?,?,?)")
    .run(actor, action, resource.slice(0, 300), result.slice(0, 1200), new Date().toISOString());
}
