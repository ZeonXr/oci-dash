import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { createConsoleGateway } from "./server/console/gateway";
import { createConsoleManager, type ConsoleManager } from "./server/console/manager";
import { createConsoleTransport } from "./server/console/transport";
import { closeDatabase } from "./server/db";
import {
  startRuntimeSupervisor,
  type RuntimeSupervisor,
  type ShutdownSignal,
} from "./server/runtime/supervisor";
import { clearRuntimeState, writeRuntimeState } from "./server/runtime/state";

async function privateWebPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate Web port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function main(): Promise<void> {
  const workerId = randomUUID();
  const owner = { supervisorPid: process.pid, workerId };
  let supervisor: RuntimeSupervisor | undefined;
  let manager: ConsoleManager | undefined;
  let gateway: ReturnType<typeof createConsoleGateway> | undefined;
  let pendingSignal: ShutdownSignal | undefined;
  let gatewayFailure = false;
  const stop = (signal: ShutdownSignal) => {
    pendingSignal = signal;
    if (supervisor) supervisor.stop(signal);
    if (gateway)
      void gateway.close().catch(() => {
        process.exitCode = 1;
      });
  };
  const onTerm = () => stop("SIGTERM");
  const onInt = () => stop("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  try {
    clearRuntimeState();
    const cwd = process.cwd();
    const startedAt = new Date().toISOString();
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid application port");
    manager = createConsoleManager({ transport: createConsoleTransport() });
    await manager.initialize();
    if (pendingSignal) return;
    const upstreamPort = await privateWebPort();
    gateway = createConsoleGateway({ manager, upstreamPort });
    supervisor = startRuntimeSupervisor({
      commands: {
        web: {
          file: process.execPath,
          args: [resolve(cwd, "server.js")],
          env: { PORT: String(upstreamPort), HOSTNAME: "127.0.0.1" },
        },
        worker: { file: process.execPath, args: [resolve(cwd, "dist/worker.mjs")] },
      },
      cwd,
      env: { ...process.env, OCI_DASH_WORKER_ID: workerId },
      onStarted(pids) {
        writeRuntimeState({ ...owner, webPid: pids.web, workerPid: pids.worker, startedAt });
      },
    });
    if (pendingSignal) stop(pendingSignal);
    else {
      await gateway.listen(port, process.env.HOSTNAME ?? "0.0.0.0");
      gateway.server.on("error", () => {
        gatewayFailure = true;
        stop("SIGTERM");
      });
      console.log(`[runtime][gateway] Application listening on port ${port}.`);
    }
    const result = await supervisor.completion;
    process.exitCode = result.exitCode || (gatewayFailure ? 1 : (process.exitCode ?? 0));
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
    try {
      if (gateway) await gateway.close();
      else await manager?.shutdown();
    } catch {
      process.exitCode = 1;
    }
    closeDatabase();
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
