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
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { runProcess } from "./lib/process.mjs";

const repository = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function prepareDestination(destination, projectDirectory = repository) {
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
export async function backup({ destination, cwd = repository, env = process.env, signal } = {}) {
  const path = prepareDestination(destination, repository);
  const runId = randomUUID();
  const helper = `oci-dash-backup-${runId}`;
  const partial = `${path}.partial-${runId}`;
  const docker = (args, options = {}) => runProcess("docker", args, { cwd, env, ...options });
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
  const mounts = JSON.parse(await docker(["inspect", "--format", "{{json .Mounts}}", id]));
  const data = mounts.find((mount) => mount.Destination === "/data");
  if (!data || data.Type !== "volume")
    throw new Error("This backup command requires the default named /data volume.");
  const image = await docker(["inspect", "--format", "{{.Image}}", id]);
  const mount = `type=volume,source=${data.Name},target=/data,readonly`;
  const wasRunning = state === "running";
  let fd;
  let failure;
  let archiveComplete = false;
  try {
    fd = openSync(partial, "wx", 0o600);
    signal?.throwIfAborted();
    if (wasRunning) await docker(["stop", "--time", "35", id], { timeoutMs: 45_000 });
    signal?.throwIfAborted();
    // The helper uses the same immutable image and the application's unprivileged user.
    // Host redirection avoids root-owned files and works with cap_drop: ALL.
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
        "node",
        "--cap-drop",
        "ALL",
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
    const cleanupErrors = [];
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
      "Usage: npm run backup -- /path/outside/project/backup.tar.gz\nBriefly stops a running app, saves its complete data volume, then restores its running state.\nUses the current Docker Compose project selection. Keep the matching MASTER_KEY separately.",
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
        `Backup saved: ${path}\nKeep the matching MASTER_KEY separately. The original app running state was restored.`,
      );
    } catch (error) {
      console.error(error.message);
      if (error instanceof AggregateError)
        for (const cause of error.errors) console.error(cause.message);
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  }
}
