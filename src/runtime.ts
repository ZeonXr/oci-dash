import { eq, sql } from "drizzle-orm";
import next from "next";
import { createApplication, type ApplicationServices } from "./server/runtime/application";
import { safeMessage } from "./server/errors";

function configuration() {
  const args = process.argv.slice(2);
  const dev = args.includes("--dev");
  let port = Number(process.env.PORT ?? 6240);
  let host = process.env.HOSTNAME ?? (dev ? "127.0.0.1" : "0.0.0.0");
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--dev") continue;
    if (arg === "--port" || arg === "-p") port = Number(args[++index]);
    else if (arg === "--hostname" || arg === "-H") host = args[++index];
    else throw new Error(`Unknown application argument: ${arg}`);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !host)
    throw new Error("Invalid application address");
  Object.assign(process.env, { NODE_ENV: dev ? "development" : "production" });
  return { dev, port, host };
}

async function main() {
  const config = configuration();
  let database: typeof import("./server/db") | undefined;
  let router: typeof import("./server/router");
  let jobs: typeof import("./server/jobs");
  let consoles: typeof import("./server/console/manager");
  let gateway: typeof import("./server/console/gateway");
  let transport: typeof import("./server/console/transport");
  let schema: typeof import("./server/database/schema");
  const services: ApplicationServices = {
    async initialize() {
      database = await import("./server/db");
      await database.initializeDatabase();
      [router, jobs, consoles, gateway, transport, schema] = await Promise.all([
        import("./server/router"),
        import("./server/jobs"),
        import("./server/console/manager"),
        import("./server/console/gateway"),
        import("./server/console/transport"),
        import("./server/database/schema"),
      ]);
    },
    next(server) {
      const app = next({
        dev: config.dev,
        hostname: config.host,
        port: config.port,
        httpServer: server,
      });
      return {
        prepare: () => app.prepare(),
        handle: app.getRequestHandler(),
        close: () => app.close(),
      };
    },
    console() {
      const manager = consoles.createConsoleManager({
        transport: transport.createConsoleTransport(),
      });
      return {
        ...gateway.createConsoleGateway({ manager }),
        initialize: () => manager.initialize(),
      };
    },
    worker: (options) => jobs.runWorker(options),
    api: (request, segments) => router.handleApi(request, segments),
    healthy(workerId, startedAt) {
      const orm = database!.getOrm();
      orm.get(sql`SELECT 1`);
      const worker = orm
        .select()
        .from(schema.jobWorkers)
        .where(eq(schema.jobWorkers.id, workerId))
        .get();
      const heartbeat = worker ? Date.parse(worker.lastHeartbeatAt) : NaN;
      const now = Date.now();
      return Boolean(
        worker &&
        !worker.stoppedAt &&
        heartbeat >= startedAt &&
        heartbeat <= now &&
        worker.leaseSeconds > 0 &&
        heartbeat + worker.leaseSeconds * 1000 > now,
      );
    },
    closeDatabase() {
      database?.closeDatabase();
    },
  };
  const application = createApplication({
    ...config,
    services,
    onError: (error) => console.error("[runtime] Fatal error:", safeMessage(error)),
  });
  const stop = () => {
    void application.stop();
  };
  const fail = (error: unknown) => {
    void application.stop(error);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  void application.start().then(
    () => {
      if (application.state === "running")
        console.log(`[runtime] Application ready on ${config.host}:${config.port}.`);
    },
    () => undefined,
  );
  const exitCode = await application.completion;
  // End orphaned, cancelled SDK reads too; durable mutations have already drained or hit the deadline.
  process.exit(exitCode);
}
void main().catch((error) => {
  console.error("[runtime] Startup failed:", safeMessage(error));
  process.exit(1);
});
