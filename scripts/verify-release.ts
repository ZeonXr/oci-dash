import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runProcess, type RunProcessOptions } from "./lib/process.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));
const registryRepository = "zeonxr/oci-dash";
const imageRepository = `ghcr.io/${registryRepository}`;
type ObjectValue = Record<string, unknown>;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function json(text: string): ObjectValue {
  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error("Expected valid JSON during public release verification.");
  }
  check(object(result), "Expected an object during public release verification.");
  return result;
}
function keys(value: ObjectValue, allowed: string[]): boolean {
  // Compose may materialize omitted defaults such as command: null or ipam: {}.
  // The source precheck still rejects unknown input fields before normalization.
  return Object.entries(value).every(
    ([key, field]) =>
      allowed.includes(key) || field === null || (object(field) && Object.keys(field).length === 0),
  );
}
function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function download(
  address: string,
  signal: AbortSignal,
  purpose: string,
  extraHeaders: Record<string, string> = {},
  maximum = 1024 * 1024,
): Promise<{ bytes: Buffer; headers: Headers }> {
  let url = new URL(address);
  const headers = new Headers({ "User-Agent": "oci-dash-public-verification", ...extraHeaders });
  for (let redirects = 0; redirects < 6; redirects++) {
    check(
      url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === "443") &&
        [
          "github.com",
          "release-assets.githubusercontent.com",
          "objects.githubusercontent.com",
          "ghcr.io",
        ].includes(url.hostname),
      `Refusing an unexpected host for ${purpose}.`,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        headers,
        credentials: "omit",
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
    } catch {
      throw new Error(`Anonymous request failed for ${purpose}.`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      check(location, `Missing redirect location for ${purpose}.`);
      const next = new URL(location, url);
      if (next.origin !== url.origin) headers.delete("authorization");
      await response.body?.cancel();
      url = next;
      continue;
    }
    check(response.ok, `Anonymous ${purpose} returned HTTP ${response.status}.`);
    check(response.body, `Missing response body for ${purpose}.`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        length += result.value.byteLength;
        check(length <= maximum, `Unexpectedly large response for ${purpose}.`);
        chunks.push(result.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
    return { bytes: Buffer.concat(chunks), headers: response.headers };
  }
  throw new Error(`Too many redirects for ${purpose}.`);
}

async function verifyAnonymousRegistry(
  tag: string,
  signal: AbortSignal,
): Promise<{ platforms: Map<string, string>; indexDigest: string }> {
  const scope = encodeURIComponent(`repository:${registryRepository}:pull`);
  const authorization = await download(
    `https://ghcr.io/token?service=ghcr.io&scope=${scope}`,
    signal,
    "GHCR pull authorization",
  );
  const grant = json(authorization.bytes.toString("utf8"));
  const token = grant.token ?? grant.access_token;
  check(typeof token === "string" && token.length > 0, "GHCR did not grant anonymous pull access.");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept:
      "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
  };
  const index = await download(
    `https://ghcr.io/v2/${registryRepository}/manifests/${tag}`,
    signal,
    "GHCR image index",
    headers,
  );
  check(
    index.headers.get("docker-content-digest") === sha256(index.bytes),
    "GHCR index digest did not match its content.",
  );
  const parsed = json(index.bytes.toString("utf8"));
  check(
    Array.isArray(parsed.manifests) && parsed.manifests.length === 2,
    "Release must contain exactly two platform manifests.",
  );
  const platforms = new Map<string, string>();
  for (const value of parsed.manifests) {
    check(object(value) && object(value.platform), "Invalid release platform descriptor.");
    const architecture = value.platform.architecture;
    check(
      value.platform.os === "linux" && (architecture === "amd64" || architecture === "arm64"),
      "Unexpected release platform.",
    );
    check(
      typeof value.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(value.digest),
      "Invalid platform digest.",
    );
    check(!platforms.has(architecture), "Duplicate platform in release index.");
    const child = await download(
      `https://ghcr.io/v2/${registryRepository}/manifests/${value.digest}`,
      signal,
      `GHCR ${architecture} manifest`,
      headers,
    );
    check(
      sha256(child.bytes) === value.digest &&
        child.headers.get("docker-content-digest") === value.digest,
      "Platform manifest digest did not match its content.",
    );
    const manifest = json(child.bytes.toString("utf8"));
    check(
      object(manifest.config) && Array.isArray(manifest.layers) && !manifest.manifests,
      "Expected a platform image manifest.",
    );
    platforms.set(architecture, value.digest);
  }
  check(
    platforms.has("amd64") && platforms.has("arm64"),
    "Release is missing a required architecture.",
  );
  return { platforms, indexDigest: sha256(index.bytes) };
}

// This accepts the project's small release format, not arbitrary Compose syntax.
// Reject external references before `compose config` can read any referenced file.
function verifyComposeSource(source: string): void {
  check(!source.includes("${"), "Release Compose must not require environment interpolation.");
  check(
    (source.match(/127\.0\.0\.1:6240:3000/g) ?? []).length === 1,
    "Release Compose must use the literal default port mapping.",
  );
  check(
    (source.match(/^\s*-\s*(?:"\.\/data:\/data"|'\.\/data:\/data'|\.\/data:\/data)\s*$/gm) ?? [])
      .length === 1,
    "Release Compose must use the literal ./data:/data mount.",
  );
  check(
    !/[${}&*!|>\t]/.test(
      source
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"))
        .join("\n"),
    ),
    "Release Compose must use the simple standalone format.",
  );
  const allowed = new Set([
    "name",
    "services",
    "app",
    "image",
    "restart",
    "stop_grace_period",
    "security_opt",
    "cap_drop",
    "ports",
    "volumes",
    "logging",
    "driver",
  ]);
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      check(
        /^- [A-Za-z0-9_./:,\[\]"' -]+$/.test(trimmed),
        "Unsupported release Compose list value.",
      );
      continue;
    }
    const match = /^([a-z][a-z0-9_-]*):(?:\s+([A-Za-z0-9_./:,\[\]"' -]*))?$/.exec(trimmed);
    check(
      match && allowed.has(match[1]),
      "Release Compose contains unsupported fields or external references.",
    );
  }
}

function verifyResolved(
  config: ObjectValue,
  project: string,
  image: string,
  port: number,
  dataDirectory: string,
): void {
  check(
    keys(config, ["name", "services", "volumes", "networks"]) && config.name === project,
    "Unexpected Compose project configuration.",
  );
  check(
    object(config.services) &&
      Object.keys(config.services).join() === "app" &&
      object(config.services.app),
    "Release must contain only the app service.",
  );
  const app = config.services.app;
  check(
    keys(app, [
      "image",
      "restart",
      "stop_grace_period",
      "security_opt",
      "cap_drop",
      "ports",
      "volumes",
      "logging",
      "networks",
      "command",
      "entrypoint",
    ]),
    "Release app contains unsupported overrides or privileges.",
  );
  check(
    app.command == null && app.entrypoint == null,
    "Release must use the image's default command and entrypoint.",
  );
  check(
    app.image === image && app.restart === "unless-stopped" && app.stop_grace_period === "35s",
    "Release image or lifecycle defaults do not match.",
  );
  check(
    JSON.stringify(app.security_opt) === JSON.stringify(["no-new-privileges:true"]) &&
      JSON.stringify(app.cap_drop) === JSON.stringify(["ALL"]),
    "Release container security defaults are missing.",
  );
  check(
    object(app.logging) &&
      keys(app.logging, ["driver", "options"]) &&
      app.logging.driver === "local" &&
      (!app.logging.options ||
        (object(app.logging.options) && Object.keys(app.logging.options).length === 0)),
    "Unexpected release logging configuration.",
  );
  check(
    Array.isArray(app.ports) && app.ports.length === 1 && object(app.ports[0]),
    "Expected one published port.",
  );
  const published = app.ports[0];
  check(
    keys(published, ["mode", "host_ip", "published", "target", "protocol"]) &&
      published.host_ip === "127.0.0.1" &&
      Number(published.published) === port &&
      published.target === 3000 &&
      published.protocol === "tcp",
    "Release port is not isolated on loopback.",
  );
  check(
    Array.isArray(app.volumes) && app.volumes.length === 1 && object(app.volumes[0]),
    "Expected one data mount.",
  );
  const mount = app.volumes[0];
  check(
    keys(mount, ["type", "source", "target", "bind"]) &&
      mount.type === "bind" &&
      typeof mount.source === "string" &&
      resolve(mount.source) === resolve(dataDirectory) &&
      mount.target === "/data" &&
      (mount.bind == null || (object(mount.bind) && keys(mount.bind, ["create_host_path"]))),
    "Release data mount is not the isolated sibling data directory.",
  );
  check(
    config.volumes == null || (object(config.volumes) && Object.keys(config.volumes).length === 0),
    "Release must not declare named volumes.",
  );
  check(
    object(app.networks) && Object.keys(app.networks).join() === "default",
    "Unexpected app network.",
  );
  check(
    object(config.networks) &&
      Object.keys(config.networks).join() === "default" &&
      object(config.networks.default) &&
      keys(config.networks.default, ["name"]) &&
      config.networks.default.name === `${project}_default`,
    "Release network is not owned by this test project.",
  );
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  check(address && typeof address !== "string", "Could not reserve a loopback port.");
  return address.port;
}

async function localDockerEndpoint(): Promise<string> {
  let endpoint: string;
  try {
    endpoint =
      !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
        ? process.env.DOCKER_HOST
        : await runProcess(
            "docker",
            ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            { timeoutMs: 15_000 },
          );
  } catch {
    throw new Error("Could not determine the current local Docker endpoint.");
  }
  check(
    /^unix:\/\/\/[^\s?#]+$/.test(endpoint) ||
      /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/.test(endpoint),
    "Public release verification requires a local unix or npipe Docker endpoint.",
  );
  return endpoint;
}

async function installedComposeDirectory(
  endpoint: string,
  isolatedEnvironment: NodeJS.ProcessEnv,
): Promise<string> {
  // Query only Docker's plugin-path metadata. Never open or copy its auth configuration.
  const environment = { ...isolatedEnvironment };
  delete environment.DOCKER_CONFIG;
  if (process.env.DOCKER_CONFIG) environment.DOCKER_CONFIG = process.env.DOCKER_CONFIG;
  let executable: string;
  try {
    executable = await runProcess(
      "docker",
      [
        "--host",
        endpoint,
        "info",
        "--format",
        '{{range .ClientInfo.Plugins}}{{if eq .Name "compose"}}{{.Path}}{{end}}{{end}}',
      ],
      { env: environment, timeoutMs: 30_000 },
    );
    check(isAbsolute(executable) && !/[\r\n\0]/.test(executable), "Invalid Compose plugin path.");
    check(
      basename(executable).toLowerCase() ===
        (process.platform === "win32" ? "docker-compose.exe" : "docker-compose"),
      "Unexpected Compose plugin executable.",
    );
    check(statSync(executable).isFile(), "Compose plugin is not a regular executable file.");
    accessSync(executable, constants.X_OK);
  } catch {
    throw new Error(
      "Could not locate the installed Compose plugin without copying Docker credentials.",
    );
  }
  return dirname(executable);
}

const containerProbe = String.raw`
(async () => {
  const f = require('node:fs'), c = require('node:crypto'), o = require('node:os');
  const ensure = condition => { if (!condition) throw new Error('probe failed'); };
  ensure(typeof process.getuid === 'function' && process.getuid() === 1000);
  ensure(f.readFileSync('/proc/1/comm','utf8').trim() === 'tini');
  ensure(o.tmpdir() === '/dev/shm' && Number(f.statfsSync(o.tmpdir()).type) === 0x01021994);
  if (process.argv[2] === 'check-posix-mode') ensure((f.statSync('/data/.master-key').mode & 0o777) === 0o600);
  ensure(!f.existsSync('/data/.initial-admin-password'));
  const key = f.readFileSync('/data/.master-key'); ensure(key.length === 32);
  const D = require('better-sqlite3'), db = new D('/data/oci-dash.db',{readonly:true});
  const users = db.prepare('SELECT id,username,password_hash FROM users ORDER BY id').all();
  ensure(process.argv[1] === 'pending' ? users.length === 0 : users.length === 1 && users[0].username === 'release-admin');
  const marker = db.prepare('SELECT value FROM settings WHERE key=?').get('auth.setup.completed');
  ensure(process.argv[1] === 'pending' ? !marker : Boolean(marker));
  ensure(db.prepare('SELECT count(*) AS total FROM accounts').get().total === 0); db.close();
  console.log(c.createHash('sha256').update(key).digest('hex') + ':' + c.createHash('sha256').update(JSON.stringify(users)).digest('hex'));
})().catch(() => { console.error('Container setup-state verification failed.'); process.exitCode=1; });
`;

async function main(): Promise<void> {
  const version = json(readFileSync(join(repository, "package.json"), "utf8")).version;
  const tag = process.env.OCI_DASH_RELEASE_TAG ?? `v${String(version)}`;
  check(
    /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag),
    "Release tag must use vMAJOR.MINOR.PATCH.",
  );
  const image = `${imageRepository}:${tag}`;
  const project = `oci-dash-public-${randomUUID()}`;
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Public release verification interrupted."));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  let directory: string | undefined;
  let started = false;
  let failure: unknown;
  let compose: ((args: string[], options?: RunProcessOptions) => Promise<string>) | undefined;
  let docker: ((args: string[], options?: RunProcessOptions) => Promise<string>) | undefined;
  const cleanupErrors: string[] = [];
  try {
    const { platforms, indexDigest } = await verifyAnonymousRegistry(tag, controller.signal);
    console.log("PASS: anonymous GHCR access verifies both linux/amd64 and linux/arm64 manifests");
    const asset = await download(
      `https://github.com/ZeonXr/oci-dash/releases/download/${tag}/compose.yaml`,
      controller.signal,
      "GitHub Compose asset",
      {},
      64 * 1024,
    );
    const source = asset.bytes.toString("utf8").replace(/^\uFEFF/, "");
    verifyComposeSource(source);
    const endpoint = await localDockerEndpoint();
    directory = mkdtempSync(join(tmpdir(), "oci-dash-release-"));
    const dataDirectory = join(directory, "data");
    // Only this freshly created leaf is writable by the container. Its parent remains private.
    mkdirSync(dataDirectory, { mode: 0o777 });
    if (process.platform !== "win32") chmodSync(dataDirectory, 0o777);
    const configDirectory = join(directory, "docker");
    mkdirSync(configDirectory, { mode: 0o700 });
    // An explicit empty GHCR entry disables Docker's automatic system credential-helper discovery.
    writeFileSync(
      join(configDirectory, "config.json"),
      JSON.stringify({ auths: { "ghcr.io": {} } }),
      { mode: 0o600 },
    );
    const composeFile = join(directory, "compose.yaml");
    const port = await unusedPort();
    // Keep the downloaded asset intact in memory; randomize only the host port
    // in this test-owned copy, without an env file or a second Compose file.
    writeFileSync(composeFile, source.replace("127.0.0.1:6240:3000", `127.0.0.1:${port}:3000`), {
      mode: 0o600,
    });
    const env: NodeJS.ProcessEnv = {};
    for (const name of [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "SYSTEMROOT",
      "WINDIR",
      "COMSPEC",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "TEMP",
      "TMP",
      "LANG",
      "LC_ALL",
    ]) {
      if (process.env[name] !== undefined) env[name] = process.env[name];
    }
    Object.assign(env, {
      DOCKER_CONFIG: configDirectory,
      COMPOSE_PROJECT_NAME: project,
      COMPOSE_DISABLE_ENV_FILE: "1",
    });
    const prefix = ["--config", configDirectory, "--host", endpoint];
    docker = async (args, options = {}) => {
      try {
        return await runProcess("docker", [...prefix, ...args], {
          cwd: directory,
          env,
          signal: controller.signal,
          timeoutMs: 30_000,
          ...options,
        });
      } catch {
        throw new Error(
          `Docker ${args[0] ?? "command"} failed during isolated public release verification.`,
        );
      }
    };
    try {
      await docker(["compose", "version"]);
    } catch {
      const pluginDirectory = await installedComposeDirectory(endpoint, env);
      writeFileSync(
        join(configDirectory, "config.json"),
        JSON.stringify({ auths: { "ghcr.io": {} }, cliPluginsExtraDirs: [pluginDirectory] }),
        { mode: 0o600 },
      );
      await docker(["compose", "version"]);
    }
    const composePrefix = [
      "compose",
      "--project-directory",
      directory,
      "--env-file",
      process.platform === "win32" ? "NUL" : "/dev/null",
      "--project-name",
      project,
      "--file",
      composeFile,
    ];
    compose = (args, options) => docker!([...composePrefix, ...args], options);
    verifyResolved(
      json(await compose(["config", "--format", "json"])),
      project,
      image,
      port,
      dataDirectory,
    );
    for (const kind of ["container", "network"]) {
      const args = kind === "container" ? ["ps", "--all"] : [kind, "ls"];
      const found = await docker([
        ...args,
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        kind === "container" ? "{{.ID}}" : "{{.Name}}",
      ]);
      check(found === "", "The randomly selected project already has Docker resources.");
    }
    for (const [kind, name] of [["network", `${project}_default`]]) {
      check(
        (await docker([kind, "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"])) === "",
        "The randomly selected storage or network name already exists.",
      );
    }
    console.log("PASS: downloaded Compose is standalone and resolves only isolated resources");
    await compose(["pull", "app"], { timeoutMs: 10 * 60_000 });
    const identity = json(await docker(["image", "inspect", "--format", "{{json .}}", image]));
    check(
      identity.Os === "linux" &&
        typeof identity.Architecture === "string" &&
        platforms.has(identity.Architecture),
      "Pulled image has an unexpected platform.",
    );
    const expectedDigests = new Set([
      `${imageRepository}@${indexDigest}`,
      `${imageRepository}@${platforms.get(identity.Architecture)}`,
    ]);
    check(
      Array.isArray(identity.RepoDigests) &&
        identity.RepoDigests.some(
          (value: unknown) => typeof value === "string" && expectedDigests.has(value),
        ),
      "Pulled image does not match the anonymously verified release digest.",
    );
    controller.signal.throwIfAborted();
    started = true;
    await compose(
      ["up", "--detach", "--wait", "--wait-timeout", "120", "--no-build", "--pull", "never", "app"],
      { timeoutMs: 150_000 },
    );
    const runCompose = compose,
      runDocker = docker;
    const probe = async (state: "pending" | "registered" = "registered"): Promise<string> => {
      const container = await runCompose(["ps", "--quiet", "app"]);
      check(/^[a-f0-9]{12,64}$/.test(container), "Expected exactly one isolated app container.");
      const labels = json(
        await runDocker(["inspect", "--format", "{{json .Config.Labels}}", container]),
      );
      check(
        labels["com.docker.compose.project"] === project &&
          labels["com.docker.compose.service"] === "app",
        "Container is not owned by this verification.",
      );
      await runDocker(["exec", container, "node", "dist/health.mjs"]);
      const hash = await runDocker([
        "exec",
        container,
        "node",
        "-e",
        containerProbe,
        state,
        // Docker Desktop bind permissions are governed by Windows ACLs, not POSIX modes.
        process.platform === "win32" ? "host-acl" : "check-posix-mode",
      ]);
      check(
        /^[a-f0-9]{64}:[a-f0-9]{64}$/.test(hash),
        "Container probe returned unexpected output.",
      );
      return hash;
    };
    const pending = await probe("pending");
    const origin = `http://127.0.0.1:${port}`;
    const api = (path: string, options: RequestInit = {}) =>
      fetch(`${origin}/api/${path}`, {
        redirect: "error",
        credentials: "omit",
        ...options,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
      });
    const health = await api("health");
    const healthBody = json(await health.text());
    check(
      health.ok && healthBody.ok === true && healthBody.version === tag.slice(1),
      "Published loopback endpoint is unhealthy or reports an unexpected version.",
    );
    const setupState = await api("auth/status");
    check(
      setupState.ok && json(await setupState.text()).setupRequired === true,
      "Empty release database must require browser administrator setup.",
    );
    const administrator = {
      username: "release-admin",
      password: randomBytes(24).toString("base64url"),
    };
    const authenticate = async (action: "setup" | "login"): Promise<string> => {
      const response = await api(`auth/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(administrator),
      });
      check(
        response.status === (action === "setup" ? 201 : 200),
        "Administrator setup or login failed.",
      );
      const body = json(await response.text()),
        cookie = response.headers.get("set-cookie");
      check(
        object(body.user) &&
          body.user.username === administrator.username &&
          typeof body.user.id === "string",
        "Administrator response is invalid.",
      );
      check(
        cookie &&
          cookie.includes("HttpOnly") &&
          cookie.includes("SameSite=Lax") &&
          !cookie.includes("; Secure") &&
          /^oci_dash_session=[A-Za-z0-9_-]{43};/.test(cookie),
        "Administrator session cookie is invalid.",
      );
      const current = await api("auth/me", { headers: { Cookie: cookie.split(";", 1)[0] } });
      const authenticated = json(await current.text());
      check(
        current.ok && object(authenticated.user) && authenticated.user.id === body.user.id,
        "Created administrator session was not usable.",
      );
      return body.user.id;
    };
    const administratorId = await authenticate("setup");
    const closedState = await api("auth/status");
    check(
      closedState.ok && json(await closedState.text()).setupRequired === false,
      "Setup did not close after administrator creation.",
    );
    const initial = await probe();
    check(
      initial.split(":", 1)[0] === pending.split(":", 1)[0],
      "Setup unexpectedly replaced the generated encryption key.",
    );
    check(
      (await authenticate("login")) === administratorId,
      "Created administrator could not log in again.",
    );
    console.log(
      "PASS: anonymous pull starts a healthy non-root application with Tini, tmpfs and browser administrator setup",
    );
    await compose(["restart", "--timeout", "35", "app"], { timeoutMs: 60_000 });
    let restarted: string | undefined;
    const restartDeadline = Date.now() + 90_000;
    while (Date.now() < restartDeadline) {
      controller.signal.throwIfAborted();
      try {
        restarted = await probe();
        break;
      } catch {
        await delay(1000, undefined, { signal: controller.signal });
      }
    }
    check(restarted === initial, "Administrator or key identity did not survive restart.");
    check(
      (await authenticate("login")) === administratorId,
      "Administrator login did not survive restart.",
    );
    await compose(
      [
        "up",
        "--detach",
        "--force-recreate",
        "--wait",
        "--wait-timeout",
        "120",
        "--no-build",
        "--pull",
        "never",
        "app",
      ],
      { timeoutMs: 150_000 },
    );
    check(
      (await probe()) === initial,
      "Administrator or key identity did not survive container recreation.",
    );
    check(
      (await authenticate("login")) === administratorId,
      "Administrator login did not survive container recreation.",
    );
    const duplicate = await api("auth/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(administrator),
    });
    check(
      duplicate.status === 409 && json(await duplicate.text()).code === "SETUP_ALREADY_COMPLETED",
      "Administrator setup reopened after container recreation.",
    );
    console.log(
      "PASS: restart and container recreation preserve administrator, password hash and encryption key",
    );
  } catch (error) {
    failure = error;
  } finally {
    if (started && compose && docker) {
      try {
        // Label filters and the previously validated Compose keep cleanup within this run.
        const ids = (
          await docker(
            [
              "ps",
              "--all",
              "--filter",
              `label=com.docker.compose.project=${project}`,
              "--format",
              "{{.ID}}",
            ],
            { signal: undefined },
          )
        )
          .split(/\s+/)
          .filter(Boolean);
        for (const id of ids) {
          check(/^[a-f0-9]{12,64}$/.test(id), "Unexpected cleanup container identifier.");
          const labels = json(
            await docker(["inspect", "--format", "{{json .Config.Labels}}", id], {
              signal: undefined,
            }),
          );
          check(
            labels["com.docker.compose.project"] === project &&
              labels["com.docker.compose.service"] === "app",
            "Refusing cleanup of an unrelated container.",
          );
        }
        for (const [kind, name] of [["network", `${project}_default`]]) {
          const names = await docker(
            [
              kind,
              "ls",
              "--filter",
              `label=com.docker.compose.project=${project}`,
              "--format",
              "{{.Name}}",
            ],
            { signal: undefined },
          );
          check(
            names === "" || names === name,
            "Refusing cleanup of unexpected project storage or networks.",
          );
          const exists = await docker(
            [kind, "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"],
            { signal: undefined },
          );
          if (exists) {
            check(exists === name, "Refusing cleanup of an unrelated resource name.");
            const labels = json(
              await docker([kind, "inspect", "--format", "{{json .Labels}}", name], {
                signal: undefined,
              }),
            );
            check(
              labels["com.docker.compose.project"] === project,
              "Refusing cleanup of unrelated storage or networks.",
            );
          }
        }
        await compose(["down", "--remove-orphans", "--timeout", "35"], {
          signal: undefined,
          timeoutMs: 90_000,
        });
        for (const kind of ["container", "network"]) {
          const args = kind === "container" ? ["ps", "--all"] : [kind, "ls"];
          check(
            (await docker(
              [
                ...args,
                "--filter",
                `label=com.docker.compose.project=${project}`,
                "--format",
                kind === "container" ? "{{.ID}}" : "{{.Name}}",
              ],
              { signal: undefined },
            )) === "",
            "Verification left Docker resources behind.",
          );
        }
      } catch {
        cleanupErrors.push(
          `Cleanup requires attention for project ${project}; configuration retained at ${directory}.`,
        );
      }
    }
    if (directory && !cleanupErrors.length) {
      try {
        check(
          dirname(resolve(directory)) === resolve(tmpdir()) &&
            basename(directory).startsWith("oci-dash-release-"),
          "Invalid verification cleanup path.",
        );
        rmSync(directory, { recursive: true, force: true });
      } catch {
        cleanupErrors.push(
          `Could not remove this verification's temporary bind data and configuration at ${directory}.`,
        );
      }
    }
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  if (failure || cleanupErrors.length) {
    if (failure)
      console.error(
        failure instanceof Error ? failure.message : "Public release verification failed.",
      );
    cleanupErrors.forEach((message) => console.error(message));
    process.exitCode = 1;
  } else
    console.log(
      `PASS: public release ${tag} verified; temporary project removed, release image retained`,
    );
}

if (process.argv.includes("--help")) {
  console.log(
    "Usage: npm run test:release\nAnonymously verifies the published Compose asset and GHCR image using a fresh local Docker project and sibling ./data bind directory.\nChecks first administrator setup, login and persistence without logging credentials. Defaults to v plus package.version; OCI_DASH_RELEASE_TAG may select another compatible vMAJOR.MINOR.PATCH release.\nDoes not read personal .env or registry credentials. Removes its temporary containers, bind data and configuration; retains the official release image.",
  );
} else {
  await main().catch(() => {
    console.error("Public release verification could not complete safely.");
    process.exitCode = 1;
  });
}
