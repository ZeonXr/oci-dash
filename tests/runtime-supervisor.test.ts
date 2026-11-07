import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  startRuntimeSupervisor,
  type RuntimeCommand,
  type RuntimeLogEvent,
  type RuntimeRole,
  type RuntimeSupervisor,
  type RuntimeSupervisorOptions,
} from "@/server/runtime/supervisor";
import { clearRuntimeState, writeRuntimeState, type RuntimeState } from "@/server/runtime/state";

const fixturePath = fileURLToPath(new URL("./fixtures/runtime-child.mjs", import.meta.url));
const directories: { directory: string; base: string }[] = [];
const supervisors: RuntimeSupervisor[] = [];
function directory(): string {
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const created = mkdtempSync(join(base, "oci-dash-runtime-test-"));
  directories.push({ directory: created, base });
  return created;
}
function command(
  path: string,
  role: RuntimeRole,
  mode = "wait",
  exit = 0,
  delay = 20,
): RuntimeCommand {
  return {
    file: process.execPath,
    args: [fixturePath, role, mode, path, String(exit), String(delay)],
  };
}
function launch(
  path: string,
  commands = { web: command(path, "web"), worker: command(path, "worker") },
  overrides: Partial<RuntimeSupervisorOptions> = {},
) {
  const events: RuntimeLogEvent[] = [];
  const handle = startRuntimeSupervisor({
    commands,
    cwd: path,
    env: { ...process.env, RUNTIME_FIXTURE_MARKER: "offline-runtime-test" },
    shutdownTimeoutMs: 1000,
    logger: (event) => events.push(event),
    ...overrides,
  });
  supervisors.push(handle);
  return { handle, events };
}
function ready(
  path: string,
  role: RuntimeRole,
): { pid: number; cwd: string; marker: string } | null {
  try {
    return JSON.parse(readFileSync(join(path, `${role}.ready`), "utf8"));
  } catch {
    return null;
  }
}
async function waitForChildren(path: string, handle: RuntimeSupervisor): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!ready(path, "web") || !ready(path, "worker")) {
    if (handle.getChildren().some((child) => child.closed))
      throw new Error("A fixture exited before becoming ready");
    if (Date.now() >= deadline) throw new Error("Runtime fixtures did not become ready");
    await sleep(10);
  }
}
async function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Supervisor did not finish")), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function expectStopped(handle: RuntimeSupervisor): void {
  for (const child of handle.getChildren()) {
    expect(child.closed).toBe(true);
    if (child.pid) expect(() => process.kill(child.pid!, 0)).toThrow();
  }
}
afterEach(async () => {
  for (const handle of supervisors.splice(0)) {
    handle.stop();
    try {
      await bounded(handle.completion);
    } catch (error) {
      // Only PIDs created by this test's supervisor are eligible for emergency cleanup.
      for (const child of handle.getChildren())
        if (child.pid && !child.exited && !child.closed) {
          try {
            process.kill(child.pid, "SIGKILL");
          } catch {
            /* Child already exited. */
          }
        }
      throw error;
    }
  }
  for (const { directory: path, base } of directories.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== base || !basename(target).startsWith("oci-dash-runtime-test-"))
      throw new Error("Unsafe runtime fixture cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});

describe("production process supervisor with real offline Node children", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "stops both children on %s and waits for their exit",
    async (signal) => {
      const path = directory();
      const { handle, events } = launch(path);
      await waitForChildren(path, handle);
      for (const role of ["web", "worker"] as const) {
        expect(ready(path, role)).toMatchObject({ cwd: path, marker: "offline-runtime-test" });
        expect(events.some((event) => event.type === "started" && event.role === role)).toBe(true);
      }
      handle.stop(signal);
      const result = await bounded(handle.completion);
      expect(result).toMatchObject({
        exitCode: 0,
        reason: "shutdown",
        forced: false,
        failures: [],
      });
      expect(
        events
          .filter((event) => event.type === "stopping" && event.role !== "supervisor")
          .map((event) => event.role),
      ).toEqual(["web", "worker"]);
      // Windows child.kill terminates the process; Unix delivers the catchable signal.
      if (process.platform !== "win32") {
        expect(readFileSync(join(path, "web.signal"), "utf8")).toBe(signal);
        expect(readFileSync(join(path, "worker.signal"), "utf8")).toBe(signal);
      }
      expectStopped(handle);
    },
  );

  it.each([
    ["web", 0],
    ["web", 7],
    ["worker", 0],
    ["worker", 7],
  ] as const)(
    "treats unexpected %s exit %i as a failure and stops its peer",
    async (role, code) => {
      const path = directory();
      const commands = { web: command(path, "web"), worker: command(path, "worker") };
      commands[role] = command(path, role, "exit", code);
      const { handle } = launch(path, commands);
      await waitForChildren(path, handle);
      writeFileSync(join(path, `${role}.exit`), "exit");
      const result = await bounded(handle.completion);
      expect(result).toMatchObject({ exitCode: 1, reason: "child-exit", forced: false });
      expect(result.failures[0]).toMatchObject({ role, reason: "child-exit", exitCode: code });
      expectStopped(handle);
    },
  );

  it.each(["web", "worker"] as const)(
    "fails when %s cannot spawn and leaves no peer running",
    async (role) => {
      const path = directory();
      const commands = { web: command(path, "web"), worker: command(path, "worker") };
      commands[role] = { file: join(path, "missing-node-executable"), args: [] };
      const { handle } = launch(path, commands);
      const result = await bounded(handle.completion);
      expect(result).toMatchObject({ exitCode: 1, reason: "spawn-error" });
      expect(result.failures[0]?.role).toBe(role);
      expectStopped(handle);
    },
  );

  it("stops both processes if post-spawn runtime initialization fails", async () => {
    const path = directory();
    const { handle } = launch(path, undefined, {
      onStarted() {
        throw new Error("Cannot publish runtime state");
      },
    });
    const result = await bounded(handle.completion);
    expect(result).toMatchObject({ exitCode: 1, reason: "startup-error" });
    expect(result.failures[0]?.message).toContain("Cannot publish runtime state");
    expectStopped(handle);
  });

  it.skipIf(process.platform === "win32")(
    "allows both Unix children to finish graceful cleanup before resolving",
    async () => {
      const path = directory();
      const { handle } = launch(path, {
        web: command(path, "web", "wait", 0, 150),
        worker: command(path, "worker", "wait", 0, 80),
      });
      await waitForChildren(path, handle);
      const start = Date.now();
      handle.stop();
      const result = await bounded(handle.completion);
      expect(Date.now() - start).toBeGreaterThanOrEqual(120);
      expect(result.exitCode).toBe(0);
      expectStopped(handle);
    },
  );

  it.skipIf(process.platform === "win32")(
    "force-kills a Unix child that ignores termination and reports failure",
    async () => {
      const path = directory();
      const { handle, events } = launch(
        path,
        { web: command(path, "web", "ignore"), worker: command(path, "worker") },
        { shutdownTimeoutMs: 120 },
      );
      await waitForChildren(path, handle);
      handle.stop();
      const result = await bounded(handle.completion);
      expect(result).toMatchObject({ exitCode: 1, reason: "shutdown-timeout", forced: true });
      expect(result.children.find((child) => child.role === "web")?.signal).toBe("SIGKILL");
      expect(events.some((event) => event.role === "web" && event.type === "force-stop")).toBe(
        true,
      );
      expectStopped(handle);
    },
  );

  it.skipIf(process.platform === "win32")(
    "does not hide a child's error exit during graceful shutdown",
    async () => {
      const path = directory();
      const { handle } = launch(path, {
        web: command(path, "web"),
        worker: command(path, "worker", "wait", 9),
      });
      await waitForChildren(path, handle);
      handle.stop();
      const result = await bounded(handle.completion);
      expect(result.exitCode).toBe(1);
      expect(
        result.failures.some((failure) => failure.role === "worker" && failure.exitCode === 9),
      ).toBe(true);
      expectStopped(handle);
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ] as const)("accepts Next.js graceful %s exit code %i", async (signal, code) => {
    const path = directory();
    const { handle } = launch(path, {
      web: command(path, "web", "wait", code),
      worker: command(path, "worker"),
    });
    await waitForChildren(path, handle);
    handle.stop(signal);
    const result = await bounded(handle.completion);
    expect(result).toMatchObject({ exitCode: 0, reason: "shutdown", failures: [] });
    expectStopped(handle);
  });

  it("still treats an unsolicited signal-style exit code as a failure", async () => {
    const path = directory();
    const { handle } = launch(path, {
      web: command(path, "web", "exit", 143),
      worker: command(path, "worker"),
    });
    await waitForChildren(path, handle);
    writeFileSync(join(path, "web.exit"), "exit");
    const result = await bounded(handle.completion);
    expect(result).toMatchObject({ exitCode: 1, reason: "child-exit" });
    expectStopped(handle);
  });
});

describe("ephemeral runtime state", () => {
  it("atomically publishes process identity without leaving a temporary file", () => {
    const path = directory();
    const statePath = join(path, "runtime.json");
    const state: RuntimeState = {
      supervisorPid: process.pid,
      webPid: 101,
      workerPid: 102,
      workerId: "test-worker-identity",
      startedAt: new Date().toISOString(),
    };
    writeFileSync(statePath, "stale state");
    clearRuntimeState(undefined, statePath);
    writeRuntimeState(state, statePath);
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual(state);
    expect(readdirSync(path)).toEqual(["runtime.json"]);
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("only removes the state belonging to the exiting runtime", () => {
    const statePath = join(directory(), "runtime.json");
    const state: RuntimeState = {
      supervisorPid: process.pid,
      webPid: 101,
      workerPid: 102,
      workerId: "new-worker-identity",
      startedAt: new Date().toISOString(),
    };
    writeRuntimeState(state, statePath);
    clearRuntimeState({ supervisorPid: process.pid, workerId: "old-worker-identity" }, statePath);
    expect(existsSync(statePath)).toBe(true);
    clearRuntimeState(state, statePath);
    expect(existsSync(statePath)).toBe(false);
  });
});
