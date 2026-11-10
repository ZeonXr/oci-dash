import Database from "better-sqlite3";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { initializeMasterKey } from "./master-key";
import { ensureInitialAdmin } from "./initial-admin";
import { ormFor } from "./database/client";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { auditEvents } from "./database/schema";

let connection: Database.Database | undefined;
let currentPath: string | undefined;

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
    migrate(ormFor(db), { migrationsFolder: resolve(process.cwd(), "drizzle") });
    initializeMasterKey(db, path);
    ensureInitialAdmin(db);
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

export function closeDatabase(): void {
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
