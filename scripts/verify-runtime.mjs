import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Every destructive check targets resources created here. No host .env, existing
// database, published port, or external network is used by this verification.
const runId = randomUUID();
const name = `oci-dash-runtime-test-${runId}`;
const volume = `${name}-data`;
const image = "oci-dash:local";
const base = resolve(".test-tmp");
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "runtime-container-"));
const envFile = join(directory, "demo.env");
writeFileSync(
  envFile,
  [
    "ADMIN_USERNAME=runtime-test",
    `ADMIN_PASSWORD=${randomBytes(24).toString("base64url")}`,
    `MASTER_KEY=${randomBytes(32).toString("base64")}`,
    "DEMO_MODE=true",
    "APP_ORIGIN=http://localhost:3000",
    "DATABASE_PATH=/data/oci-dash.db",
    "",
  ].join("\n"),
  { mode: 0o600 },
);

function docker(...args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  }).trim();
}
const execute = (code) => docker("exec", name, "node", "-e", code);
const inspect = () => JSON.parse(docker("inspect", "--format", "{{json .State}}", name));
const restarts = () => Number(docker("inspect", "--format", "{{.RestartCount}}", name));
const runtime = () =>
  JSON.parse(
    execute("console.log(require('node:fs').readFileSync('/tmp/oci-dash-runtime.json','utf8'))"),
  );
function healthy() {
  return (
    spawnSync("docker", ["exec", name, "node", "dist/health.mjs"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 7000,
    }).status === 0
  );
}
async function waitFor(check, description, timeout = 60_000) {
  const until = Date.now() + timeout;
  do {
    try {
      if (check()) return;
    } catch {
      // Container restarts briefly make exec and the runtime identity unavailable.
    }
    await delay(500);
  } while (Date.now() < until);
  throw new Error(`Timed out: ${description}`);
}
const accountIdentity = () =>
  execute(
    "const D=require('better-sqlite3');const d=new D('/data/oci-dash.db',{readonly:true});console.log(d.prepare('SELECT id FROM users ORDER BY id').pluck().all().join(','));d.close();",
  );

let containerCreated = false;
let volumeCreated = false;
try {
  docker("volume", "create", "--label", `oci-dash.test-run=${runId}`, volume);
  volumeCreated = true;
  docker(
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    `oci-dash.test-run=${runId}`,
    "--network",
    "none",
    "--init",
    "--restart",
    "unless-stopped",
    "--stop-timeout",
    "35",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--security-opt",
    "no-new-privileges:true",
    "--cap-drop",
    "ALL",
    "--env-file",
    envFile,
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    image,
  );
  containerCreated = true;
  await waitFor(healthy, "initial Web and worker health");
  const admin = accountIdentity();
  assert.ok(admin);
  console.log("PASS: isolated single container starts with Web and worker healthy");

  for (const role of ["worker", "web"]) {
    const before = runtime();
    const previousRestarts = restarts();
    execute(`process.kill(${before[`${role}Pid`]}, 'SIGKILL')`);
    await waitFor(
      () => restarts() > previousRestarts && healthy() && runtime().workerId !== before.workerId,
      `Docker recovery after ${role} failure`,
    );
    assert.equal(
      accountIdentity(),
      admin,
      "Administrator identity must survive container restarts",
    );
    console.log(
      `PASS: ${role} failure restarts the complete application and preserves its database`,
    );
  }

  const current = runtime();
  execute(`process.kill(${current.workerPid}, 'SIGSTOP')`);
  execute(
    `const D=require('better-sqlite3');const d=new D('/data/oci-dash.db');d.prepare('UPDATE job_workers SET last_heartbeat_at=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),${JSON.stringify(current.workerId)});d.close();`,
  );
  assert.equal(
    execute("fetch('http://127.0.0.1:3000/api/health').then(r=>console.log(r.status))"),
    "200",
  );
  assert.equal(healthy(), false, "Web availability must not mask an unresponsive worker");
  execute(`process.kill(${current.workerPid}, 'SIGCONT')`);
  await waitFor(healthy, "worker heartbeat resumes");
  console.log("PASS: combined health detects a stalled worker while the Web remains available");

  const beforeStop = runtime();
  docker("stop", "--time", "35", name);
  const stopped = inspect();
  assert.equal(stopped.Running, false);
  assert.equal(stopped.ExitCode, 0, "A normal stop should finish gracefully before Docker SIGKILL");
  const probe = docker(
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--mount",
    `type=volume,src=${volume},dst=/source,readonly`,
    "--tmpfs",
    "/data:rw,uid=1000,gid=1000,mode=0700",
    "--entrypoint",
    "node",
    image,
    "-e",
    `require('node:fs').cpSync('/source','/data',{recursive:true});const D=require('better-sqlite3');const d=new D('/data/oci-dash.db',{readonly:true});const w=d.prepare('SELECT stopped_at FROM job_workers WHERE id=?').get(${JSON.stringify(beforeStop.workerId)});console.log(JSON.stringify({stopped:Boolean(w?.stopped_at),users:d.prepare('SELECT id FROM users ORDER BY id').pluck().all().join(',')}));d.close();`,
  );
  const result = JSON.parse(probe);
  assert.equal(result.stopped, true, "Worker must record its graceful shutdown");
  assert.equal(result.users, admin);
  console.log("PASS: SIGTERM shuts down both processes cleanly and records the stopped worker");
} catch (error) {
  if (containerCreated) {
    try {
      const logs = spawnSync("docker", ["logs", "--tail", "60", name], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5000,
      });
      console.error((logs.stdout || "") + (logs.stderr || ""));
    } catch {
      console.error("Could not read isolated test container logs.");
    }
  }
  throw error;
} finally {
  const cleanupErrors = [];
  // A failed docker run can still leave a created container. Only remove it if
  // its label proves that this invocation created it.
  if (!containerCreated) {
    try {
      containerCreated =
        docker("inspect", "--format", '{{index .Config.Labels "oci-dash.test-run"}}', name) ===
        runId;
    } catch {
      // The container was never created.
    }
  }
  for (const args of [
    ...(containerCreated ? [["rm", "--force", name]] : []),
    ...(volumeCreated ? [["volume", "rm", volume]] : []),
  ]) {
    try {
      docker(...args);
    } catch {
      cleanupErrors.push(args.at(-1));
    }
  }
  if (!resolve(directory).startsWith(base + sep)) throw new Error("Invalid test cleanup path");
  rmSync(directory, { recursive: true, force: true });
  if (cleanupErrors.length)
    throw new Error(`Could not remove test resources: ${cleanupErrors.join(", ")}`);
}
