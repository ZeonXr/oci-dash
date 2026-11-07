import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  startRuntimeSupervisor,
  type RuntimeSupervisor,
  type ShutdownSignal,
} from "./server/runtime/supervisor";
import { clearRuntimeState, writeRuntimeState } from "./server/runtime/state";

async function main(): Promise<void> {
  const workerId = randomUUID();
  const owner = { supervisorPid: process.pid, workerId };
  let supervisor: RuntimeSupervisor | undefined;
  let pendingSignal: ShutdownSignal | undefined;
  const stop = (signal: ShutdownSignal) => {
    if (supervisor) supervisor.stop(signal);
    else pendingSignal = signal;
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    clearRuntimeState();
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    supervisor = startRuntimeSupervisor({
      commands: {
        web: { file: process.execPath, args: [resolve(cwd, "server.js")] },
        worker: { file: process.execPath, args: [resolve(cwd, "dist/worker.mjs")] },
      },
      cwd,
      env: { ...process.env, OCI_DASH_WORKER_ID: workerId },
      onStarted(pids) {
        writeRuntimeState({ ...owner, webPid: pids.web, workerPid: pids.worker, startedAt });
      },
    });
    if (pendingSignal) supervisor.stop(pendingSignal);
    const result = await supervisor.completion;
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(
      "[runtime][supervisor] Startup failed:",
      error instanceof Error ? error.message : "Unknown error",
    );
    process.exitCode = 1;
    if (supervisor) {
      supervisor.stop();
      await supervisor.completion;
    }
  } finally {
    process.removeListener("SIGTERM", onTerm);
    process.removeListener("SIGINT", onInt);
    try {
      clearRuntimeState(owner);
    } catch (error) {
      console.error(
        "[runtime][supervisor] State cleanup failed:",
        error instanceof Error ? error.message : "Unknown error",
      );
      process.exitCode = 1;
    }
  }
}
void main();
