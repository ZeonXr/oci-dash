import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { desc, eq, lte, or, sql } from "drizzle-orm";
import type { CostReport, TrafficReport } from "@/lib/analytics-contracts";
import { getDatabase } from "../db";
import { ormFor } from "../database/client";
import { analyticsSnapshots } from "../database/schema";

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
  return {
    get(key) {
      try {
        const orm = ormFor(database()),
          id = digest(key),
          time = now();
        const row = orm
          .select({
            reportJson: analyticsSnapshots.reportJson,
            expiresAt: analyticsSnapshots.expiresAt,
          })
          .from(analyticsSnapshots)
          .where(eq(analyticsSnapshots.cacheKey, id))
          .get();
        if (!row) return;
        if (row.expiresAt <= time || Buffer.byteLength(row.reportJson) > maxEntryBytes) {
          orm.delete(analyticsSnapshots).where(eq(analyticsSnapshots.cacheKey, id)).run();
          return;
        }
        let value: Report;
        try {
          value = JSON.parse(row.reportJson) as Report;
          if (
            !value ||
            value.source !== "oci" ||
            !["ok", "partial", "empty"].includes(value.status) ||
            !Array.isArray(value.accounts) ||
            !Array.isArray(value.rows) ||
            !Array.isArray(value.points) ||
            !Array.isArray(value.warnings) ||
            !Number.isFinite(Date.parse(value.generatedAt)) ||
            Date.parse(value.cacheExpiresAt) !== row.expiresAt
          )
            throw new Error("Invalid analytics snapshot");
        } catch {
          orm.delete(analyticsSnapshots).where(eq(analyticsSnapshots.cacheKey, id)).run();
          return;
        }
        orm
          .update(analyticsSnapshots)
          .set({ touchedAt: time })
          .where(eq(analyticsSnapshots.cacheKey, id))
          .run();
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
        const db = database(),
          orm = ormFor(db),
          id = digest(key);
        db.transaction(() => {
          orm
            .delete(analyticsSnapshots)
            .where(or(lte(analyticsSnapshots.expiresAt, time), eq(analyticsSnapshots.cacheKey, id)))
            .run();
          if (bytes > maxEntryBytes || bytes > maxBytes) return;
          orm
            .insert(analyticsSnapshots)
            .values({ cacheKey: id, reportJson: json, expiresAt: expires, touchedAt: time, bytes })
            .run();
          const rows = orm
            .select({ cacheKey: analyticsSnapshots.cacheKey, bytes: analyticsSnapshots.bytes })
            .from(analyticsSnapshots)
            .orderBy(desc(analyticsSnapshots.touchedAt), desc(sql`rowid`))
            .all();
          let used = 0,
            count = 0;
          for (const row of rows) {
            if (count >= maxEntries || used + row.bytes > maxBytes)
              orm
                .delete(analyticsSnapshots)
                .where(eq(analyticsSnapshots.cacheKey, row.cacheKey))
                .run();
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
