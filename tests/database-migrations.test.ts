import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ormFor } from "@/server/database/client";
import * as schema from "@/server/database/schema";

const handles: Database.Database[] = [];
const directories: string[] = [];
const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
const migrationsFolder = resolve(process.cwd(), "drizzle");

function open(path?: string) {
  if (!path) {
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, "database-migration-"));
    directories.push(directory);
    path = join(directory, "fixture.sqlite");
  }
  const db = new Database(path);
  db.pragma("foreign_keys=ON");
  handles.push(db);
  migrate(ormFor(db), { migrationsFolder });
  return db;
}

afterEach(() => {
  for (const db of handles.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (dirname(target) !== base || !basename(target).startsWith("database-migration-"))
      throw new Error("Unsafe database migration test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("versioned Drizzle migrations", () => {
  it("creates the tables and columns declared by the TypeScript schema", () => {
    const db = open();
    for (const table of Object.values(schema)) {
      const config = getTableConfig(table);
      const actual = db.prepare(`PRAGMA table_info(${config.name})`).all() as { name: string }[];
      expect(actual.map((column) => column.name).sort()).toEqual(
        config.columns.map((column) => column.name).sort(),
      );
    }
    expect(db.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("shares the driver's transaction with ORM queries", () => {
    const db = open();
    const orm = ormFor(db);
    expect(ormFor(db)).toBe(orm);
    expect(() =>
      db
        .transaction(() => {
          orm.insert(schema.settings).values({ key: "orm-write", value: "rollback" }).run();
          db.prepare("INSERT INTO settings VALUES('raw-write','rollback')").run();
          throw new Error("Rollback both APIs");
        })
        .immediate(),
    ).toThrow("Rollback both APIs");
    expect(orm.select().from(schema.settings).all()).toEqual([]);
  });

  it("reopens a migrated database without replacing its data or reapplying the migration", () => {
    const first = open();
    ormFor(first).insert(schema.settings).values({ key: "retained", value: "saved" }).run();
    const history = first.prepare("SELECT * FROM __drizzle_migrations").all();
    const path = first.name;
    first.close();
    const reopened = open(path);
    expect(ormFor(reopened).select().from(schema.settings).all()).toEqual([
      { key: "retained", value: "saved" },
    ]);
    expect(reopened.prepare("SELECT * FROM __drizzle_migrations").all()).toEqual(history);
  });
});
