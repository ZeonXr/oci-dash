import type Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { resolve } from "node:path";
import { ormFor } from "@/server/database/client";

export function initializeTestDatabase(database: Database.Database): void {
  migrate(ormFor(database), { migrationsFolder: resolve("drizzle") });
}
