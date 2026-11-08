import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { backup, prepareDestination } from "./backup.ts";
import type { BackupOptions } from "./backup.ts";
import { runProcess } from "./lib/process.ts";
import type { RunProcessOptions } from "./lib/process.ts";

interface BackupFixtureCompose {
  name: string;
  services: {
    app: {
      image: string;
      user: string;
      command: string[];
      network_mode: "none";
      cap_drop: string[];
      security_opt: string[];
      restart: "no";
      volumes: string[];
      healthcheck: { test: string[]; interval: string; timeout: string; retries: number };
    };
  };
  volumes: { "app-data": Record<string, never> };
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const base = resolve(repository, ".test-tmp");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "backup-"));
const archives = mkdtempSync(join(tmpdir(), "oci-dash-backup-test-"));
const project = `oci-dash-backup-test-${randomUUID()}`;
const composeFile = join(directory, "compose.json");
const image = "oci-dash:local";
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Backup verification interrupted."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const env: NodeJS.ProcessEnv = {
  ...process.env,
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: composeFile,
};
delete env.COMPOSE_ENV_FILES;
const fixture = `
const fs = require('node:fs');
const Database = require('better-sqlite3');
const db = new Database('/data/backup-fixture.db');
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS proof (value TEXT); DELETE FROM proof');
db.prepare('INSERT INTO proof VALUES (?)').run('backup-fixture');
fs.chmodSync('/data/backup-fixture.db', 0o600);
fs.writeFileSync('/data/.master-key', Buffer.alloc(32, 0x5a), {mode: 0o600});
fs.chmodSync('/data/.master-key', 0o600);
fs.writeFileSync('/data/ready', 'ready', {mode: 0o600});
setInterval(() => {}, 1000);
`;
const composeConfiguration: BackupFixtureCompose = {
  name: project,
  services: {
    app: {
      image,
      user: "node",
      command: ["node", "-e", fixture],
      network_mode: "none",
      cap_drop: ["ALL"],
      security_opt: ["no-new-privileges:true"],
      restart: "no",
      volumes: ["app-data:/data"],
      healthcheck: {
        test: [
          "CMD",
          "node",
          "-e",
          "process.exit(require('node:fs').existsSync('/data/ready') ? 0 : 1)",
        ],
        interval: "1s",
        timeout: "3s",
        retries: 15,
      },
    },
  },
  volumes: { "app-data": {} },
};
writeFileSync(composeFile, JSON.stringify(composeConfiguration));
const docker = (args: string[], options: RunProcessOptions = {}): Promise<string> =>
  runProcess("docker", args, { cwd: directory, env, signal: controller.signal, ...options });
const compose = (...args: string[]): Promise<string> =>
  docker(["compose", "--project-name", project, "--file", composeFile, ...args]);
let started = false;
try {
  assert.throws(() => prepareDestination(join(repository, "backups", "test.tar.gz")), /outside/);
  started = true;
  await compose("up", "--detach", "--wait", "--wait-timeout", "30");
  const id = await compose("ps", "--quiet", "app");
  const state = (): Promise<string> => docker(["inspect", "--format", "{{.State.Running}}", id]);
  const destination = join(archives, "running.tar.gz");
  const backupOptions: BackupOptions = {
    destination,
    cwd: directory,
    env,
    signal: controller.signal,
  };
  await backup(backupOptions);
  assert.equal(await state(), "true", "A previously running app must restart after backup.");
  if (process.platform !== "win32") assert.equal(statSync(destination).mode & 0o777, 0o600);
  const fd = openSync(destination, "r");
  try {
    const restored = await docker(
      [
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--user",
        "node",
        "--cap-drop",
        "ALL",
        "--tmpfs",
        "/restore:rw,uid=1000,gid=1000,mode=0700",
        "--entrypoint",
        "node",
        image,
        "-e",
        `
require('node:child_process').execFileSync('tar',['-xzf','-','-C','/restore'],{stdio:['inherit','ignore','inherit']});
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.ok(fs.readFileSync('/restore/.master-key').equals(Buffer.alloc(32, 0x5a)), 'The full-volume archive must preserve the hidden master key.');
assert.equal(fs.statSync('/restore/.master-key').mode & 0o777, 0o600, 'The restored master key must retain 0600 permissions.');
const D = require('better-sqlite3');
const d = new D('/restore/backup-fixture.db', {readonly:true});
console.log(d.prepare('SELECT value FROM proof').pluck().get());
d.close();
`,
      ],
      { inputFd: fd },
    );
    assert.equal(
      restored,
      "backup-fixture",
      "The archived database must restore with its original rows.",
    );
  } finally {
    closeSync(fd);
  }
  await assert.rejects(backup({ destination, cwd: directory, env }), /already exists/);
  console.log(
    "PASS: an unprivileged backup restores the database and hidden master key, preserves 0600 permissions and restarts only the original app",
  );

  await compose("stop", "app");
  await backup({
    destination: join(archives, "stopped.tar.gz"),
    cwd: directory,
    env,
    signal: controller.signal,
  });
  assert.equal(await state(), "false", "A stopped app must remain stopped.");
  console.log("PASS: backup preserves a stopped app and refuses to overwrite existing archives");

  await compose("start", "app");
  await docker(["exec", id, "node", "-e", "require('node:fs').chmodSync('/data',0o777)"]);
  await docker([
    "exec",
    "--user",
    "0:0",
    id,
    "node",
    "-e",
    "require('node:fs').writeFileSync('/data/unreadable','synthetic',{mode:0o600})",
  ]);
  const failed = join(archives, "failure.tar.gz");
  await assert.rejects(
    backup({ destination: failed, cwd: directory, env, signal: controller.signal }),
    /Permission denied/,
  );
  assert.equal(
    await state(),
    "true",
    "A failed archive must still restore the previous running state.",
  );
  assert.equal(existsSync(failed), false);
  assert.deepEqual(
    readdirSync(archives).filter((name) => name.includes("partial")),
    [],
  );
  console.log("PASS: archive failure restarts the app and removes the incomplete file");
} catch (error) {
  console.error(
    await docker(
      ["compose", "--project-name", project, "--file", composeFile, "logs", "--tail", "30", "app"],
      { signal: undefined },
    ).catch(() => "Could not read backup fixture logs."),
  );
  throw error;
} finally {
  let cleaned = !started;
  try {
    if (started)
      await docker(
        [
          "compose",
          "--project-name",
          project,
          "--file",
          composeFile,
          "down",
          "--volumes",
          "--remove-orphans",
        ],
        { signal: undefined },
      );
    cleaned = true;
  } finally {
    if (
      !resolve(directory).startsWith(base + sep) ||
      !resolve(archives).startsWith(resolve(tmpdir()) + sep)
    )
      throw new Error("Invalid backup test cleanup path.");
    rmSync(archives, { recursive: true, force: true });
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
    if (cleaned) rmSync(directory, { recursive: true, force: true });
    else
      console.error(
        `Remove the isolated project ${project} using ${composeFile} after Docker access recovers.`,
      );
  }
}
