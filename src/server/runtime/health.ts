import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNTIME_STATE_PATH, type RuntimeState } from "./state";
import { ormFor } from "../database/client";
import { jobWorkers } from "../database/schema";

interface HealthOptions {
  statePath?: string;
  databasePath?: string;
  port?: number;
}

function processExists(pid: unknown): pid is number {
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

export async function checkRuntimeHealth(options: HealthOptions = {}): Promise<boolean> {
  let database: Database.Database | undefined;
  try {
    const state = JSON.parse(
      readFileSync(options.statePath ?? RUNTIME_STATE_PATH, "utf8"),
    ) as RuntimeState;
    if (
      !state ||
      !processExists(state.supervisorPid) ||
      !processExists(state.webPid) ||
      !processExists(state.workerPid) ||
      typeof state.workerId !== "string" ||
      !state.workerId ||
      !Number.isFinite(Date.parse(state.startedAt))
    ) {
      return false;
    }

    // Health probes must never create a database, run migrations, or renew a heartbeat.
    database = new Database(
      options.databasePath ?? resolve(process.env.DATABASE_PATH ?? "data/oci-dash.db"),
      { readonly: true, fileMustExist: true, timeout: 1000 },
    );
    const worker = ormFor(database)
      .select({
        lastHeartbeatAt: jobWorkers.lastHeartbeatAt,
        leaseSeconds: jobWorkers.leaseSeconds,
        stoppedAt: jobWorkers.stoppedAt,
      })
      .from(jobWorkers)
      .where(eq(jobWorkers.id, state.workerId))
      .get();
    const heartbeat = worker ? Date.parse(worker.lastHeartbeatAt) : NaN;
    const now = Date.now();
    if (
      !worker ||
      worker.stoppedAt ||
      !Number.isFinite(heartbeat) ||
      !Number.isFinite(worker.leaseSeconds) ||
      worker.leaseSeconds <= 0 ||
      heartbeat < Date.parse(state.startedAt) ||
      heartbeat > now ||
      heartbeat + worker.leaseSeconds * 1000 <= now
    ) {
      return false;
    }
    database.close();
    database = undefined;

    const port = options.port ?? Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}
