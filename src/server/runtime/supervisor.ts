import { spawn, type ChildProcess } from "node:child_process";

export type RuntimeRole = "web" | "worker";
export type ShutdownSignal = "SIGTERM" | "SIGINT";
export type RuntimeFailureReason =
  "child-exit" | "spawn-error" | "signal-error" | "startup-error" | "shutdown-timeout";
export interface RuntimeCommand {
  file: string;
  args: string[];
}
export interface RuntimeChildSnapshot {
  role: RuntimeRole;
  pid: number | null;
  started: boolean;
  exited: boolean;
  closed: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}
export interface RuntimeLogEvent {
  role: RuntimeRole | "supervisor";
  type: "started" | "exit" | "error" | "stopping" | "force-stop" | "stopped";
  message: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}
export interface RuntimeFailure {
  role: RuntimeRole | "supervisor";
  reason: RuntimeFailureReason;
  message: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}
export interface RuntimeSupervisorResult {
  exitCode: 0 | 1;
  reason: "shutdown" | RuntimeFailureReason;
  forced: boolean;
  failures: RuntimeFailure[];
  children: RuntimeChildSnapshot[];
}
export interface RuntimeSupervisorOptions {
  commands: Record<RuntimeRole, RuntimeCommand>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shutdownTimeoutMs?: number;
  logger?: (event: RuntimeLogEvent) => void;
  /** Synchronous hook; failure here also stops both children and returns a failure. */
  onStarted?: (pids: Readonly<Record<RuntimeRole, number>>) => void;
}
export interface RuntimeSupervisor {
  completion: Promise<RuntimeSupervisorResult>;
  stop(signal?: ShutdownSignal): void;
  getChildren(): RuntimeChildSnapshot[];
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
const roles: RuntimeRole[] = ["web", "worker"];
interface ManagedChild extends RuntimeChildSnapshot {
  child?: ChildProcess;
  lastSignal?: NodeJS.Signals;
}
function defaultLogger(event: RuntimeLogEvent): void {
  const message = `[runtime][${event.role}] ${event.message}`;
  if (event.type === "error" || event.type === "force-stop") console.error(message);
  else console.log(message);
}
function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown process error";
  const code = (error as NodeJS.ErrnoException).code;
  return `${code ? code + ": " : ""}${error.message}`;
}

/** Process supervision only: no database, server import, cloud client, or shell. */
export function startRuntimeSupervisor(options: RuntimeSupervisorOptions): RuntimeSupervisor {
  const timeout = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout < 1) throw new TypeError("Invalid shutdown timeout");
  for (const role of roles) {
    const command = options.commands[role];
    if (
      !command ||
      typeof command.file !== "string" ||
      !command.file ||
      !Array.isArray(command.args) ||
      command.args.some((value) => typeof value !== "string")
    ) {
      throw new TypeError(`Invalid ${role} process command`);
    }
  }
  const children: ManagedChild[] = roles.map((role) => ({
    role,
    pid: null,
    started: false,
    exited: false,
    closed: false,
    exitCode: null,
    signal: null,
  }));
  const failures: RuntimeFailure[] = [];
  const logger = options.logger ?? defaultLogger;
  let starting = true,
    stopping = false,
    completed = false,
    forced = false,
    notifiedStarted = false;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let resolveCompletion!: (result: RuntimeSupervisorResult) => void;
  const completion = new Promise<RuntimeSupervisorResult>((resolve) => {
    resolveCompletion = resolve;
  });
  function log(event: RuntimeLogEvent): void {
    try {
      logger(event);
    } catch {
      process.stderr.write("[runtime][supervisor] Lifecycle logger failed.\n");
    }
  }
  function snapshots(): RuntimeChildSnapshot[] {
    return children.map(({ role, pid, started, exited, closed, exitCode, signal }) => ({
      role,
      pid,
      started,
      exited,
      closed,
      exitCode,
      signal,
    }));
  }
  function finishIfClosed(): void {
    if (starting || completed || !children.every((child) => child.closed)) return;
    completed = true;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    const exitCode = failures.length ? 1 : 0;
    log({
      role: "supervisor",
      type: "stopped",
      message: `All child processes stopped; exit code ${exitCode}.`,
      exitCode,
    });
    resolveCompletion({
      exitCode,
      reason: failures[0]?.reason ?? "shutdown",
      forced,
      failures: [...failures],
      children: snapshots(),
    });
  }
  function recordFailure(failure: RuntimeFailure): void {
    failures.push(failure);
    log({
      role: failure.role,
      type: "error",
      message: failure.message,
      exitCode: failure.exitCode,
      signal: failure.signal,
    });
  }
  function sendSignal(child: ManagedChild, signal: NodeJS.Signals): void {
    if (!child.child || child.exited || child.closed || !child.pid) return;
    child.lastSignal = signal;
    log({
      role: child.role,
      type: signal === "SIGKILL" ? "force-stop" : "stopping",
      message: `Sending ${signal} to pid ${child.pid}.`,
      pid: child.pid,
      signal,
    });
    try {
      // killed only means a signal was sent, not that the child exited. Always
      // retry with SIGKILL at the deadline even when SIGTERM was already sent.
      child.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        recordFailure({
          role: child.role,
          reason: "signal-error",
          message: `Could not send ${signal}: ${errorMessage(error)}`,
        });
    }
  }
  function beginStop(signal: ShutdownSignal = "SIGTERM"): void {
    if (stopping || completed) return;
    stopping = true;
    log({
      role: "supervisor",
      type: "stopping",
      message: `Stopping web and worker with ${signal}; grace period ${timeout}ms.`,
      signal,
    });
    shutdownTimer = setTimeout(() => {
      if (completed) return;
      forced = true;
      recordFailure({
        role: "supervisor",
        reason: "shutdown-timeout",
        message: `Shutdown grace period expired after ${timeout}ms; force-stopping remaining children.`,
      });
      for (const child of children) sendSignal(child, "SIGKILL");
      finishIfClosed();
    }, timeout);
    // Stop accepting HTTP work first, then signal the worker immediately; do not
    // spend the whole grace period waiting for one child before signalling the other.
    for (const child of children) sendSignal(child, signal);
    finishIfClosed();
  }
  function notifyStarted(): void {
    if (notifiedStarted || stopping || !children.every((child) => child.started)) return;
    notifiedStarted = true;
    try {
      options.onStarted?.({ web: children[0]!.pid!, worker: children[1]!.pid! });
    } catch (error) {
      recordFailure({
        role: "supervisor",
        reason: "startup-error",
        message: `Runtime initialization failed: ${errorMessage(error)}`,
      });
      beginStop();
    }
  }
  for (const managed of children) {
    if (stopping) {
      managed.closed = true;
      continue;
    }
    const command = options.commands[managed.role];
    try {
      const child = spawn(command.file, command.args, {
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
        stdio: ["ignore", "inherit", "inherit"],
        shell: false,
        detached: false,
        windowsHide: true,
      });
      managed.child = child;
      managed.pid = child.pid ?? null;
      child.once("spawn", () => {
        if (completed) return;
        managed.started = true;
        managed.pid = child.pid ?? null;
        log({
          role: managed.role,
          type: "started",
          message: `Started pid ${managed.pid}.`,
          pid: managed.pid ?? undefined,
        });
        notifyStarted();
      });
      child.on("error", (error) => {
        if (completed) return;
        const spawnFailed = !managed.started && !managed.pid;
        if (spawnFailed) managed.closed = true;
        recordFailure({
          role: managed.role,
          reason: spawnFailed ? "spawn-error" : "signal-error",
          message: `${spawnFailed ? "Spawn failed" : "Child process error"}: ${errorMessage(error)}`,
        });
        beginStop();
        finishIfClosed();
      });
      child.once("exit", (exitCode, signal) => {
        if (completed) return;
        managed.exited = true;
        managed.exitCode = exitCode;
        managed.signal = signal;
        log({
          role: managed.role,
          type: "exit",
          pid: managed.pid ?? undefined,
          exitCode,
          signal,
          message: `Exited (code=${exitCode ?? "null"}, signal=${signal ?? "none"}).`,
        });
        const unexpected = !stopping;
        // Next.js reports graceful termination as 128 + the handled signal.
        // Accept that code only after this supervisor sent that same signal.
        const handledSignalExit =
          (managed.lastSignal === "SIGTERM" && exitCode === 143) ||
          (managed.lastSignal === "SIGINT" && exitCode === 130);
        const failedDuringStop =
          stopping &&
          ((exitCode !== null && exitCode !== 0 && !handledSignalExit) ||
            (signal !== null && signal !== managed.lastSignal));
        if (unexpected || failedDuringStop) {
          recordFailure({
            role: managed.role,
            reason: "child-exit",
            exitCode,
            signal,
            message: unexpected
              ? "Child exited unexpectedly; stopping its peer."
              : "Child failed during shutdown.",
          });
          beginStop();
        }
      });
      child.once("close", (exitCode, signal) => {
        managed.closed = true;
        if (!managed.exited) {
          managed.exitCode = exitCode;
          managed.signal = signal;
        }
        finishIfClosed();
      });
    } catch (error) {
      managed.closed = true;
      recordFailure({
        role: managed.role,
        reason: "spawn-error",
        message: `Spawn failed: ${errorMessage(error)}`,
      });
      beginStop();
    }
  }
  starting = false;
  finishIfClosed();
  return { completion, stop: beginStop, getChildren: snapshots };
}
