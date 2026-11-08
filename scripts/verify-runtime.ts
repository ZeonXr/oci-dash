import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Every destructive check targets resources created here. No host .env, existing
// database, published port, or external network is used by this verification.
const runId = randomUUID();
const name = `oci-dash-runtime-test-${runId}`;
const volume = `${name}-data`;
const image = "oci-dash:local";

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 45_000,
  }).trim();
}
const execute = (code: string): string => docker("exec", name, "node", "-e", code);
interface ContainerState {
  Running: boolean;
  ExitCode: number;
}
interface RuntimeIdentity {
  webPid: number;
  workerPid: number;
  workerId: string;
}
interface ShutdownProbe {
  stopped: boolean;
  users: string;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseObject(text: string, description: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  assert.ok(isRecord(value), `${description} must be a JSON object`);
  return value;
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function inspect(): ContainerState {
  const value = parseObject(
    docker("inspect", "--format", "{{json .State}}", name),
    "Container state",
  );
  assert.ok(typeof value.Running === "boolean", "Container running state must be boolean");
  assert.ok(
    typeof value.ExitCode === "number" && Number.isSafeInteger(value.ExitCode),
    "Container exit code must be an integer",
  );
  return { Running: value.Running, ExitCode: value.ExitCode };
}
const restarts = (): number => Number(docker("inspect", "--format", "{{.RestartCount}}", name));
function runtime(): RuntimeIdentity {
  const value = parseObject(
    execute("console.log(require('node:fs').readFileSync('/tmp/oci-dash-runtime.json','utf8'))"),
    "Runtime identity",
  );
  assert.ok(positiveInteger(value.webPid), "Runtime Web PID must be a positive integer");
  assert.ok(positiveInteger(value.workerPid), "Runtime worker PID must be a positive integer");
  assert.ok(
    typeof value.workerId === "string" && value.workerId.length > 0,
    "Runtime worker identity must be a nonempty string",
  );
  return { webPid: value.webPid, workerPid: value.workerPid, workerId: value.workerId };
}
function shutdownProbe(text: string): ShutdownProbe {
  const value = parseObject(text, "Shutdown probe");
  assert.ok(typeof value.stopped === "boolean", "Shutdown status must be boolean");
  assert.ok(typeof value.users === "string", "Shutdown users must be a string");
  return { stopped: value.stopped, users: value.users };
}
function healthy(): boolean {
  return (
    spawnSync("docker", ["exec", name, "node", "dist/health.mjs"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 7000,
    }).status === 0
  );
}
async function waitFor(check: () => boolean, description: string, timeout = 60_000): Promise<void> {
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
const accountIdentity = (): string =>
  execute(
    "const D=require('better-sqlite3');const d=new D('/data/oci-dash.db',{readonly:true});console.log(d.prepare('SELECT id FROM users ORDER BY id').pluck().all().join(','));d.close();",
  );
const initializationIdentity = (): string =>
  execute(
    "const f=require('node:fs');const c=require('node:crypto');const a=require('node:assert/strict');const files=['/data/.master-key','/data/.initial-admin-password'];for(const p of files)a.equal(f.statSync(p).mode&0o777,0o600);a.equal(f.readFileSync(files[0]).length,32);console.log(c.createHash('sha256').update(f.readFileSync(files[0])).update(f.readFileSync(files[1])).digest('hex'));",
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
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    image,
  );
  containerCreated = true;
  await waitFor(healthy, "initial Web and worker health");
  assert.equal(
    execute("console.log(require('node:fs').readFileSync('/proc/1/comm','utf8').trim())"),
    "tini",
    "The image must provide its own PID 1 without Docker's --init flag",
  );
  const admin = accountIdentity();
  const initialization = initializationIdentity();
  assert.ok(admin);
  assert.equal(
    execute(
      "const a=require('node:assert/strict');const password=require('node:fs').readFileSync('/data/.initial-admin-password','utf8').trim();fetch('http://127.0.0.1:3000/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:3000'},body:JSON.stringify({username:'admin',password})}).then(async r=>{a.equal(r.status,200);a.ok(r.headers.get('set-cookie')?.includes('HttpOnly'));console.log('ok')});",
    ),
    "ok",
  );
  console.log(
    "PASS: container initializes and accepts its generated administrator without environment configuration",
  );

  for (const role of ["worker", "web"] as const) {
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
    assert.equal(
      initializationIdentity(),
      initialization,
      "Generated secrets must survive restarts",
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
  const result = shutdownProbe(probe);
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
  const cleanupErrors: string[] = [];
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
      cleanupErrors.push(args.at(-1) ?? "unknown test resource");
    }
  }
  if (cleanupErrors.length)
    throw new Error(`Could not remove test resources: ${cleanupErrors.join(", ")}`);
}
