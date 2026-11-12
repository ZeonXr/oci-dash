import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { ormFor } from "@/server/database/client";
import * as schema from "@/server/database/schema";
import { closeDatabase, getDatabase } from "@/server/db";

const handles: Database.Database[] = [];
const directories: string[] = [];
const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
const migrationsFolder = resolve(process.cwd(), "drizzle");

function temporaryPath() {
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "database-migration-"));
  directories.push(directory);
  return join(directory, "fixture.sqlite");
}

function startupPath() {
  const path = temporaryPath();
  writeFileSync(join(dirname(path), ".master-key"), Buffer.alloc(32, 7));
  vi.stubEnv("DATABASE_PATH", path);
  vi.stubEnv("MASTER_KEY", undefined);
  vi.stubEnv("ADMIN_PASSWORD", undefined);
  return path;
}

function open(path = temporaryPath()) {
  const db = new Database(path);
  db.pragma("foreign_keys=ON");
  handles.push(db);
  migrate(ormFor(db), { migrationsFolder });
  return db;
}

afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

  it("rereads migration history after another connection initializes the database", () => {
    const path = startupPath();
    const competing = new Database(path);
    handles.push(competing);
    competing.pragma("journal_mode=WAL");
    competing.pragma("foreign_keys=ON");
    const prepare = Database.prototype.prepare;
    let interleaved = false;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      const statement = prepare.call(this, source);
      if (!interleaved && source.includes('FROM "__drizzle_migrations"')) {
        const all = statement.all;
        statement.all = (...parameters: unknown[]) => {
          const history: unknown[] = Reflect.apply(all, statement, parameters);
          interleaved = true;
          // Commit on a second connection after the first has read empty history.
          migrate(ormFor(competing), { migrationsFolder });
          return history;
        };
      }
      return statement;
    });

    const initialized = getDatabase();
    expect(interleaved).toBe(true);
    expect(initialized.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(1);
    expect(initialized.pragma("foreign_key_check")).toEqual([]);
    ormFor(initialized).insert(schema.settings).values({ key: "startup", value: "ready" }).run();
    expect(competing.prepare("SELECT value FROM settings WHERE key='startup'").pluck().get()).toBe(
      "ready",
    );
  });

  it("retries a journal-mode conflict before completing initialization", () => {
    startupPath();
    const pragma = Database.prototype.pragma;
    let conflicted = false;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (
      this: Database.Database,
      source: string,
      options?: Database.PragmaOptions,
    ) {
      if (!conflicted && source === "journal_mode = WAL") {
        conflicted = true;
        throw new Database.SqliteError("database is locked", "SQLITE_BUSY");
      }
      return pragma.call(this, source, options);
    });

    const initialized = getDatabase();
    expect(conflicted).toBe(true);
    expect(initialized.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(initialized.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(initialized.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(1);
  });

  it("still rejects a persistent migration failure and rolls back partial schema changes", () => {
    const path = startupPath();
    const prepare = Database.prototype.prepare;
    let failures = 0;
    vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
      this: Database.Database,
      source: string,
    ) {
      if (source.includes("CREATE UNIQUE INDEX `users_username_unique`")) {
        failures++;
        return prepare.call(this, "CREATE invalid fixture syntax");
      }
      return prepare.call(this, source);
    });

    expect(() => getDatabase()).toThrow();
    expect(failures).toBe(2);
    const db = new Database(path);
    handles.push(db);
    expect(db.prepare("SELECT count(*) FROM __drizzle_migrations").pluck().get()).toBe(0);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='accounts'").get(),
    ).toBeUndefined();
  });
});
