import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  tenancyId: text("tenancy_id").notNull(),
  userId: text("user_id").notNull(),
  fingerprint: text("fingerprint").notNull(),
  homeRegion: text("home_region").notNull(),
  regions: text("regions", { mode: "json" }).$type<string[]>().notNull(),
  credential: text("credential").notNull(),
  status: text("status").notNull(),
  lastSyncAt: text("last_sync_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  revision: integer("revision").notNull().default(0),
});
export const resources = sqliteTable("resources", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  region: text("region").notNull(),
  data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  syncedAt: text("synced_at").notNull(),
});
export const auditEvents = sqliteTable("audit_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  result: text("result").notNull(),
  createdAt: text("created_at").notNull(),
});
