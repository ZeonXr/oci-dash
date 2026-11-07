import Database from "better-sqlite3";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createConsoleManager,
  type ConsoleLimits,
  type ConsoleManager,
} from "@/server/console/manager";
import { createConsoleStore, type ConsoleSessionRecord } from "@/server/console/store";
import type {
  ConsoleActor,
  ConsoleTarget,
  ConsoleTransport,
  ConsoleTunnel,
} from "@/server/console/types";
import { CloudError } from "@/server/oci/types";

const actor: ConsoleActor = { userId: "user-1", username: "admin", sessionHash: "login-hash-1" };
const otherActor: ConsoleActor = { ...actor, sessionHash: "another-login" };
const target: ConsoleTarget = {
  instanceId: "instance-1",
  instanceName: "test-instance",
  accountId: "account-1",
  region: "region-1",
  credentials: {
    tenancyId: "tenancy",
    userId: "oci-user",
    fingerprint: "fp",
    privateKey: "TEST-PRIVATE-KEY-DO-NOT-PERSIST",
    region: "region-1",
  },
};
const handles: Database.Database[] = [];
const managers: ConsoleManager[] = [];

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(limits: Partial<ConsoleLimits> = {}, db = new Database(":memory:")) {
  if (!handles.includes(db)) handles.push(db);
  const store = createConsoleStore(db);
  const closed = deferred<void>();
  const stream = new PassThrough();
  const tunnel: ConsoleTunnel = {
    connectionId: "connection-1",
    connect: vi.fn(async () => stream),
    close: vi.fn(async () => {
      stream.destroy();
      closed.resolve();
    }),
    closed: closed.promise,
  };
  const transport = {
    start: vi.fn<ConsoleTransport["start"]>(async (input) => {
      input.onConnectionCreated(tunnel.connectionId);
      return tunnel;
    }),
    cleanup: vi.fn<ConsoleTransport["cleanup"]>(async () => undefined),
  };
  const valid = new Set([actor.sessionHash, otherActor.sessionHash]);
  const resolveTarget = vi.fn(() => target);
  const manager = createConsoleManager({
    store,
    transport,
    resolveTarget,
    isActorValid: (value) => valid.has(value.sessionHash),
    clock: () => Date.now(),
    limits: { cleanupTimeoutMs: 100, cleanupRetryMs: 200, checkIntervalMs: 50, ...limits },
  });
  managers.push(manager);
  return { manager, db, store, transport, tunnel, stream, closed, valid, resolveTarget };
}

async function ready(f: ReturnType<typeof fixture>) {
  await f.manager.initialize();
  const result = await f.manager.create(target.instanceId, actor);
  expect(result.state).toBe("preparing");
  await vi.advanceTimersByTimeAsync(0);
  expect(f.manager.get(result.id, actor).state).toBe("ready");
  return result;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  vi.setSystemTime(new Date("2026-11-07T00:00:00Z"));
  vi.stubEnv("DEMO_MODE", "false");
});

afterEach(async () => {
  const closing = Promise.allSettled(managers.splice(0).map((manager) => manager.shutdown()));
  await vi.advanceTimersByTimeAsync(500);
  await closing;
  handles.splice(0).forEach((db) => db.close());
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("console manager ownership and connection admission", () => {
  it("reserves the global slot before background preparation and rejects a concurrent create", async () => {
    const f = fixture(),
      pending = deferred<ConsoleTunnel>();
    f.transport.start.mockImplementation(() => pending.promise);
    await f.manager.initialize();
    const first = f.manager.create(target.instanceId, actor);
    await expect(f.manager.create(target.instanceId, otherActor)).rejects.toMatchObject({
      code: "CONSOLE_BUSY",
    });
    const session = await first;
    expect(session.state).toBe("preparing");
    expect(f.store.active()?.id).toBe(session.id);
    expect(f.transport.start).toHaveBeenCalledTimes(1);
    pending.resolve(f.tunnel);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shows only a safe global summary and binds all session operations to the owning login", async () => {
    const f = fixture(),
      session = await ready(f);
    expect(f.manager.current(otherActor)).toEqual(f.manager.get(session.id, actor));
    expect(JSON.stringify(f.manager.current(otherActor))).not.toMatch(
      /owner|sessionHash|credential|connectionId|TEST-PRIVATE/,
    );
    for (const run of [
      () => f.manager.get(session.id, otherActor),
      () => f.manager.issueTicket(session.id, otherActor),
      () => f.manager.touch(session.id, otherActor),
    ])
      expect(run).toThrow(expect.objectContaining({ code: "CONSOLE_FORBIDDEN" }));
    await expect(f.manager.close(session.id, otherActor)).rejects.toMatchObject({
      code: "CONSOLE_FORBIDDEN",
    });
    const ticket = f.manager.issueTicket(session.id, actor);
    await expect(f.manager.connect(session.id, ticket.ticket, otherActor)).rejects.toMatchObject({
      code: "CONSOLE_FORBIDDEN",
    });
    await f.manager.connect(session.id, ticket.ticket, actor);
    expect(f.manager.get(session.id, actor).state).toBe("connected");
  });

  it("uses expiring one-use tickets and rejects a second simultaneous websocket handshake", async () => {
    const f = fixture(),
      session = await ready(f);
    const old = f.manager.issueTicket(session.id, actor);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(f.manager.connect(session.id, old.ticket, actor)).rejects.toMatchObject({
      code: "CONSOLE_INVALID_TICKET",
    });
    const ticket = f.manager.issueTicket(session.id, actor);
    expect(ticket.ticket).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ticket.path).toBe(`/api/console/sessions/${session.id}/socket`);
    const pending = deferred<PassThrough>();
    vi.mocked(f.tunnel.connect).mockImplementation(() => pending.promise);
    const first = f.manager.connect(session.id, ticket.ticket, actor);
    await expect(f.manager.connect(session.id, ticket.ticket, actor)).rejects.toMatchObject({
      code: "CONSOLE_INVALID_TICKET",
    });
    expect(() => f.manager.issueTicket(session.id, actor)).toThrow(
      expect.objectContaining({ code: "CONSOLE_NOT_READY" }),
    );
    pending.resolve(f.stream);
    await expect(first).resolves.toBe(f.stream);
    expect(f.tunnel.connect).toHaveBeenCalledTimes(1);
    const persisted = JSON.stringify(f.db.prepare("SELECT * FROM console_sessions").all());
    expect(persisted).not.toContain(ticket.ticket);
    expect(persisted).not.toContain(target.credentials.privateKey);
  });

  it("invalidates an older ticket when a replacement is issued", async () => {
    const f = fixture(),
      session = await ready(f);
    const before = f.manager.issueTicket(session.id, actor);
    const after = f.manager.issueTicket(session.id, actor);
    expect(after.ticket).not.toBe(before.ticket);
    await expect(f.manager.connect(session.id, before.ticket, actor)).rejects.toMatchObject({
      code: "CONSOLE_INVALID_TICKET",
    });
    await f.manager.connect(session.id, after.ticket, actor);
  });

  it("rejects demo creation before transport or target credentials are accessed", async () => {
    const f = fixture();
    await f.manager.initialize();
    vi.stubEnv("DEMO_MODE", "true");
    await expect(f.manager.create(target.instanceId, actor)).rejects.toMatchObject({
      code: "DEMO_MODE",
    });
    expect(f.resolveTarget).not.toHaveBeenCalled();
    expect(f.transport.start).not.toHaveBeenCalled();
    expect(f.store.active()).toBeNull();
  });

  it.each(["connected", "failed"] as const)(
    "preserves a persisted %s session without cloud recovery or cleanup in demo mode",
    async (state) => {
      const f = fixture();
      const record: ConsoleSessionRecord = {
        id: "previous-real-session",
        instanceId: target.instanceId,
        instanceName: target.instanceName,
        accountId: target.accountId,
        region: target.region,
        ownerUserId: actor.userId,
        ownerUsername: actor.username,
        ownerSessionHash: "old-real-login",
        state,
        connectionId: "previous-real-oci-connection",
        creationState: "created",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 1_000).toISOString(),
        lastActivityAt: new Date().toISOString(),
        readyAt: new Date().toISOString(),
        lastError: state === "failed" ? "cleanup pending" : null,
        cleanupPending: state === "failed",
        slot: 1,
      };
      f.store.reserve(record);
      vi.stubEnv("DEMO_MODE", "true");
      await f.manager.initialize();
      await vi.advanceTimersByTimeAsync(60_000);
      await f.manager.shutdown();
      expect(f.store.get(record.id)).toEqual(record);
      expect(f.store.active()?.id).toBe(record.id);
      expect(f.resolveTarget).not.toHaveBeenCalled();
      expect(f.transport.start).not.toHaveBeenCalled();
      expect(f.transport.cleanup).not.toHaveBeenCalled();
      expect(f.tunnel.close).not.toHaveBeenCalled();
    },
  );
});

describe("console cleanup and recovery", () => {
  it.each(["close", "error", "tunnel"] as const)(
    "cleans the OCI connection after %s disconnect",
    async (kind) => {
      const f = fixture(),
        session = await ready(f);
      const ticket = f.manager.issueTicket(session.id, actor);
      await f.manager.connect(session.id, ticket.ticket, actor);
      if (kind === "close") f.stream.destroy();
      if (kind === "error") f.stream.destroy(new Error("private transport diagnostic"));
      if (kind === "tunnel") f.closed.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.store.active()).toBeNull();
      expect(f.tunnel.close).toHaveBeenCalledTimes(1);
      expect(f.transport.cleanup).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: session.id, connectionId: "connection-1", target }),
      );
      expect(JSON.stringify(f.store.get(session.id))).not.toContain("private transport diagnostic");
    },
  );

  it("retains its slot after cleanup failure and allows explicit DELETE retry", async () => {
    const f = fixture(),
      session = await ready(f);
    f.transport.cleanup.mockRejectedValueOnce(new Error("secret SDK detail"));
    await f.manager.close(session.id, actor);
    expect(f.manager.get(session.id, actor)).toMatchObject({
      state: "failed",
      cleanupPending: true,
    });
    expect(f.store.active()?.id).toBe(session.id);
    await expect(f.manager.create(target.instanceId, actor)).rejects.toMatchObject({
      code: "CONSOLE_BUSY",
    });
    await f.manager.close(session.id, actor);
    expect(f.store.active()).toBeNull();
    expect(f.manager.get(session.id, actor)).toMatchObject({
      state: "closed",
      cleanupPending: false,
    });
    expect(f.transport.cleanup).toHaveBeenCalledTimes(2);
  });

  it("automatically retries a failed cleanup", async () => {
    const f = fixture(),
      session = await ready(f);
    f.transport.cleanup.mockRejectedValueOnce(new Error("temporary cloud failure"));
    await f.manager.close(session.id, actor);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.store.active()).toBeNull();
    expect(f.transport.cleanup).toHaveBeenCalledTimes(2);
  });

  it("waits for a cancelled create to finish before deleting its late OCI connection", async () => {
    const f = fixture(),
      pending = deferred<ConsoleTunnel>();
    let created!: (connectionId: string) => void;
    f.transport.start.mockImplementation((input) => {
      created = input.onConnectionCreated;
      return pending.promise;
    });
    await f.manager.initialize();
    const session = await f.manager.create(target.instanceId, actor);
    const closing = f.manager.close(session.id, actor);
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(f.store.active()?.cleanupPending).toBe(true);
    expect(f.transport.cleanup).not.toHaveBeenCalled();
    created("late-created-connection");
    f.tunnel.connectionId = "late-created-connection";
    pending.resolve(f.tunnel);
    await vi.advanceTimersByTimeAsync(250);
    expect(f.store.active()).toBeNull();
    expect(f.transport.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: session.id, connectionId: "late-created-connection" }),
    );
    expect(f.tunnel.close).toHaveBeenCalled();
  });

  it("persists the OCI id before preparation fails and cleans up without exposing its error", async () => {
    const f = fixture();
    f.transport.start.mockImplementation(async (input) => {
      input.onConnectionCreated("connection-created-before-failure");
      throw new Error(`ssh connection details ${target.credentials.privateKey}`);
    });
    await f.manager.initialize();
    const session = await f.manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.manager.get(session.id, actor)).toMatchObject({
      state: "failed",
      cleanupPending: false,
    });
    expect(f.store.active()).toBeNull();
    expect(f.transport.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "connection-created-before-failure" }),
    );
    expect(JSON.stringify(f.store.get(session.id))).not.toContain(target.credentials.privateKey);
    expect(f.store.get(session.id)?.lastError).toBe(
      "控制台连接准备失败，请检查实例状态和 OCI 权限。",
    );
  });

  it.each([
    ["OCI 控制台 SSH 主机指纹不匹配", "CONSOLE_HOST_KEY_MISMATCH"],
    ["OCI 控制台连接失败（NotAuthorizedOrNotFound / HTTP 404）", "NotAuthorizedOrNotFound"],
  ])("exposes the safe CloudError reason and code: %s", async (message, code) => {
    const f = fixture();
    f.transport.start.mockRejectedValue(new CloudError(message, code));
    await f.manager.initialize();
    const session = await f.manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.get(session.id)).toMatchObject({
      state: "failed",
      cleanupPending: false,
      slot: null,
    });
    expect(f.store.get(session.id)?.lastError).toContain(message);
    expect(f.store.get(session.id)?.lastError).toContain(code);
  });

  it("bounds an unresponsive cleanup and does not overlap subsequent attempts", async () => {
    const f = fixture(),
      session = await ready(f),
      pending = deferred<void>();
    f.transport.cleanup.mockImplementationOnce(() => pending.promise);
    const closing = f.manager.close(session.id, actor);
    await vi.advanceTimersByTimeAsync(100);
    await closing;
    expect(f.store.active()?.cleanupPending).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(f.transport.cleanup).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(300);
    expect(f.store.active()).toBeNull();
  });

  it("recovers only the recorded session at startup even when no live browser exists", async () => {
    const f = fixture();
    const record: ConsoleSessionRecord = {
      id: "previous-application-session",
      instanceId: target.instanceId,
      instanceName: target.instanceName,
      accountId: target.accountId,
      region: target.region,
      ownerUserId: actor.userId,
      ownerUsername: actor.username,
      ownerSessionHash: "revoked-old-login",
      state: "connected",
      connectionId: "previous-oci-connection",
      creationState: "created",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      lastActivityAt: new Date().toISOString(),
      readyAt: new Date().toISOString(),
      lastError: null,
      cleanupPending: false,
      slot: 1,
    };
    f.store.reserve(record);
    await f.manager.initialize();
    expect(f.transport.start).not.toHaveBeenCalled();
    expect(f.transport.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: record.id, connectionId: record.connectionId }),
    );
    expect(f.store.get(record.id)).toMatchObject({
      state: "closed",
      cleanupPending: false,
      slot: null,
    });
    expect(f.manager.current(actor)).toBeNull();
  });

  it("preserves the slot if recovery cannot resolve credentials and can retry later", async () => {
    const f = fixture(),
      session = await ready(f);
    // Simulate a persisted session in a newly started manager, with no in-memory target.
    const recovered = fixture({}, f.db);
    recovered.resolveTarget.mockImplementation(() => {
      throw new Error("Credentials unavailable");
    });
    await recovered.manager.initialize();
    expect(recovered.store.active()?.cleanupPending).toBe(true);
    recovered.resolveTarget.mockReturnValue(target);
    await recovered.manager.close(session.id, actor);
    expect(recovered.store.active()).toBeNull();
  });

  it("cleans up during shutdown and rejects subsequent requests", async () => {
    const f = fixture(),
      session = await ready(f);
    await f.manager.shutdown();
    expect(f.store.get(session.id)?.slot).toBeNull();
    expect(f.transport.cleanup).toHaveBeenCalledTimes(1);
    await expect(f.manager.create(target.instanceId, actor)).rejects.toMatchObject({
      code: "CONSOLE_UNAVAILABLE",
    });
  });

  it("closes a stream that arrives after its connection attempt timed out", async () => {
    const f = fixture({ connectTimeoutMs: 100 }),
      session = await ready(f),
      pending = deferred<PassThrough>();
    vi.mocked(f.tunnel.connect).mockImplementation(() => pending.promise);
    const connecting = f.manager.connect(
      session.id,
      f.manager.issueTicket(session.id, actor).ticket,
      actor,
    );
    const failure = expect(connecting).rejects.toMatchObject({ code: "CONSOLE_CONNECT_FAILED" });
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    const late = new PassThrough();
    pending.resolve(late);
    await vi.advanceTimersByTimeAsync(0);
    expect(late.destroyed).toBe(true);
    expect(f.store.active()).toBeNull();
  });

  it("does not make a prepared tunnel available after the owner's login is revoked", async () => {
    const f = fixture(),
      pending = deferred<ConsoleTunnel>();
    f.transport.start.mockImplementation(() => pending.promise);
    await f.manager.initialize();
    const session = await f.manager.create(target.instanceId, actor);
    f.valid.delete(actor.sessionHash);
    pending.resolve(f.tunnel);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)?.state).toBe("closed");
    expect(f.tunnel.close).toHaveBeenCalledTimes(1);
  });
});

describe("console expiration", () => {
  it("closes an unused ready session after 60 seconds without extending on status polls", async () => {
    const f = fixture(),
      session = await ready(f);
    await vi.advanceTimersByTimeAsync(59_000);
    f.manager.get(session.id, actor);
    f.manager.current(actor);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)?.lastError).toContain("未连接");
  });

  it("expires idle connections but accepts explicit activity until the hard lifetime", async () => {
    const f = fixture({ idleTimeoutMs: 500, maxDurationMs: 1_000 }),
      session = await ready(f);
    const ticket = f.manager.issueTicket(session.id, actor);
    await f.manager.connect(session.id, ticket.ticket, actor);
    await vi.advanceTimersByTimeAsync(400);
    f.manager.touch(session.id, actor);
    await vi.advanceTimersByTimeAsync(400);
    expect(f.manager.get(session.id, actor).state).toBe("connected");
    f.manager.touch(session.id, actor);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)?.lastError).toContain("最长");
  });

  it("ignores output traffic for idle timeout", async () => {
    const f = fixture({ idleTimeoutMs: 200 }),
      session = await ready(f);
    await f.manager.connect(session.id, f.manager.issueTicket(session.id, actor).ticket, actor);
    f.stream.write("screen updates are not user input");
    await vi.advanceTimersByTimeAsync(200);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)?.lastError).toContain("无操作");
  });

  it("closes a session after its owner logs out", async () => {
    const f = fixture(),
      session = await ready(f);
    await f.manager.connect(session.id, f.manager.issueTicket(session.id, actor).ticket, actor);
    f.valid.delete(actor.sessionHash);
    await vi.advanceTimersByTimeAsync(50);
    expect(f.store.active()).toBeNull();
    expect(f.stream.destroyed).toBe(true);
    expect(f.store.get(session.id)?.lastError).toContain("登录");
  });

  it("times out preparation without freeing its slot before the cloud call settles", async () => {
    const f = fixture({ prepareTimeoutMs: 200 }),
      pending = deferred<ConsoleTunnel>();
    f.transport.start.mockImplementation(() => pending.promise);
    await f.manager.initialize();
    const session = await f.manager.create(target.instanceId, actor);
    await vi.advanceTimersByTimeAsync(300);
    expect(f.store.active()?.id).toBe(session.id);
    expect(f.transport.start.mock.calls[0][0].signal.aborted).toBe(true);
    pending.reject(new Error("aborted"));
    await vi.advanceTimersByTimeAsync(250);
    expect(f.store.active()).toBeNull();
    expect(f.store.get(session.id)?.state).toBe("failed");
  });

  it("cannot revive an expired connection with touch between timer checks", async () => {
    const f = fixture({ idleTimeoutMs: 200, checkIntervalMs: 500 }),
      session = await ready(f);
    await f.manager.connect(session.id, f.manager.issueTicket(session.id, actor).ticket, actor);
    vi.setSystemTime(new Date(Date.now() + 201));
    expect(() => f.manager.touch(session.id, actor)).toThrow(
      expect.objectContaining({ code: "CONSOLE_EXPIRED" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.active()).toBeNull();
  });

  it("cannot issue a websocket ticket for an expired ready session between timer checks", async () => {
    const f = fixture({ readyTimeoutMs: 200, checkIntervalMs: 500 }),
      session = await ready(f);
    vi.setSystemTime(new Date(Date.now() + 201));
    expect(() => f.manager.issueTicket(session.id, actor)).toThrow(
      expect.objectContaining({ code: "CONSOLE_EXPIRED" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.active()).toBeNull();
  });
});
