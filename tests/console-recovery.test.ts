import Database from "better-sqlite3";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleManager, type ConsoleManager } from "@/server/console/manager";
import { createConsoleStore, type ConsoleSessionRecord } from "@/server/console/store";
import { createConsoleTransport } from "@/server/console/transport";
import { consoleTags } from "@/server/console/oci";
import type { ConsoleActor, ConsoleTarget } from "@/server/console/types";
import type { CloudDocument, OciClients } from "@/server/oci/sdk";
import { initializeTestDatabase } from "./fixtures/database";

const actor: ConsoleActor = {
  userId: "test-user",
  username: "test-admin",
  sessionHash: "test-session-hash",
};
const target: ConsoleTarget = {
  instanceId: "ocid1.instance.oc1.phx.testinstance",
  instanceName: "recovery-test",
  accountId: "test-account",
  region: "us-phoenix-1",
  credentials: {
    tenancyId: "ocid1.tenancy.oc1..testtenancy",
    userId: "ocid1.user.oc1..testuser",
    fingerprint: "TEST",
    privateKey: "TEST-PRIVATE-KEY-NOT-PERSISTED",
    region: "us-phoenix-1",
  },
};
const connectionId = "ocid1.instanceconsoleconnection.oc1.phx.testconnection";
const handles: Database.Database[] = [];
const managers: ConsoleManager[] = [];
const timeout = () => ({ code: "ETIMEDOUT", message: "SDK details must remain private" });

function connection(sessionId: string): CloudDocument {
  return {
    id: connectionId,
    instanceId: target.instanceId,
    compartmentId: target.credentials.tenancyId,
    lifecycleState: "ACTIVE",
    freeformTags: consoleTags(target, sessionId),
    serviceHostKeyFingerprint: "SHA256:test-only",
    vncConnectionString: `ssh -o ProxyCommand='ssh -W %h:%p -p 443 ${connectionId}@instance-console.us-phoenix-1.oraclecloud.com' -N -L localhost:5900:${target.instanceId}:5900 ${target.instanceId}`,
  };
}

function persisted(id = "11111111-1111-4111-8111-111111111111"): ConsoleSessionRecord {
  return {
    id,
    instanceId: target.instanceId,
    instanceName: target.instanceName,
    accountId: target.accountId,
    region: target.region,
    ownerUserId: actor.userId,
    ownerUsername: actor.username,
    ownerSessionHash: actor.sessionHash,
    state: "preparing",
    connectionId: null,
    compartmentId: null,
    credentialRecoveryReady: false,
    creationState: "uncertain",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastActivityAt: new Date().toISOString(),
    readyAt: null,
    lastError: null,
    cleanupPending: false,
    slot: 1,
  };
}

function fixture() {
  const db = new Database(":memory:");
  handles.push(db);
  initializeTestDatabase(db);
  const store = createConsoleStore(db);
  const records = new Map<string, CloudDocument>();
  const state = {
    visible: true,
    readDenied: false,
    listDenied: false,
    parentMissing: false,
    compartments: [] as CloudDocument[],
    deniedCompartments: new Set<string>(),
    compartmentListDenied: false,
    compartmentNextPageDenied: false,
    outcomes: [] as ("success" | number | "timeout")[],
    creates: 0,
  };
  const history: { operation: string; request: CloudDocument }[] = [];
  const call = vi.fn(async (operation: string, request: CloudDocument): Promise<CloudDocument> => {
    history.push({ operation, request: structuredClone(request) });
    if (operation === "listCompartments") {
      if (state.compartmentListDenied) throw { statusCode: 403 };
      if (state.compartmentNextPageDenied) {
        if (request.page) throw { statusCode: 403 };
        return { items: state.compartments, opcNextPage: "inaccessible-page" };
      }
      return { items: state.compartments };
    }
    if (operation === "getInstance") {
      if (state.parentMissing) throw { statusCode: 404 };
      return {
        instance: {
          id: target.instanceId,
          compartmentId: target.credentials.tenancyId,
          lifecycleState: "RUNNING",
        },
      };
    }
    if (operation === "listInstanceConsoleConnections") {
      if (state.listDenied || state.deniedCompartments.has(request.compartmentId))
        throw { statusCode: 404, code: "NotAuthorizedOrNotFound" };
      return {
        items: state.visible ? [...records.values()].map((row) => structuredClone(row)) : [],
      };
    }
    if (operation === "createInstanceConsoleConnection") {
      expect(store.active()?.creationState).toBe("uncertain");
      expect(store.active()?.compartmentId).toBe(target.credentials.tenancyId);
      const outcome = state.outcomes[state.creates++] ?? "success";
      if (outcome === "timeout") throw timeout();
      if (typeof outcome === "number")
        throw {
          statusCode: outcome,
          code: outcome === 403 ? "NotAuthorizedOrNotFound" : "RejectedRequest",
        };
      const row = connection(request.opcRetryToken);
      records.set(row.id, row);
      return { instanceConsoleConnection: structuredClone(row) };
    }
    if (operation === "getInstanceConsoleConnection") {
      if (state.readDenied) throw { statusCode: 404, code: "NotAuthorizedOrNotFound" };
      const row = records.get(request.instanceConsoleConnectionId);
      if (!row) throw { statusCode: 404 };
      return { instanceConsoleConnection: structuredClone(row) };
    }
    if (operation === "deleteInstanceConsoleConnection") {
      records.delete(request.instanceConsoleConnectionId);
      return {};
    }
    throw new Error(`Unexpected mock operation ${operation}`);
  });
  const client = { call, close: vi.fn() };
  const clients: OciClients = {
    identity: client,
    compute: client,
    network: client,
    storage: client,
    monitoring: client,
  };
  const clientFactory = vi.fn(() => clients);
  const transport = createConsoleTransport({
    clientFactory,
    pollIntervalMs: 0,
    maxPolls: 2,
    ssh: async () => ({
      publicKey: "ssh-rsa TEST-ONLY-PUBLIC-KEY",
      close: async () => {},
      open: async () => ({
        connect: async () => new PassThrough(),
        close: async () => {},
        closed: new Promise<void>(() => {}),
      }),
    }),
  });
  const makeManager = () => {
    const manager = createConsoleManager({
      store: createConsoleStore(db),
      transport,
      resolveTarget: () => target,
      isActorValid: () => true,
      limits: { cleanupTimeoutMs: 100, checkIntervalMs: 10_000, cleanupRetryMs: 10_000 },
    });
    managers.push(manager);
    return manager;
  };
  return { db, store, records, state, history, call, clientFactory, transport, makeManager };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
});
afterEach(async () => {
  const stopping = Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  await vi.advanceTimersByTimeAsync(500);
  await stopping;
  handles.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("durable recovery of ambiguous OCI console creates", () => {
  it("uses the durable compartment after restart when the instance and console were deleted", async () => {
    const f = fixture(),
      row = {
        ...persisted(),
        connectionId,
        compartmentId: target.credentials.tenancyId,
        creationState: "created" as const,
      };
    f.store.reserve(row);
    f.state.parentMissing = true;
    await f.makeManager().initialize();
    expect(f.store.active()).toBeNull();
    expect(f.history.filter((entry) => entry.operation === "getInstance")).toHaveLength(0);
    expect(f.history.filter((entry) => entry.operation === "listCompartments")).toHaveLength(0);
    expect(
      f.history.find((entry) => entry.operation === "listInstanceConsoleConnections")?.request,
    ).toMatchObject({ compartmentId: row.compartmentId, instanceId: row.instanceId });
    expect(f.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
      false,
    );
  });

  it("recovers a row without a saved scope only after complete ANY-compartment scans when the parent is absent", async () => {
    const f = fixture(),
      row = { ...persisted(), connectionId, creationState: "created" as const };
    const child = "ocid1.compartment.oc1..recoverychild";
    f.store.reserve(row);
    f.state.parentMissing = true;
    f.state.compartments = [{ id: child, lifecycleState: "ACTIVE" }];
    await f.makeManager().initialize();
    expect(f.store.active()).toBeNull();
    expect(
      f.history.find((entry) => entry.operation === "listCompartments")?.request,
    ).toMatchObject({ accessLevel: "ANY", compartmentIdInSubtree: true });
    expect(
      f.history
        .filter((entry) => entry.operation === "listInstanceConsoleConnections")
        .map((entry) => entry.request.compartmentId),
    ).toEqual([target.credentials.tenancyId, child]);
  });

  it.each(["enumeration", "next-page", "child-list"])(
    "retains a cleanup lock without a saved scope when %s is unauthorized",
    async (denial) => {
      const f = fixture(),
        row = { ...persisted(), connectionId, creationState: "created" as const };
      const child = "ocid1.compartment.oc1..inaccessiblechild";
      f.store.reserve(row);
      f.state.parentMissing = true;
      f.state.compartments = [{ id: child, lifecycleState: "ACTIVE" }];
      if (denial === "enumeration") f.state.compartmentListDenied = true;
      else if (denial === "next-page") f.state.compartmentNextPageDenied = true;
      else f.state.deniedCompartments.add(child);
      await f.makeManager().initialize();
      expect(f.store.active()).toMatchObject({
        slot: 1,
        cleanupPending: true,
        credentialRecoveryReady: true,
      });
      expect(f.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
        false,
      );
    },
  );

  it("persists the recovered scope before deleting an owned connection", async () => {
    const f = fixture(),
      row = { ...persisted(), connectionId, creationState: "created" as const };
    f.store.reserve(row);
    f.records.set(connectionId, connection(row.id));
    await f.makeManager().initialize();
    expect(f.store.get(row.id)).toMatchObject({
      compartmentId: target.credentials.tenancyId,
      slot: null,
    });
    expect(f.records.size).toBe(0);
  });

  it.each([false, true])(
    "holds the slot after access is revoked and cleans after restoration (list denied: %s)",
    async (listDenied) => {
      const f = fixture(),
        manager = f.makeManager();
      await manager.initialize();
      const session = await manager.create(target.instanceId, actor);
      await vi.advanceTimersByTimeAsync(20);
      expect(f.store.active()?.state).toBe("ready");
      f.state.readDenied = true;
      f.state.listDenied = listDenied;
      await manager.close(session.id, actor);
      expect(f.store.active()).toMatchObject({ id: session.id, cleanupPending: true, slot: 1 });
      expect(f.records.size).toBe(1);
      await expect(manager.create(target.instanceId, actor)).rejects.toMatchObject({
        code: "CONSOLE_BUSY",
      });
      f.state.readDenied = false;
      f.state.listDenied = false;
      await manager.close(session.id, actor);
      expect(f.records.size).toBe(0);
      expect(f.store.active()).toBeNull();
      expect(f.store.get(session.id)).toMatchObject({
        state: "closed",
        cleanupPending: false,
        slot: null,
      });
    },
  );

  it("retains an uncertain slot across empty scans, then deletes the late visible connection", async () => {
    const f = fixture(),
      manager = f.makeManager();
    f.state.outcomes = ["timeout", "timeout"];
    await manager.initialize();
    const session = await manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.state.creates).toBe(2);
    expect(f.store.active()).toMatchObject({
      id: session.id,
      creationState: "uncertain",
      cleanupPending: true,
    });
    await expect(manager.create(target.instanceId, actor)).rejects.toMatchObject({
      code: "CONSOLE_BUSY",
    });
    await manager.close(session.id, actor);
    expect(f.store.active()?.creationState).toBe("uncertain");
    f.records.set(connectionId, connection(session.id));
    await manager.close(session.id, actor);
    expect(f.records.size).toBe(0);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)).toMatchObject({
      creationState: "created",
      cleanupPending: false,
    });
    expect(
      f.history.filter((call) => call.operation === "deleteInstanceConsoleConnection"),
    ).toHaveLength(1);
  });

  it("replays at most once with the identical request and retry token while the original key exists", async () => {
    const f = fixture(),
      manager = f.makeManager();
    f.state.outcomes = ["timeout", "success"];
    await manager.initialize();
    const session = await manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.store.active()).toMatchObject({
      id: session.id,
      state: "ready",
      creationState: "created",
      connectionId,
    });
    const creates = f.history.filter(
      (call) => call.operation === "createInstanceConsoleConnection",
    );
    expect(creates).toHaveLength(2);
    expect(creates[0].request).toEqual(creates[1].request);
    expect(creates[0].request.opcRetryToken).toBe(session.id);
    expect(JSON.stringify(f.store.get(session.id))).not.toContain("TEST-ONLY-PUBLIC-KEY");
    expect(JSON.stringify(f.store.get(session.id))).not.toContain(target.credentials.privateKey);
    await manager.close(session.id, actor);
    expect(f.store.active()).toBeNull();
  });

  it.each([400, 401, 403, 404, 409, 429])(
    "releases a definitively rejected first create (%i) without permission-dependent cleanup",
    async (status) => {
      const f = fixture(),
        manager = f.makeManager();
      f.state.outcomes = [status];
      await manager.initialize();
      const session = await manager.create(target.instanceId, actor);
      await vi.advanceTimersByTimeAsync(20);
      expect(f.state.creates).toBe(1);
      expect(f.store.active()).toBeNull();
      expect(f.store.get(session.id)).toMatchObject({
        state: "failed",
        creationState: "rejected",
        cleanupPending: false,
      });
      expect(
        f.history.filter((call) => call.operation === "listInstanceConsoleConnections"),
      ).toHaveLength(1);
      expect(
        f.history.filter((call) => call.operation === "deleteInstanceConsoleConnection"),
      ).toHaveLength(0);
    },
  );

  it("releases a preflight permission failure without issuing a cleanup scan", async () => {
    const f = fixture(),
      manager = f.makeManager();
    f.call.mockRejectedValueOnce({ statusCode: 403, code: "NotAuthorizedOrNotFound" });
    await manager.initialize();
    const session = await manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)).toMatchObject({
      state: "failed",
      creationState: "not_attempted",
      cleanupPending: false,
    });
    expect(f.call).toHaveBeenCalledTimes(1);
    expect(f.state.creates).toBe(0);
  });

  it("does not send create if its durable uncertainty marker cannot be recorded", async () => {
    const f = fixture(),
      row = { ...persisted(), creationState: "not_attempted" as const };
    f.store.reserve(row);
    await expect(
      f.transport.start({
        target,
        sessionId: row.id,
        signal: new AbortController().signal,
        onCreationState: () => {
          throw new Error("simulated persistence failure");
        },
        onConnectionCreated: vi.fn(),
      }),
    ).rejects.toBeDefined();
    expect(f.state.creates).toBe(0);
    expect(
      f.history.filter((call) => call.operation === "deleteInstanceConsoleConnection"),
    ).toHaveLength(0);
  });

  it("does not treat a later 403 as proof that an earlier timed-out create was rejected", async () => {
    const f = fixture(),
      manager = f.makeManager();
    f.state.outcomes = ["timeout", 403];
    await manager.initialize();
    const session = await manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(20);
    expect(f.state.creates).toBe(2);
    expect(f.store.active()).toMatchObject({
      id: session.id,
      creationState: "uncertain",
      cleanupPending: true,
    });
  });

  it("keeps an uncertain session through process recovery and never replays create after restart", async () => {
    const f = fixture(),
      row = persisted();
    f.store.reserve(row);
    const first = f.makeManager();
    await first.initialize();
    expect(f.store.active()).toMatchObject({
      id: row.id,
      creationState: "uncertain",
      cleanupPending: true,
    });
    await first.shutdown();
    const restarted = f.makeManager();
    await restarted.initialize();
    expect(f.store.active()?.id).toBe(row.id);
    f.records.set(connectionId, connection(row.id));
    await restarted.close(row.id, actor);
    expect(f.store.active()).toBeNull();
    expect(f.state.creates).toBe(0);
    expect(
      f.history.filter((call) => call.operation === "deleteInstanceConsoleConnection"),
    ).toHaveLength(1);
  });

  it("keeps the manager slot if a transport incorrectly reports success without resolving uncertainty", async () => {
    const f = fixture(),
      row = persisted();
    f.store.reserve(row);
    const manager = createConsoleManager({
      store: f.store,
      transport: { start: vi.fn(), cleanup: vi.fn(async () => {}) },
      resolveTarget: () => target,
      isActorValid: () => true,
    });
    managers.push(manager);
    await manager.initialize();
    expect(f.store.active()).toMatchObject({
      id: row.id,
      creationState: "uncertain",
      cleanupPending: true,
    });
  });
});
