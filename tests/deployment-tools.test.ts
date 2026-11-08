import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runProcess } from "../scripts/lib/process.mjs";

const directories: string[] = [];
const controllers: AbortController[] = [];
const pending: Promise<unknown>[] = [];
const fixture = resolve("tests/fixtures/deployment-child.mjs");

function directory() {
  const base = resolve(".test-tmp");
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "deployment-process-"));
  directories.push(path);
  return path;
}

async function pid(path: string, mode: string) {
  const file = join(path, `${mode}.pid`);
  const deadline = Date.now() + 5000;
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Process fixture did not start.");
    await delay(20);
  }
  return Number(readFileSync(file, "utf8"));
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  await Promise.allSettled(pending.splice(0));
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("deployment command cleanup", () => {
  it("waits for the owned process tree to exit before reporting cancellation", async () => {
    const path = directory();
    const controller = new AbortController();
    controllers.push(controller);
    const result = runProcess(process.execPath, [fixture, path, "tree"], {
      signal: controller.signal,
      timeoutMs: 8000,
      killGraceMs: 1000,
    }).catch((error: Error) => error);
    pending.push(result);
    const parent = await pid(path, "tree");
    const descendant = await pid(path, "descendant");
    controller.abort(new Error("verification cancelled"));
    expect(await result).toMatchObject({ message: "verification cancelled" });
    expect(() => process.kill(parent, 0)).toThrow();
    // Descendants may briefly be zombies on Linux, but must no longer run.
    if (process.platform === "linux" && existsSync(`/proc/${descendant}/stat`))
      expect(readFileSync(`/proc/${descendant}/stat`, "utf8").split(") ")[1]?.[0]).toBe("Z");
    else expect(() => process.kill(descendant, 0)).toThrow();
  });

  it("enforces a deadline even when a process ignores SIGTERM", async () => {
    const path = directory();
    const result = runProcess(process.execPath, [fixture, path, "ignore"], {
      timeoutMs: 1500,
      killGraceMs: 100,
    }).catch((error: Error) => error);
    pending.push(result);
    const child = await pid(path, "ignore");
    expect(await result).toBeInstanceOf(Error);
    expect(await result).toMatchObject({ message: expect.stringContaining("timed out") });
    expect(() => process.kill(child, 0)).toThrow();
  });

  it("does not start a process after cancellation", async () => {
    const path = directory();
    const controller = new AbortController();
    controller.abort(new Error("cancelled before startup"));
    await expect(
      runProcess(process.execPath, [fixture, path, "ignore"], { signal: controller.signal }),
    ).rejects.toThrow("cancelled before startup");
    expect(existsSync(join(path, "ignore.pid"))).toBe(false);
  });
});
