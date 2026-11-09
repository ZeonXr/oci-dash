import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { runProcess, type RunProcessOptions } from "./lib/process.ts";

export interface BackupOptions {
  destination: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface BackupDataMount {
  type: "volume" | "bind";
  source: string;
  argument: string;
}

function windowsAbsolute(path: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(path) && win32.isAbsolute(path);
}

/** Use the daemon's mounted source; it need not exist in the CLI host's filesystem. */
export function dataMountForBackup(mounts: unknown): BackupDataMount {
  if (!Array.isArray(mounts)) throw new Error("Docker returned invalid container mounts.");
  const candidates = mounts.filter(
    (mount: unknown) =>
      typeof mount === "object" &&
      mount !== null &&
      "Destination" in mount &&
      mount.Destination === "/data",
  );
  if (candidates.length !== 1) throw new Error("Expected exactly one /data mount.");
  const data: unknown = candidates[0];
  if (typeof data !== "object" || data === null || !("Type" in data))
    throw new Error("Docker returned an invalid /data mount.");
  let type: BackupDataMount["type"];
  let source: string;
  if (
    data.Type === "volume" &&
    "Name" in data &&
    typeof data.Name === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(data.Name)
  ) {
    type = "volume";
    source = data.Name;
  } else if (
    data.Type === "bind" &&
    "Source" in data &&
    typeof data.Source === "string" &&
    !/[\u0000-\u001f\u007f]/.test(data.Source) &&
    (posix.isAbsolute(data.Source) || windowsAbsolute(data.Source))
  ) {
    type = "bind";
    source = data.Source;
  } else {
    throw new Error("Backup requires a named volume or an absolute bind source mounted at /data.");
  }
  // Docker --mount uses CSV. Quote the whole field, preserving commas and quotes
  // in a bind directory without allowing them to add mount options.
  const sourceField = `"source=${source.replaceAll('"', '""')}"`;
  return { type, source, argument: `type=${type},${sourceField},target=/data,readonly` };
}

/** Compare only recognizable path spaces; a remote daemon source is not a local realpath. */
export function assertDestinationOutsideData(data: BackupDataMount, destination: string): void {
  if (data.type !== "bind") return;
  const candidates = [
    resolve(destination),
    join(realpathSync(dirname(destination)), basename(destination)),
  ];
  for (const candidate of candidates) {
    const paths =
      windowsAbsolute(data.source) && windowsAbsolute(candidate)
        ? win32
        : posix.isAbsolute(data.source) && posix.isAbsolute(candidate)
          ? posix
          : undefined;
    if (!paths) continue;
    const compared = paths.relative(data.source, candidate);
    if (
      compared === "" ||
      (!compared.startsWith(`..${paths.sep}`) && compared !== ".." && !paths.isAbsolute(compared))
    )
      throw new Error("Backups must be stored outside the mounted /data directory.");
  }
}

const repository = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function inside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function prepareDestination(destination: string, projectDirectory = repository): string {
  if (!destination || !destination.endsWith(".tar.gz"))
    throw new Error("Provide a new .tar.gz destination outside the project directory.");
  const path = resolve(destination);
  if (inside(projectDirectory, path))
    throw new Error("Backups must be stored outside the project.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (inside(realpathSync(projectDirectory), realpathSync(dirname(path))))
    throw new Error("The backup directory resolves inside the project.");
  if (existsSync(path))
    throw new Error("The destination already exists; it will not be overwritten.");
  return path;
}

/** Back up an existing Compose app without changing its image or initial running state. */
export async function backup({
  destination,
  cwd = repository,
  env = process.env,
  signal,
}: BackupOptions): Promise<string> {
  const path = prepareDestination(destination, repository);
  const runId = randomUUID();
  const helper = `oci-dash-backup-${runId}`;
  const partial = `${path}.partial-${runId}`;
  const docker = (args: string[], options: RunProcessOptions = {}) =>
    runProcess("docker", args, { cwd, env, ...options });
  const ids = (await docker(["compose", "ps", "--all", "--quiet", "app"]))
    .split(/\s+/)
    .filter(Boolean);
  if (ids.length !== 1)
    throw new Error(
      "Expected one existing Compose app container. Deploy it before making a backup.",
    );
  const id = ids[0];
  const state = await docker(["inspect", "--format", "{{.State.Status}}", id]);
  if (!["running", "exited", "created"].includes(state))
    throw new Error(`Cannot back up an app in state ${state}; wait until it is stable.`);
  const mounts: unknown = JSON.parse(await docker(["inspect", "--format", "{{json .Mounts}}", id]));
  const data = dataMountForBackup(mounts);
  assertDestinationOutsideData(data, path);
  const image = await docker(["inspect", "--format", "{{.Image}}", id]);
  const mount = data.argument;
  const wasRunning = state === "running";
  let fd: number | undefined;
  let failure: unknown;
  let archiveComplete = false;
  try {
    fd = openSync(partial, "wx", 0o600);
    signal?.throwIfAborted();
    if (wasRunning) await docker(["stop", "--time", "35", id], { timeoutMs: 45_000 });
    signal?.throwIfAborted();
    // Read legacy node-owned and new root-owned data from the read-only mount.
    // The host process writes the archive from stdout.
    await docker(
      [
        "run",
        "--rm",
        "--name",
        helper,
        "--label",
        `oci-dash.backup-run=${runId}`,
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--security-opt",
        "no-new-privileges:true",
        "--mount",
        mount,
        "--entrypoint",
        "tar",
        image,
        "-C",
        "/data",
        "-czf",
        "-",
        `--exclude=*.partial-${runId}`,
        ".",
      ],
      { outputFd: fd, timeoutMs: 10 * 60_000, signal },
    );
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // Detect truncated gzip streams before publishing the archive as a completed backup.
    await pipeline(
      createReadStream(partial),
      createGunzip(),
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      { signal },
    );
    linkSync(partial, path); // Atomic no-clobber publication on the same filesystem.
    archiveComplete = true;
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      if (fd !== undefined) closeSync(fd);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      if (existsSync(partial)) unlinkSync(partial);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const label = await docker([
        "inspect",
        "--format",
        '{{index .Config.Labels "oci-dash.backup-run"}}',
        helper,
      ]).catch(() => null);
      if (label === runId) await docker(["rm", "--force", helper]);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...cleanupErrors],
        "Backup cleanup failed; the original app will still be restarted if it was running.",
      );
    if (wasRunning) {
      try {
        await docker(["start", id]);
      } catch (error) {
        failure = new AggregateError(
          [...(failure ? [failure] : []), error],
          `Could not restart the original app container. ${archiveComplete ? `Backup saved at ${path}.` : "No completed backup was created."}`,
        );
      }
    }
  }
  if (failure) throw failure;
  return path;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: npm run backup -- /path/outside/project/backup.tar.gz\nBriefly stops a running app, saves its complete /data named volume or bind directory, then restores its running state. Store the archive outside both the project and the data directory.\nUses the current Docker Compose project selection. Protect the archive: it includes the stored encryption key. Legacy deployments may still require a separate MASTER_KEY backup.",
    );
  } else if (process.argv.length !== 3) {
    console.error("Usage: npm run backup -- /path/outside/project/backup.tar.gz");
    process.exitCode = 1;
  } else {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("Backup interrupted."));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      const path = await backup({ destination: process.argv[2], signal: controller.signal });
      console.log(
        `Backup saved: ${path}\nProtect this archive and any legacy external MASTER_KEY. The original app running state was restored.`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Backup failed.");
      if (error instanceof AggregateError)
        for (const cause of error.errors as unknown[])
          console.error(cause instanceof Error ? cause.message : "Backup cleanup failed.");
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
