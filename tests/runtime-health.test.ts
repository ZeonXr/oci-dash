import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve, sep } from "node:path";
import { createJobStore } from "@/server/jobs/store";
import { checkRuntimeHealth } from "@/server/runtime/health";
import type { RuntimeState } from "@/server/runtime/state";
import { initializeTestDatabase } from "./fixtures/database";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
let directory: string;
let database: Database.Database;
let store: ReturnType<typeof createJobStore>;
let server: Server;
let state: RuntimeState;
let options: { statePath: string; databasePath: string; port: number };
let response: { status: number; body: string; hang?: boolean };

beforeEach(async () => {
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "runtime-health-"));
  const databasePath = join(directory, "test.db");
  vi.stubEnv("DATABASE_PATH", databasePath);
  database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  initializeTestDatabase(database);
  store = createJobStore({ db: database, getAccount: () => null });
  state = {
    supervisorPid: process.pid,
    webPid: process.pid,
    workerPid: process.pid,
    workerId: "current-test-runtime",
    startedAt: new Date(Date.now() - 1000).toISOString(),
  };
  const statePath = join(directory, "runtime.json");
  writeFileSync(statePath, JSON.stringify(state));
  store.heartbeat(state.workerId, 30_000);
  response = { status: 200, body: JSON.stringify({ ok: true }) };
  server = createServer((_request, res) => {
    if (response.hang) return;
    res.writeHead(response.status, { "Content-Type": "application/json" });
    res.end(response.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test port.");
  options = { statePath, databasePath, port: address.port };
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  database?.close();
  vi.unstubAllEnvs();
  if (directory && resolve(directory).startsWith(base + sep)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("combined application health", () => {
  it("reads only the heartbeat table without initializing or migrating the probe database", async () => {
    const path = join(directory, "probe-only.db");
    const probe = new Database(path);
    try {
      probe.exec(
        "CREATE TABLE job_workers (id TEXT PRIMARY KEY,last_heartbeat_at TEXT,lease_seconds INTEGER,stopped_at TEXT)",
      );
      probe
        .prepare("INSERT INTO job_workers VALUES(?,?,?,NULL)")
        .run(state.workerId, new Date().toISOString(), 30_000);
      vi.stubEnv("DATABASE_PATH", path);
      expect(await checkRuntimeHealth({ ...options, databasePath: path })).toBe(true);
      expect(probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([
        { name: "job_workers" },
      ]);
      expect(existsSync(join(directory, ".master-key"))).toBe(false);
    } finally {
      probe.close();
    }
  });

  it("requires the Web response and this runtime's heartbeat without writing to SQLite", async () => {
    const before = database.prepare("SELECT * FROM job_workers").all();
    expect(await checkRuntimeHealth(options)).toBe(true);
    expect(database.prepare("SELECT * FROM job_workers").all()).toEqual(before);
  });

  it("does not accept a recent heartbeat belonging to a previous runtime", async () => {
    database.prepare("DELETE FROM job_workers WHERE id = ?").run(state.workerId);
    store.heartbeat("previous-test-runtime", 30_000);
    expect(await checkRuntimeHealth(options)).toBe(false);
  });

  it("rejects an expired or stopped current worker", async () => {
    database
      .prepare("UPDATE job_workers SET last_heartbeat_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 60_000).toISOString(), state.workerId);
    expect(await checkRuntimeHealth(options)).toBe(false);
    store.heartbeat(state.workerId, 30_000);
    store.stopWorker(state.workerId);
    expect(await checkRuntimeHealth(options)).toBe(false);
  });

  it("rejects a missing child process even while its heartbeat is fresh", async () => {
    writeFileSync(options.statePath, JSON.stringify({ ...state, workerPid: 2_147_483_647 }));
    expect(await checkRuntimeHealth(options)).toBe(false);
  });

  it("fails closed for missing or invalid runtime identity", async () => {
    rmSync(options.statePath);
    expect(await checkRuntimeHealth(options)).toBe(false);
    writeFileSync(options.statePath, "invalid-json");
    expect(await checkRuntimeHealth(options)).toBe(false);
    expect(readFileSync(options.statePath, "utf8")).toBe("invalid-json");
  });

  it("does not create a missing database during a probe", async () => {
    const missing = join(directory, "missing.db");
    expect(await checkRuntimeHealth({ ...options, databasePath: missing })).toBe(false);
    expect(existsSync(missing)).toBe(false);
  });

  it("rejects an unavailable or invalid Web health response", async () => {
    response.status = 503;
    expect(await checkRuntimeHealth(options)).toBe(false);
    response = { status: 200, body: "not-json" };
    expect(await checkRuntimeHealth(options)).toBe(false);
    response.body = JSON.stringify({ ok: false });
    expect(await checkRuntimeHealth(options)).toBe(false);
  });

  it("bounds a stalled Web probe so container health checks can finish", async () => {
    response.hang = true;
    const startedAt = Date.now();
    expect(await checkRuntimeHealth(options)).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(4500);
  });
});
