import Database from "better-sqlite3";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, initializeDatabase } from "@/server/db";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
const require = createRequire(import.meta.url);
const peers: Database.Database[] = [];
const holders: Worker[] = [];
let directory: string;
let path: string;

beforeEach(() => {
  closeDatabase();
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "database-lock-"));
  path = join(directory, "test.sqlite");
  vi.stubEnv("DATABASE_PATH", path);
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 47).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", undefined);
  vi.stubEnv("ADMIN_PASSWORD", undefined);
});

afterEach(async () => {
  for (const holder of holders.splice(0)) await holder.terminate();
  for (const peer of peers.splice(0)) {
    if (peer.inTransaction) peer.exec("ROLLBACK");
    if (peer.open) peer.close();
  }
  closeDatabase();
  vi.unstubAllEnvs();
  if (dirname(directory) !== base || !basename(directory).startsWith("database-lock-"))
    throw new Error("Invalid database lock test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("database lock waiting in a shared event loop", () => {
  it("bounds runtime write contention and resumes short transactions after the writer releases", async () => {
    await initializeDatabase();
    const db = getDatabase();
    expect(db.pragma("busy_timeout", { simple: true })).toBe(250);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    const peer = new Database(path);
    peers.push(peer);
    peer.exec("BEGIN IMMEDIATE");
    peer.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("held", "uncommitted");

    // WAL readers retain the committed snapshot while another connection owns the write lock.
    expect(db.prepare("SELECT value FROM settings WHERE key='held'").get()).toBeUndefined();
    const start = performance.now();
    const eventLoopResumed = new Promise<number>((resolve) =>
      setImmediate(() => resolve(performance.now() - start)),
    );
    expect(() =>
      db
        .transaction(() => {
          db.prepare(
            "INSERT INTO settings(key,value) VALUES ('contended','must not commit')",
          ).run();
        })
        .immediate(),
    ).toThrowError(expect.objectContaining({ code: "SQLITE_BUSY" }));
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(1000);
    expect(await eventLoopResumed).toBeLessThan(1000);
    expect(db.inTransaction).toBe(false);

    peer.exec("COMMIT");
    db.transaction(() => {
      db.prepare("INSERT INTO settings(key,value) VALUES ('recovered','committed')").run();
    }).immediate();
    expect(db.inTransaction).toBe(false);
    expect(
      db
        .prepare(
          "SELECT key,value FROM settings WHERE key IN ('held','recovered','contended') ORDER BY key",
        )
        .all(),
    ).toEqual([
      { key: "held", value: "uncommitted" },
      { key: "recovered", value: "committed" },
    ]);
    expect(peer.prepare("SELECT value FROM settings WHERE key='recovered'").pluck().get()).toBe(
      "committed",
    );
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("allows startup preparation to wait longer than the runtime budget before tightening it", async () => {
    await initializeDatabase();
    const key = readFileSync(join(directory, ".master-key"));
    closeDatabase();
    // Release the independent connection from another thread: a main-thread timer cannot run
    // while synchronous SQLite startup is waiting for this lock.
    const holder = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const Database = require(workerData.modulePath);
        const db = new Database(workerData.path);
        db.exec("BEGIN IMMEDIATE");
        parentPort.postMessage("locked");
        setTimeout(() => {
          db.exec("COMMIT");
          db.close();
          parentPort.close();
        }, 1200);
      `,
      {
        eval: true,
        workerData: { path, modulePath: require.resolve("better-sqlite3") },
      },
    );
    holders.push(holder);
    const exited = new Promise<number>((resolve) => holder.once("exit", resolve));
    const errors: unknown[] = [];
    holder.on("error", (error) => errors.push(error));
    expect(await once(holder, "message")).toEqual(["locked"]);
    const start = performance.now();
    const db = getDatabase();
    expect(performance.now() - start).toBeGreaterThanOrEqual(1000);
    expect(await exited).toBe(0);
    expect(errors).toEqual([]);
    expect(db.pragma("busy_timeout", { simple: true })).toBe(250);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(readFileSync(join(directory, ".master-key"))).toEqual(key);
    db.transaction(() => {
      db.prepare("INSERT INTO settings(key,value) VALUES ('after-startup','ready')").run();
    }).immediate();
    expect(db.prepare("SELECT value FROM settings WHERE key='after-startup'").pluck().get()).toBe(
      "ready",
    );
  });
});
