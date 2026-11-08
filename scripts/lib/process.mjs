import { spawn } from "node:child_process";

// Arguments are passed directly to the executable, never interpolated into a shell.
export function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(options.signal.reason ?? new Error("Process cancelled."));
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: options.inherit
        ? "inherit"
        : [options.inputFd ?? "ignore", options.outputFd ?? "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancelled = false;
    let spawnError;
    let forceTimer;
    function stop(force = false) {
      if (!child.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill());
      } else {
        try {
          process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(force ? "SIGKILL" : "SIGTERM");
        }
      }
    }
    function terminate() {
      stop();
      forceTimer ??= setTimeout(() => stop(true), options.killGraceMs ?? 5_000);
    }
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? 45_000);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024);
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      options.signal?.removeEventListener("abort", onAbort);
      // Cleanup starts only after the process and its output streams have closed.
      if (spawnError) reject(spawnError);
      else if (cancelled) reject(options.signal.reason ?? new Error("Process cancelled."));
      else if (code === 0 && !timedOut) resolve(stdout.trim());
      else
        reject(
          new Error(
            `${file} ${timedOut ? "timed out" : `exited with ${code ?? signal}`}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
          ),
        );
    });
  });
}
