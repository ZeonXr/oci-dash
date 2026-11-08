import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./lib/process.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const base = resolve(repository, ".test-tmp");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run test:e2e:isolated -- [--no-build] [Playwright test arguments]\nBuilds and tests in a temporary Compose project with a fresh demo database.\n--no-build uses an existing oci-dash:local image. All test containers, data and reports are removed afterward.",
  );
  process.exit(0);
}
const noBuild = args.includes("--no-build");
const testArgs = args.filter((arg) => arg !== "--no-build" && arg !== "--");
const project = `oci-dash-e2e-${randomUUID()}`;
const image = noBuild ? "oci-dash:local" : `${project}:local`;
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "e2e-"));
const envFile = join(directory, "demo.env");
const override = join(directory, "compose.json");

async function unusedPort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const port = server.address().port;
  await new Promise((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Browser verification interrupted."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let compose;
let started = false;
let failure;
try {
  const port = await unusedPort();
  const values = {
    ADMIN_USERNAME: "admin",
    ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
    MASTER_KEY: randomBytes(32).toString("base64"),
    DEMO_MODE: "true",
    APP_ORIGIN: `http://127.0.0.1:${port}`,
    DATABASE_PATH: "/data/oci-dash.db",
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  writeFileSync(
    envFile,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  writeFileSync(override, JSON.stringify({ services: { app: { image, restart: "no" } } }));
  const env = {
    ...process.env,
    ...values,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_ENV_FILES: envFile,
    E2E_BASE_URL: values.APP_ORIGIN,
    E2E_OUTPUT_DIR: join(directory, "results"),
  };
  // Explicit files, environment and project avoid loading a checkout's personal .env
  // or Compose overrides. The base service definition remains the one shipped to users.
  const prefix = [
    "compose",
    "--project-directory",
    repository,
    "--env-file",
    envFile,
    "--project-name",
    project,
    "--file",
    join(repository, "compose.yaml"),
    "--file",
    override,
  ];
  compose = (command, options = {}) =>
    runProcess("docker", [...prefix, ...command], { cwd: repository, env, ...options });
  const config = JSON.parse(await compose(["config", "--format", "json"]));
  const service = config.services?.app;
  const volumes = service?.volumes;
  const ports = service?.ports;
  if (
    config.name !== project ||
    Object.keys(config.services ?? {}).length !== 1 ||
    Object.keys(config.volumes ?? {}).length !== 1 ||
    config.volumes?.["app-data"]?.name !== `${project}_app-data` ||
    config.volumes["app-data"].external ||
    volumes?.length !== 1 ||
    volumes[0].type !== "volume" ||
    volumes[0].source !== "app-data" ||
    volumes[0].target !== "/data" ||
    service.environment?.DEMO_MODE !== "true" ||
    service.environment?.MASTER_KEY !== values.MASTER_KEY ||
    service.environment?.ADMIN_PASSWORD !== values.ADMIN_PASSWORD ||
    service.environment?.APP_ORIGIN !== values.APP_ORIGIN ||
    service.environment?.DATABASE_PATH !== "/data/oci-dash.db" ||
    ports?.length !== 1 ||
    ports[0].host_ip !== "127.0.0.1" ||
    Number(ports[0].published) !== port ||
    ports[0].target !== 3000
  )
    throw new Error("Refusing to start: the resolved Compose configuration is not isolated.");
  controller.signal.throwIfAborted();
  started = true;
  await compose(
    [
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
      ...(noBuild ? ["--no-build"] : ["--build"]),
      "app",
    ],
    { inherit: true, timeoutMs: 12 * 60_000, signal: controller.signal },
  );
  await runProcess(
    process.execPath,
    [join(repository, "node_modules/@playwright/test/cli.js"), "test", ...testArgs],
    {
      cwd: repository,
      env,
      inherit: true,
      timeoutMs: 15 * 60_000,
      signal: controller.signal,
    },
  );
} catch (error) {
  failure = error;
  if (started) {
    const logs = await compose(["logs", "--tail", "50", "app"]).catch(
      () => "Could not read isolated app logs.",
    );
    console.error(logs);
  }
} finally {
  const cleanupErrors = [];
  if (started) {
    try {
      await compose(["down", "--volumes", "--remove-orphans", "--timeout", "35"], {
        timeoutMs: 60_000,
      });
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (!noBuild) {
      try {
        await runProcess("docker", ["image", "rm", image]);
      } catch {
        // A build failure may never create this unique image. Check before reporting residue.
        const exists = await runProcess("docker", ["image", "ls", "--quiet", image]).catch(
          () => "unknown",
        );
        if (exists) cleanupErrors.push(new Error(`Could not remove test image ${image}.`));
      }
    }
  }
  if (!resolve(directory).startsWith(base + sep)) throw new Error("Invalid test cleanup path.");
  if (!cleanupErrors.length) rmSync(directory, { recursive: true, force: true });
  else
    console.error(
      `Cleanup needs attention for project ${project}; its temporary configuration remains at ${directory}.`,
    );
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
  if (failure || cleanupErrors.length) {
    if (failure) console.error(failure.message);
    for (const error of cleanupErrors) console.error(error.message);
    process.exitCode = 1;
  }
}
