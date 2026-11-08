import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "./lib/process.ts";
import type { RunProcessOptions } from "./lib/process.ts";

interface VerificationEnvironment {
  MASTER_KEY: string;
  APP_ORIGIN: string;
  DATABASE_PATH: string;
  PORT: string;
  NEXT_TELEMETRY_DISABLED: string;
}

interface ResolvedComposeService {
  image?: string;
  build?: unknown;
  extends?: unknown;
  init?: boolean;
  restart?: string;
  stop_grace_period?: string;
  tmpfs?: string[];
  security_opt?: string[];
  cap_drop?: string[];
  logging?: { driver?: string };
  environment?: Record<string, string | number | boolean | null>;
  volumes?: { type?: string; source?: string; target?: string }[];
  ports?: { host_ip?: string; published?: string | number; target?: number }[];
}

interface ResolvedComposeConfiguration {
  name?: string;
  services?: Record<string, ResolvedComposeService>;
  volumes?: Record<string, { name?: string; external?: boolean }>;
}

type ComposeCommand = (command: string[], options?: RunProcessOptions) => Promise<string>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectionFailure(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined;
  if (cause && typeof cause === "object" && "code" in cause) {
    if (typeof cause.code === "string" || typeof cause.code === "number") return String(cause.code);
  }
  return errorMessage(error);
}

const repository = fileURLToPath(new URL("..", import.meta.url));
const base = resolve(repository, ".test-tmp");
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: npm run test:e2e:isolated -- [--no-build] [Playwright test arguments]\nBuilds and tests in a temporary Compose project with a fresh empty database.\n--no-build uses an existing oci-dash:local image. All test containers, data and reports are removed afterward.",
  );
  process.exit(0);
}
const noBuild = args.includes("--no-build");
const testArgs = args.filter((arg) => arg !== "--no-build" && arg !== "--");
const project = `oci-dash-e2e-${randomUUID()}`;
const image = noBuild ? process.env.OCI_DASH_TEST_IMAGE || "oci-dash:local" : `${project}:local`;
mkdirSync(base, { recursive: true });
const directory = mkdtempSync(join(base, "e2e-"));
const dataDirectory = join(directory, "data");
const envFile = join(directory, "test.env");
const composeFile = join(directory, "compose.yaml");
const override = join(directory, "compose.json");

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
  if (!address || typeof address === "string")
    throw new Error("The temporary listener did not receive a TCP port.");
  return address.port;
}

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Browser verification interrupted."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
let compose: ComposeCommand | undefined;
let started = false;
let failure: unknown;
try {
  // A copied deployment file must work without adjacent source or inherited files.
  copyFileSync(join(repository, "compose.yaml"), composeFile);
  // Only this test-owned leaf is writable by the non-root container. Its parent
  // remains private, and cleanup removes the entire unique temporary directory.
  mkdirSync(dataDirectory, { mode: 0o777 });
  if (process.platform !== "win32") chmodSync(dataDirectory, 0o777);
  const port = await unusedPort();
  const administrator = {
    ADMIN_USERNAME: project.slice("oci-dash-".length),
    ADMIN_PASSWORD: randomBytes(24).toString("base64url"),
  };
  const values: VerificationEnvironment = {
    MASTER_KEY: randomBytes(32).toString("base64"),
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
  writeFileSync(
    override,
    JSON.stringify({
      services: {
        app: {
          image,
          ...(noBuild ? {} : { build: { context: repository } }),
          pull_policy: "never",
          restart: "no",
          environment: {
            MASTER_KEY: values.MASTER_KEY,
            APP_ORIGIN: values.APP_ORIGIN,
            DATABASE_PATH: values.DATABASE_PATH,
          },
        },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...values,
    ADMIN_USERNAME: undefined,
    ADMIN_PASSWORD: undefined,
    COMPOSE_PROJECT_NAME: project,
    COMPOSE_ENV_FILES: envFile,
    E2E_BASE_URL: values.APP_ORIGIN,
    E2E_ISOLATED_RUN: project,
    E2E_OUTPUT_DIR: join(directory, "results"),
  };
  // Explicit files, environment and project avoid the checkout's personal .env
  // or overrides. Only the release Compose is copied into the isolated directory.
  const prefix = [
    "compose",
    "--project-directory",
    directory,
    "--env-file",
    envFile,
    "--project-name",
    project,
    "--file",
    composeFile,
    "--file",
    override,
  ];
  compose = (command, options = {}) =>
    runProcess("docker", [...prefix, ...command], { cwd: repository, env, ...options });
  const config = JSON.parse(
    await compose(["config", "--format", "json"]),
  ) as ResolvedComposeConfiguration;
  const service = config.services?.app;
  const volumes = service?.volumes;
  const ports = service?.ports;
  if (
    config.name !== project ||
    !service ||
    Object.keys(config.services ?? {}).length !== 1 ||
    Object.keys(config.volumes ?? {}).length !== 0 ||
    volumes?.length !== 1 ||
    volumes[0].type !== "bind" ||
    !volumes[0].source ||
    resolve(volumes[0].source) !== resolve(dataDirectory) ||
    volumes[0].target !== "/data" ||
    Object.keys(service.environment ?? {}).some((key) => !(key in values)) ||
    service.environment?.MASTER_KEY !== values.MASTER_KEY ||
    service.environment?.ADMIN_USERNAME !== undefined ||
    service.environment?.ADMIN_PASSWORD !== undefined ||
    service.environment?.APP_ORIGIN !== values.APP_ORIGIN ||
    service.environment?.DATABASE_PATH !== "/data/oci-dash.db" ||
    service.environment?.PORT !== undefined ||
    service.init === true ||
    service.stop_grace_period !== "35s" ||
    (service.tmpfs?.length ?? 0) !== 0 ||
    !service.security_opt?.includes("no-new-privileges:true") ||
    !service.cap_drop?.includes("ALL") ||
    service.logging?.driver !== "local" ||
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
  try {
    const health = await fetch(`${values.APP_ORIGIN}/api/health`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (error) {
    throw new Error(
      `The isolated app is not reachable from the browser host: ${connectionFailure(error)}`,
    );
  }
  await runProcess(
    process.execPath,
    [join(repository, "node_modules/@playwright/test/cli.js"), "test", ...testArgs],
    {
      cwd: repository,
      // Credentials are supplied only to the browser test host. The server must
      // begin without an administrator and initialize through its setup UI.
      env: { ...env, ...administrator },
      inherit: true,
      timeoutMs: 15 * 60_000,
      signal: controller.signal,
    },
  );
} catch (error) {
  failure = error;
  if (started && compose) {
    const logs = await compose(["logs", "--tail", "50", "app"]).catch(
      () => "Could not read isolated app logs.",
    );
    console.error(logs);
  }
} finally {
  const cleanupErrors: unknown[] = [];
  if (started && compose) {
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
    if (failure) console.error(errorMessage(failure));
    for (const error of cleanupErrors) console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
