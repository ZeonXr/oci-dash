import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export const RUNTIME_STATE_PATH = join(tmpdir(), "oci-dash-runtime.json");
export interface RuntimeState {
  supervisorPid: number;
  webPid: number;
  workerPid: number;
  workerId: string;
  startedAt: string;
}
export function writeRuntimeState(state: RuntimeState, path = RUNTIME_STATE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function clearRuntimeState(
  owner?: Pick<RuntimeState, "supervisorPid" | "workerId">,
  path = RUNTIME_STATE_PATH,
): void {
  if (owner) {
    let current: RuntimeState;
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (current.supervisorPid !== owner.supervisorPid || current.workerId !== owner.workerId)
      return;
  }
  rmSync(path, { force: true });
}
