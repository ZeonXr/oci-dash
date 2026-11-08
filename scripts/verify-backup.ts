import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
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
import {
  assertDestinationOutsideData,
  backup,
  dataMountForBackup,
  prepareDestination,
} from "./backup.ts";
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
      volumes: (
        | string
        | { type: "bind"; source: string; target: "/data"; bind: { create_host_path: false } }
      )[];
      healthcheck: { test: string[]; interval: string; timeout: string; retries: number };
    };
  };
  volumes?: { "app-data": Record<string, never> };
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const base = resolve(repository, ".test-tmp");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "backup-"));
const archives = mkdtempSync(join(tmpdir(), "oci-dash-backup-test-"));
const project = `oci-dash-backup-test-${randomUUID()}`;
const composeFile = join(directory, "compose.json");
const bindProject = `${project}-bind`;
const bindComposeFile = join(directory, "bind-compose.json");
const bindDirectory = join(directory, "bind data, with comma");
const image = process.env.OCI_DASH_TEST_IMAGE || "oci-dash:local";
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
const bindEnv = { ...env, COMPOSE_PROJECT_NAME: bindProject, COMPOSE_FILE: bindComposeFile };
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
const bindCompose = (...args: string[]): Promise<string> =>
  docker(["compose", "--project-name", bindProject, "--file", bindComposeFile, ...args], {
    env: bindEnv,
  });

async function verifyRestored(destination: string, expectedKeyMode = 0o600): Promise<void> {
  assert.ok(Number.isInteger(expectedKeyMode) && expectedKeyMode >= 0 && expectedKeyMode <= 0o777);
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
require('node:child_process').execFileSync('tar',['--same-permissions','-xzf','-','-C','/restore'],{stdio:['inherit','ignore','inherit']});
const fs = require('node:fs');
const assert = require('node:assert/strict');
assert.ok(fs.readFileSync('/restore/.master-key').equals(Buffer.alloc(32, 0x5a)), 'The archive must preserve the hidden master key.');
assert.equal(fs.statSync('/restore/.master-key').mode & 0o777, ${expectedKeyMode}, 'The restored master key must retain its source permissions.');
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
}

let started = false;
let bindStarted = false;
try {
  assert.throws(() => prepareDestination(join(repository, "backups", "test.tar.gz")), /outside/);
  for (const mounts of [
    null,
    [],
    [{ Destination: "/data", Type: "tmpfs" }],
    [{ Destination: "/data", Type: "bind", Source: "relative/path" }],
    [{ Destination: "/data", Type: "bind", Source: "C:relative" }],
    [{ Destination: "/data", Type: "bind", Source: "/data\nother" }],
    [{ Destination: "/data", Type: "volume", Name: "name,readonly" }],
    [
      { Destination: "/data", Type: "volume", Name: "first" },
      { Destination: "/data", Type: "volume", Name: "second" },
    ],
  ])
    assert.throws(() => dataMountForBackup(mounts));
  assert.equal(
    dataMountForBackup([
      {
        Destination: "/data",
        Type: "volume",
        Name: "fixture-data",
        Source: "/ignored/daemon/volume",
      },
    ]).source,
    "fixture-data",
  );
  assert.equal(
    dataMountForBackup([{ Destination: "/data", Type: "bind", Source: '/owned/data, "quoted"' }])
      .argument,
    'type=bind,"source=/owned/data, ""quoted""",target=/data,readonly',
  );
  assert.equal(
    dataMountForBackup([{ Destination: "/data", Type: "bind", Source: "C:\\owned data\\folder" }])
      .source,
    "C:\\owned data\\folder",
  );
  const ownSource = dataMountForBackup([{ Destination: "/data", Type: "bind", Source: archives }]);
  assert.throws(
    () => assertDestinationOutsideData(ownSource, join(archives, "self.tar.gz")),
    /outside the mounted/,
  );
  const siblingSource = dataMountForBackup([
    { Destination: "/data", Type: "bind", Source: join(archives, "data") },
  ]);
  assert.doesNotThrow(() =>
    assertDestinationOutsideData(siblingSource, join(archives, "data-other.tar.gz")),
  );
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
  await verifyRestored(destination);
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

  // Compose long syntax preserves a native Windows drive path and directories
  // containing spaces or commas. All writable data belongs to this test run.
  mkdirSync(bindDirectory, { mode: 0o777 });
  chmodSync(bindDirectory, 0o777);
  const bindConfiguration: BackupFixtureCompose = {
    name: bindProject,
    services: {
      app: {
        ...composeConfiguration.services.app,
        volumes: [
          {
            type: "bind",
            source: bindDirectory,
            target: "/data",
            bind: { create_host_path: false },
          },
        ],
      },
    },
  };
  writeFileSync(bindComposeFile, JSON.stringify(bindConfiguration));
  bindStarted = true;
  await bindCompose("up", "--detach", "--wait", "--wait-timeout", "30");
  const bindId = await bindCompose("ps", "--quiet", "app");
  const inspected: unknown = JSON.parse(
    await docker(["inspect", "--format", "{{json .Mounts}}", bindId]),
  );
  assert.equal(dataMountForBackup(inspected).type, "bind");
  const mode = Number(
    await docker([
      "exec",
      bindId,
      "node",
      "-e",
      "console.log(require('node:fs').statSync('/data/.master-key').mode & 0o777)",
    ]),
  );
  const bindState = () => docker(["inspect", "--format", "{{.State.Running}}", bindId]);
  const bindDestination = join(archives, "bind-running.tar.gz");
  await backup({
    destination: bindDestination,
    cwd: directory,
    env: bindEnv,
    signal: controller.signal,
  });
  assert.equal(await bindState(), "true", "A running bind-mounted app must restart after backup.");
  // Windows-backed directories may report 0777 even after chmod. Preserve the
  // actual source mode; do not change archive semantics just for a test.
  await verifyRestored(bindDestination, mode);
  await bindCompose("stop", "app");
  const bindStopped = join(archives, "bind-stopped.tar.gz");
  await backup({
    destination: bindStopped,
    cwd: directory,
    env: bindEnv,
    signal: controller.signal,
  });
  assert.equal(await bindState(), "false", "A stopped bind-mounted app must remain stopped.");
  await verifyRestored(bindStopped, mode);
  console.log(
    "PASS: bind-directory backups restore the database and hidden key with source permissions, preserving running and stopped states",
  );
} catch (error) {
  console.error(
    await docker(
      ["compose", "--project-name", project, "--file", composeFile, "logs", "--tail", "30", "app"],
      { signal: undefined },
    ).catch(() => "Could not read backup fixture logs."),
  );
  if (bindStarted)
    console.error(
      await docker(
        [
          "compose",
          "--project-name",
          bindProject,
          "--file",
          bindComposeFile,
          "logs",
          "--tail",
          "30",
          "app",
        ],
        { env: bindEnv, signal: undefined },
      ).catch(() => "Could not read bind fixture logs."),
    );
  throw error;
} finally {
  let cleaned = !started && !bindStarted;
  try {
    const targets = [
      ...(started ? [{ project, composeFile, env }] : []),
      ...(bindStarted
        ? [{ project: bindProject, composeFile: bindComposeFile, env: bindEnv }]
        : []),
    ];
    const results = await Promise.allSettled(
      targets.map((target) =>
        docker(
          [
            "compose",
            "--project-name",
            target.project,
            "--file",
            target.composeFile,
            "down",
            "--volumes",
            "--remove-orphans",
          ],
          { env: target.env, signal: undefined },
        ),
      ),
    );
    cleaned = results.every((result) => result.status === "fulfilled");
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Could not remove every isolated backup project");
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
        `Remove the isolated projects ${project} / ${bindProject} using their configuration in ${directory} after Docker access recovers.`,
      );
  }
}
