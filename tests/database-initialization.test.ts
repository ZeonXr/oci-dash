import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initializeDatabase } from "@/server/db";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
let directory: string;
beforeEach(() => {
  closeDatabase();
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "database-initialization-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "first.db"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 46).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", "first-owner");
  vi.stubEnv("ADMIN_PASSWORD", "synthetic-initialization-password");
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  if (dirname(directory) !== base || !basename(directory).startsWith("database-initialization-"))
    throw new Error("Invalid database initialization cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("explicit database initialization", () => {
  it("keeps synchronous database access free of administrator hashing and deduplicates asynchronous startup", async () => {
    const db = getDatabase();
    expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(0);
    await Promise.all([initializeDatabase(), initializeDatabase(), initializeDatabase()]);
    expect(db.prepare("SELECT username FROM users").pluck().all()).toEqual(["first-owner"]);
    expect(db.inTransaction).toBe(false);
    await initializeDatabase();
    expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(1);
  });

  it("can retry failed initialization without creating partial administrator state", async () => {
    vi.stubEnv("ADMIN_PASSWORD", "short");
    await expect(initializeDatabase()).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(getDatabase().prepare("SELECT count(*) FROM users").pluck().get()).toBe(0);
    vi.stubEnv("ADMIN_PASSWORD", "synthetic-initialization-password");
    await initializeDatabase();
    expect(getDatabase().prepare("SELECT username FROM users").pluck().get()).toBe("first-owner");
  });

  it("resets startup state when the database path changes or the connection is reopened", async () => {
    await initializeDatabase();
    const first = getDatabase();
    vi.stubEnv("DATABASE_PATH", join(directory, "second.db"));
    vi.stubEnv("ADMIN_USERNAME", "second-owner");
    await initializeDatabase();
    expect(first.open).toBe(false);
    expect(getDatabase().prepare("SELECT username FROM users").pluck().get()).toBe("second-owner");
    closeDatabase();
    vi.stubEnv("DATABASE_PATH", join(directory, "first.db"));
    await initializeDatabase();
    expect(getDatabase().prepare("SELECT username FROM users").pluck().get()).toBe("first-owner");
  });

  it("does not let an obsolete in-flight initialization affect a replacement connection", async () => {
    const first = initializeDatabase();
    const outcome = Promise.allSettled([first]);
    vi.stubEnv("DATABASE_PATH", join(directory, "replacement.db"));
    vi.stubEnv("ADMIN_USERNAME", "replacement-owner");
    await initializeDatabase();
    expect((await outcome)[0].status).toBe("rejected");
    await initializeDatabase();
    expect(getDatabase().prepare("SELECT username FROM users").pluck().all()).toEqual([
      "replacement-owner",
    ]);
  });
});
