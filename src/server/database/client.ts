import type Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type OrmDatabase = BetterSQLite3Database<typeof schema>;
const clients = new WeakMap<Database.Database, OrmDatabase>();

/** ORM queries share the driver's connection, including its current transaction. */
export function ormFor(database: Database.Database): OrmDatabase {
  let client = clients.get(database);
  if (!client) {
    client = drizzle(database, { schema });
    clients.set(database, client);
  }
  return client;
}
