import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createApplication, type ApplicationServices } from "@/server/runtime/application";
import { closeDatabase, getOrm, initializeDatabase } from "@/server/db";
import { accounts, sessions, users } from "@/server/database/schema";
import { hashToken } from "@/server/crypto";
import { SESSION_COOKIE } from "@/server/auth";
import { handleApi } from "@/server/router";
import { getJobStore } from "@/server/jobs";
import { runWorker, type WorkerDependencies } from "@/server/jobs/worker";
import { saveInventory } from "@/server/inventory";
import { fixtureAccounts, fixtureInstances } from "./fixtures/seed-data";

const LEASE_MS = 2000;
const HEARTBEAT_MS = 100;
const round = (value: number) => Math.round(value * 100) / 100;
function percentile(sorted: number[], quantile: number): number {
  return round(sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]);
}

describe("offline single-process capacity", () => {
  it("keeps local APIs and leases responsive while the real task scheduler is occupied", async () => {
    closeDatabase();
    const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
    mkdirSync(base, { recursive: true });
    const directory = mkdtempSync(join(base, "runtime-capacity-"));
    vi.stubEnv("DATABASE_PATH", join(directory, "capacity.sqlite"));
    vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 67).toString("base64"));
    vi.stubEnv("ADMIN_PASSWORD", "");
    vi.stubEnv("APP_ORIGIN", "");
    const accountRows = fixtureAccounts();
    const inventory = fixtureInstances();
    const token = randomBytes(32).toString("base64url");
    const heartbeatTimes: number[] = [];
    const claims = new Map<string, number>();
    const executions = new Map<string, number>();
    const peaks = { sync: 0, write: 0, total: 0 };
    const fatal: unknown[] = [];
    let failedRenewals = 0;
    let activeSync = 0;
    let activeWrite = 0;
    let release!: () => void;
    const slowCloud = new Promise<void>((resolve) => {
      release = resolve;
    });
    let origin = "";
    let app: ReturnType<typeof createApplication> | undefined;
    let store!: ReturnType<typeof getJobStore>;
    let planned: string[] = [];
    const results: Record<string, number>[] = [];
    const fetchLocal = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!origin || url.origin !== origin)
        throw new Error("Capacity fixtures forbid external fetches");
      return fetchLocal(input, init);
    });
    const dependencies: WorkerDependencies = {
      get store() {
        return store;
      },
      getCredentials: (_id, region) => ({
        tenancyId: "fixture",
        userId: "fixture",
        fingerprint: "fixture",
        privateKey: "OFFLINE_SYNTHETIC_KEY",
        region,
      }),
      saveInventory,
      setAccountName: () => {
        throw new Error("Preconnected capacity accounts must not require verification");
      },
      setAccountError: (_id, message) => {
        throw new Error("Capacity task failed: " + message);
      },
      adapter: {
        verify: async () => {
          throw new Error("Capacity fixture must not contact an identity service");
        },
        async inventory(_credentials, account, regions, context) {
          if (!context) throw new Error("Expected a worker execution context");
          const isSync = store.getJob(context.jobId)?.kind === "sync-account";
          if (isSync) {
            activeSync++;
            executions.set(context.jobId, (executions.get(context.jobId) ?? 0) + 1);
          }
          try {
            await slowCloud;
            await delay(30, undefined, { signal: context.signal });
            return {
              instances: structuredClone(inventory.filter((item) => item.accountId === account.id)),
              regions,
              warnings: [],
            };
          } finally {
            if (isSync) activeSync--;
          }
        },
        async execute(_credentials, _operation, context) {
          activeWrite++;
          executions.set(context.jobId, (executions.get(context.jobId) ?? 0) + 1);
          try {
            await context.checkpoint("syntheticWriteStarted", true);
            await slowCloud;
            await delay(30, undefined, { signal: context.signal });
            return { message: "Synthetic offline operation completed" };
          } finally {
            activeWrite--;
          }
        },
      },
    };
    const services: ApplicationServices = {
      async initialize() {
        await initializeDatabase();
        const orm = getOrm();
        const now = new Date().toISOString();
        orm
          .insert(users)
          .values({
            id: "capacity-user",
            username: "capacity-fixture",
            passwordHash: "not-a-login-credential",
            createdAt: now,
          })
          .run();
        orm
          .insert(sessions)
          .values({
            tokenHash: hashToken(token),
            userId: "capacity-user",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            createdAt: now,
          })
          .run();
        orm
          .insert(accounts)
          .values(
            accountRows.map((account) => ({
              id: account.id,
              name: account.name,
              tenancyId: account.tenancyId,
              userId: account.userId,
              fingerprint: account.fingerprint,
              homeRegion: account.homeRegion,
              regions: JSON.stringify(account.regions),
              credential: "OFFLINE_SYNTHETIC_CREDENTIAL",
              status: "connected" as const,
              nameSource: "custom" as const,
              createdAt: now,
            })),
          )
          .run();
        for (const account of accountRows)
          saveInventory(account.id, {
            instances: inventory.filter((item) => item.accountId === account.id),
            regions: account.regions,
            warnings: [],
          });
        store = getJobStore();
        const heartbeat = store.heartbeat;
        vi.spyOn(store, "heartbeat").mockImplementation((...args) => {
          heartbeat(...args);
          heartbeatTimes.push(performance.now());
        });
        const renew = store.renewLease;
        vi.spyOn(store, "renewLease").mockImplementation((...args) => {
          const renewed = renew(...args);
          if (!renewed) failedRenewals++;
          return renewed;
        });
        const claim = store.claimNext;
        vi.spyOn(store, "claimNext").mockImplementation((...args) => {
          const job = claim(...args);
          if (job) {
            claims.set(job.summary.id, (claims.get(job.summary.id) ?? 0) + 1);
            const running = store
              .listActiveJobs()
              .filter((item) => item.state === "running" || item.state === "cancel_requested");
            const sync = running.filter((item) => item.kind === "sync-account").length;
            peaks.sync = Math.max(peaks.sync, sync);
            peaks.write = Math.max(peaks.write, running.length - sync);
            peaks.total = Math.max(peaks.total, running.length);
          }
          return job;
        });
        planned = [
          ...accountRows
            .slice(0, 4)
            .map((account) => store.enqueueAccountSync(account.id, "capacity-fixture").id),
          ...accountRows.slice(4).map(
            (account) =>
              store.enqueueOperation(
                {
                  kind: "instance-reboot",
                  accountId: account.id,
                  region: account.homeRegion,
                  resourceId: inventory.find((item) => item.accountId === account.id)!.id,
                  payload: {},
                },
                "capacity-fixture",
              ).id,
          ),
        ];
      },
      next: () => ({
        prepare: async () => {},
        handle: async (_request, response) => {
          response.end("Synthetic Next service; not benchmarked");
        },
        close: async () => {},
      }),
      console: () => ({
        initialize: async () => {},
        handleRequest: async () => {
          throw new Error("Console routes are outside this benchmark");
        },
        upgrade: async () => {
          throw new Error("WebSocket routes are outside this benchmark");
        },
        close: async () => {},
      }),
      worker: (options) =>
        runWorker({
          ...options,
          dependencies,
          leaseMs: LEASE_MS,
          heartbeatIntervalMs: HEARTBEAT_MS,
          pollIntervalMs: 10,
        }),
      api: handleApi,
      healthy(workerId, startedAt) {
        getOrm().get(sql`SELECT 1`);
        const status = store.getWorkerStatus();
        return (
          status.online &&
          status.workerId === workerId &&
          Date.parse(status.lastHeartbeatAt!) >= startedAt
        );
      },
      closeDatabase,
    };
    try {
      app = createApplication({
        port: 0,
        host: "127.0.0.1",
        services,
        shutdownTimeoutMs: 5000,
        onError: (error) => fatal.push(error),
      });
      await app.start();
      origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      await vi.waitFor(() => {
        expect(activeSync).toBe(2);
        expect(activeWrite).toBe(1);
      });
      const endpoints = ["/api/instances", "/api/health", "/api/jobs?pageSize=20"];
      const read = async (endpoint: string) => {
        const response = await fetch(origin + endpoint, {
          headers: { cookie: `${SESSION_COOKIE}=${token}` },
          signal: AbortSignal.timeout(5000),
        });
        const body = await response.json();
        if (
          !response.ok ||
          (endpoint.includes("instances") && body.instances?.length !== inventory.length) ||
          (endpoint.includes("health") && body.ok !== true) ||
          (endpoint.includes("jobs") && !Array.isArray(body.jobs))
        )
          throw new Error("Invalid capacity fixture API response");
      };
      for (let index = 0; index < 30; index++) await read(endpoints[index % endpoints.length]);
      for (const concurrency of [10, 25, 50]) {
        expect(activeSync).toBe(2);
        expect(activeWrite).toBe(1);
        const elapsed = monitorEventLoopDelay({ resolution: 10 });
        elapsed.enable();
        const heartbeatStart = heartbeatTimes.length - 1;
        let rss = process.memoryUsage().rss;
        const sample = setInterval(() => {
          rss = Math.max(rss, process.memoryUsage().rss);
        }, 25);
        const latencies: number[] = [];
        let errors = 0;
        const start = performance.now();
        try {
          await Promise.all(
            Array.from({ length: concurrency }, async (_value, lane) => {
              let count = 0;
              while (count < 12 || performance.now() - start < 1000) {
                const began = performance.now();
                try {
                  await read(endpoints[(lane + count) % endpoints.length]);
                } catch {
                  errors++;
                }
                latencies.push(performance.now() - began);
                count++;
              }
            }),
          );
        } finally {
          clearInterval(sample);
          elapsed.disable();
        }
        latencies.sort((a, b) => a - b);
        const hearts = heartbeatTimes.slice(heartbeatStart);
        const heartbeatMax = Math.max(
          0,
          ...hearts.slice(1).map((time, index) => time - hearts[index]),
        );
        results.push({
          concurrency,
          requests: latencies.length,
          durationMs: round(performance.now() - start),
          p50Ms: percentile(latencies, 0.5),
          p95Ms: percentile(latencies, 0.95),
          p99Ms: percentile(latencies, 0.99),
          eventLoopP99Ms: round(elapsed.percentile(99) / 1e6),
          eventLoopMaxMs: round(elapsed.max / 1e6),
          heartbeatMaxMs: round(heartbeatMax),
          heartbeats: hearts.length,
          peakRssMiB: round(rss / 1024 ** 2),
          errors,
        });
        expect(errors).toBe(0);
        expect(hearts.length).toBeGreaterThan(2);
        expect(heartbeatMax).toBeLessThan(LEASE_MS);
        expect(activeSync).toBe(2);
        expect(activeWrite).toBe(1);
      }
      release();
      await vi.waitFor(
        () => {
          for (const id of planned)
            expect(store.getJob(id)).toMatchObject({ state: "succeeded", attempt: 1 });
        },
        { timeout: 5000 },
      );
      expect(peaks).toEqual({ sync: 2, write: 1, total: 3 });
      expect([...claims.values()]).toEqual(planned.map(() => 1));
      expect([...executions.values()]).toEqual(planned.map(() => 1));
      expect(failedRenewals).toBe(0);
      expect(store.listActiveJobs()).toHaveLength(0);
      expect(fatal).toEqual([]);
      console.log(
        "OFFLINE_CAPACITY " +
          JSON.stringify({
            environment: {
              node: process.version,
              platform: process.platform,
              architecture: process.arch,
              cpu: cpus()[0]?.model,
              logicalCpus: cpus().length,
              totalMemoryGiB: round(totalmem() / 1024 ** 3),
            },
            scope: {
              accounts: accountRows.length,
              instances: inventory.length,
              jobs: planned.length,
              fakeNext: true,
              leaseMs: LEASE_MS,
              heartbeatMs: HEARTBEAT_MS,
              fakeIoMsAfterRelease: 30,
            },
            results,
            maxConcurrency: peaks,
            failedRenewals,
            duplicateClaims: 0,
            duplicateExecutions: 0,
          }),
      );
      expect(await app.stop()).toBe(0);
    } finally {
      release();
      await app?.stop();
      closeDatabase();
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (dirname(directory) !== base || !basename(directory).startsWith("runtime-capacity-"))
        throw new Error("Unsafe capacity fixture cleanup path");
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
