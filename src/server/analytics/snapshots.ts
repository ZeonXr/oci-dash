import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { CostReport, TrafficReport } from "@/lib/analytics-contracts";
import { getDatabase } from "../db";

type Report = CostReport | TrafficReport;
export interface AnalyticsSnapshots {
  get(key: string): Report | undefined;
  set(key: string, report: Report): void;
}
interface Options {
  database?: () => Database.Database;
  now?: () => number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

// Bump the namespace when report semantics change. Keys already include the
// selected accounts, credential revisions, enabled scope and query parameters.
const digest = (key: string) =>
  createHash("sha256")
    .update("analytics-v1\0" + key)
    .digest("hex");

/** Optional bounded storage of public reports; it never extends a report's TTL. */
export function createAnalyticsSnapshots(options: Options = {}): AnalyticsSnapshots {
  const database = options.database ?? getDatabase;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? 32;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const maxEntryBytes = options.maxEntryBytes ?? 4 * 1024 * 1024;
  for (const limit of [maxEntries, maxBytes, maxEntryBytes])
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid snapshot cache limit");
  const initialized = new WeakSet<Database.Database>();
  function open() {
    const db = database();
    if (!initialized.has(db)) {
      db.exec(`CREATE TABLE IF NOT EXISTS analytics_snapshots (
        cache_key TEXT PRIMARY KEY,
        report_json TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        touched_at INTEGER NOT NULL,
        bytes INTEGER NOT NULL
      )`);
      initialized.add(db);
    }
    return db;
  }
  return {
    get(key) {
      try {
        const db = open(),
          id = digest(key),
          time = now();
        const row = db
          .prepare("SELECT report_json,expires_at FROM analytics_snapshots WHERE cache_key=?")
          .get(id) as { report_json: string; expires_at: number } | undefined;
        if (!row) return;
        if (row.expires_at <= time || Buffer.byteLength(row.report_json) > maxEntryBytes) {
          db.prepare("DELETE FROM analytics_snapshots WHERE cache_key=?").run(id);
          return;
        }
        let value: Report;
        try {
          value = JSON.parse(row.report_json) as Report;
          if (
            !value ||
            value.source !== "oci" ||
            !["ok", "partial", "empty"].includes(value.status) ||
            !Array.isArray(value.accounts) ||
            !Array.isArray(value.rows) ||
            !Array.isArray(value.points) ||
            !Array.isArray(value.warnings) ||
            !Number.isFinite(Date.parse(value.generatedAt)) ||
            Date.parse(value.cacheExpiresAt) !== row.expires_at
          )
            throw new Error("Invalid analytics snapshot");
        } catch {
          db.prepare("DELETE FROM analytics_snapshots WHERE cache_key=?").run(id);
          return;
        }
        db.prepare("UPDATE analytics_snapshots SET touched_at=? WHERE cache_key=?").run(time, id);
        return value;
      } catch {
        // Cache availability must not turn an otherwise valid OCI read into an error.
        return;
      }
    },
    set(key, report) {
      try {
        const time = now(),
          expires = Date.parse(report.cacheExpiresAt);
        if (report.source !== "oci" || !Number.isFinite(expires) || expires <= time) return;
        const json = JSON.stringify(report),
          bytes = Buffer.byteLength(json);
        const db = open(),
          id = digest(key);
        db.transaction(() => {
          db.prepare("DELETE FROM analytics_snapshots WHERE expires_at<=? OR cache_key=?").run(
            time,
            id,
          );
          if (bytes > maxEntryBytes || bytes > maxBytes) return;
          db.prepare(
            "INSERT INTO analytics_snapshots(cache_key,report_json,expires_at,touched_at,bytes) VALUES(?,?,?,?,?)",
          ).run(id, json, expires, time, bytes);
          const rows = db
            .prepare(
              "SELECT cache_key,bytes FROM analytics_snapshots ORDER BY touched_at DESC,rowid DESC",
            )
            .all() as { cache_key: string; bytes: number }[];
          let used = 0,
            count = 0;
          const remove = db.prepare("DELETE FROM analytics_snapshots WHERE cache_key=?");
          for (const row of rows) {
            if (count >= maxEntries || used + row.bytes > maxBytes) remove.run(row.cache_key);
            else {
              used += row.bytes;
              count++;
            }
          }
        }).immediate();
      } catch {
        // A failed optional cache write does not discard the freshly obtained report.
      }
    },
  };
}
