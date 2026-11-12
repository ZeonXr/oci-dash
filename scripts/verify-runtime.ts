import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Every destructive check targets resources created here. No host .env, existing
// database, published port, or external network is used by this verification.
const runId = randomUUID();
const name = `oci-dash-runtime-test-${runId}`;
const volume = `${name}-data`;
const image = process.env.OCI_DASH_TEST_IMAGE || "oci-dash:local";
const password = randomBytes(24).toString("base64url");

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
  pid: number;
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
    execute(
      "const a=require('node:assert/strict'),f=require('node:fs'),p=require('node:path'),D=require('better-sqlite3');const nodes=f.readdirSync('/proc').filter(n=>/^\\d+$/.test(n)&&Number(n)!==process.pid).flatMap(n=>{try{const command=f.readFileSync('/proc/'+n+'/cmdline','utf8').split('\\0');return p.basename(command[0])==='node'&&!command.some(v=>v.endsWith('dist/health.mjs'))?[{pid:Number(n),command}]:[]}catch{return []}});a.equal(nodes.length,1,'Expected exactly one persistent application Node process');a.ok(nodes[0].command.some(v=>v.endsWith('dist/runtime.mjs')),'Expected the unified runtime entry');const d=new D('/data/oci-dash.db',{readonly:true,fileMustExist:true});const worker=d.prepare('SELECT id FROM job_workers WHERE stopped_at IS NULL ORDER BY last_heartbeat_at DESC LIMIT 1').get();d.close();console.log(JSON.stringify({pid:nodes[0].pid,workerId:worker?.id}));",
    ),
    "Runtime identity",
  );
  assert.ok(positiveInteger(value.pid), "Runtime PID must be a positive integer");
  assert.ok(
    typeof value.workerId === "string" && value.workerId.length > 0,
    "Runtime worker identity must be a nonempty string",
  );
  return { pid: value.pid, workerId: value.workerId };
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
    "const f=require('node:fs'),c=require('node:crypto'),a=require('node:assert/strict'),D=require('better-sqlite3');const key=f.readFileSync('/data/.master-key');a.equal(f.statSync('/data/.master-key').mode&0o777,0o600);a.equal(key.length,32);a.equal(f.existsSync('/data/.initial-admin-password'),false);const d=new D('/data/oci-dash.db',{readonly:true});console.log(c.createHash('sha256').update(key).update(JSON.stringify(d.prepare('SELECT id,password_hash FROM users ORDER BY id').all())).digest('hex'));d.close();",
  );
function authenticate(action: "setup" | "login"): void {
  // Pass a synthetic credential through stdin so command-line errors cannot echo it.
  const code = `const a=require('node:assert/strict');const password=require('node:fs').readFileSync(0,'utf8');fetch('http://127.0.0.1:3000/api/auth/${action}',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:3000'},body:JSON.stringify({username:'runtime-test',password})}).then(async r=>{a.equal(r.status,${action === "setup" ? 201 : 200});a.ok(r.headers.get('set-cookie')?.includes('HttpOnly'));const status=await fetch('http://127.0.0.1:3000/api/auth/status');a.equal((await status.json()).setupRequired,false);console.log('ok')});`;
  assert.equal(
    execFileSync("docker", ["exec", "-i", name, "node", "-e", code], {
      input: password,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim(),
    "ok",
  );
}

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
    "--mount",
    `type=volume,src=${volume},dst=/data`,
    image,
  );
  containerCreated = true;
  await waitFor(healthy, "initial application readiness");
  runtime();
  assert.equal(execute("console.log(process.getuid())"), "0", "The default container user is root");
  assert.equal(
    execute("console.log(require('node:fs').readFileSync('/proc/1/comm','utf8').trim())"),
    "tini",
    "The image must provide its own PID 1 without Docker's --init flag",
  );
  assert.equal(
    execute(
      "const a=require('node:assert/strict'),f=require('node:fs'),o=require('node:os');a.equal(o.tmpdir(),'/dev/shm');a.equal(Number(f.statfsSync(o.tmpdir()).type),0x01021994);console.log('ok')",
    ),
    "ok",
    "Temporary SSH files must use the container's built-in memory filesystem",
  );
  assert.equal(accountIdentity(), "", "Empty deployments must wait for browser setup");
  assert.equal(
    execute(
      "fetch('http://127.0.0.1:3000/api/auth/status').then(async r=>console.log((await r.json()).setupRequired))",
    ),
    "true",
  );
  initializationIdentity();
  authenticate("setup");
  const admin = accountIdentity();
  const initialization = initializationIdentity();
  assert.ok(admin);
  authenticate("login");
  console.log(
    "PASS: empty container accepts first administrator setup and login without environment configuration",
  );

  // Confirm that an existing data directory retains its owner through restarts.
  execute(
    "const f=require('node:fs'),p=require('node:path');for(const name of f.readdirSync('/data'))f.chownSync(p.join('/data',name),1000,1000);f.chmodSync('/data',0o700);f.chownSync('/data',1000,1000);",
  );
  {
    const before = runtime();
    const previousRestarts = restarts();
    // Tini may exit before docker exec can report the killer's status. Recovery
    // below proves the application was killed and restarted successfully.
    spawnSync("docker", ["exec", name, "node", "-e", `process.kill(${before.pid}, 'SIGKILL')`], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 7000,
    });
    await waitFor(
      () => restarts() > previousRestarts && healthy() && runtime().workerId !== before.workerId,
      "Docker recovery after application failure",
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
    assert.equal(
      execute("console.log(require('node:fs').statSync('/data/.master-key').uid)"),
      "1000",
      "Existing data must work without rewriting its owner",
    );
    authenticate("login");
    console.log(
      "PASS: application failure restarts the container and preserves data, secrets and ownership",
    );
  }

  const current = runtime();
  execute(`process.kill(${current.pid}, 'SIGSTOP')`);
  try {
    assert.equal(healthy(), false, "The HTTP probe must detect a stalled application");
  } finally {
    execute(`process.kill(${current.pid}, 'SIGCONT')`);
  }
  await waitFor(healthy, "application event loop resumes");
  console.log("PASS: the bounded HTTP probe detects a stalled application and recovers on resume");

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
    "/data:rw,mode=0700",
    "--entrypoint",
    "node",
    image,
    "-e",
    `require('node:fs').cpSync('/source','/data',{recursive:true});const checked=JSON.parse(require('node:child_process').execFileSync(process.execPath,['dist/check-data.mjs'],{encoding:'utf8'}).split('\\n')[0]);require('node:assert/strict').equal(checked.ok,true);require('node:assert/strict').equal(checked.administrators,1);const D=require('better-sqlite3');const d=new D('/data/oci-dash.db',{readonly:true});const w=d.prepare('SELECT stopped_at FROM job_workers WHERE id=?').get(${JSON.stringify(beforeStop.workerId)});console.log(JSON.stringify({stopped:Boolean(w?.stopped_at),users:d.prepare('SELECT id FROM users ORDER BY id').pluck().all().join(',')}));d.close();`,
  );
  const result = shutdownProbe(probe);
  assert.equal(result.stopped, true, "Worker must record its graceful shutdown");
  assert.equal(result.users, admin);
  console.log("PASS: SIGTERM shuts down the application cleanly and records the stopped worker");
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
