import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsoleTransport } from "@/server/console/transport";
import { consoleTags } from "@/server/console/oci";
import {
  createOpenSshFactory,
  parseVncConnectionString,
  verifiedServiceHostKey,
  type ConsoleSshFactory,
  type ConsoleSshProcess,
  type ConsoleSshRunner,
} from "@/server/console/ssh";
import type { ConsoleTarget } from "@/server/console/types";
import type { CloudDocument, OciClients } from "@/server/oci/sdk";

const id = (kind: string, value = "example") => "ocid1." + kind + ".oc1.phx." + value;
const sessionId = "22222222-2222-4222-8222-222222222222";
const target: ConsoleTarget = {
  instanceId: id("instance"),
  instanceName: "offline-test",
  accountId: "test-account",
  region: "us-phoenix-1",
  credentials: {
    tenancyId: id("tenancy"),
    userId: id("user"),
    fingerprint: "TEST",
    privateKey: "TEST-ONLY",
    region: "us-phoenix-1",
  },
};
const connectionId = id("instanceconsoleconnection");
const serviceHost = "instance-console.us-phoenix-1.oraclecloud.com";
const officialCommand = (host = serviceHost) =>
  "ssh -o ProxyCommand='ssh -W %h:%p -p 443 " +
  connectionId +
  "@" +
  host +
  "' -N -L localhost:5900:" +
  target.instanceId +
  ":5900 " +
  target.instanceId;
const endpoint = () =>
  parseVncConnectionString(officialCommand(), {
    instanceId: target.instanceId,
    connectionId,
    region: target.region,
  });

function key(type: string, suffix: string) {
  const name = Buffer.from(type),
    length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  // A synthetic SSH blob is sufficient for fingerprint/pinning tests. Never used for authentication.
  const blob = Buffer.concat([length, name, Buffer.from(suffix)]);
  return {
    scan: "[example]:443 " + type + " " + blob.toString("base64") + "\n",
    fingerprint: "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, ""),
    encoded: blob.toString("base64"),
  };
}
const outerKey = key("ssh-rsa", "outer-api-verified-test-key");
const innerKey = key("ssh-ed25519", "different-inner-tunneled-test-key");
const live = (overrides: CloudDocument = {}): CloudDocument => ({
  id: connectionId,
  instanceId: target.instanceId,
  compartmentId: target.credentials.tenancyId,
  lifecycleState: "ACTIVE",
  freeformTags: consoleTags(target, sessionId),
  vncConnectionString: officialCommand(),
  serviceHostKeyFingerprint: outerKey.fingerprint,
  ...overrides,
});

function setup() {
  const records = new Map<string, CloudDocument>();
  const history: { operation: string; request: CloudDocument }[] = [];
  const state: {
    createError?: unknown;
    readError?: unknown;
    listError?: unknown;
    etag?: string;
    deletePending?: boolean;
    instance?: CloudDocument;
    afterCreate?: () => void;
    afterList?: () => void;
    transformGet?: (connection: CloudDocument) => CloudDocument;
  } = {};
  const call = vi.fn(async (operation: string, request: CloudDocument): Promise<CloudDocument> => {
    history.push({ operation, request });
    if (operation === "listCompartments") return { items: [] };
    if (operation === "getInstance")
      return {
        instance: state.instance ?? {
          id: target.instanceId,
          compartmentId: target.credentials.tenancyId,
          lifecycleState: "RUNNING",
        },
      };
    if (operation === "listInstanceConsoleConnections") {
      if (state.listError) throw state.listError;
      state.afterList?.();
      return { items: [...records.values()].map((record) => structuredClone(record)) };
    }
    if (operation === "createInstanceConsoleConnection") {
      const created = live({
        freeformTags: request.createInstanceConsoleConnectionDetails.freeformTags,
      });
      records.set(created.id, created);
      state.afterCreate?.();
      if (state.createError) throw state.createError;
      return { instanceConsoleConnection: structuredClone(created) };
    }
    if (operation === "getInstanceConsoleConnection") {
      if (state.readError) throw state.readError;
      const found = records.get(request.instanceConsoleConnectionId);
      if (!found) throw { statusCode: 404 };
      return {
        instanceConsoleConnection: state.transformGet?.(found) ?? structuredClone(found),
        ...(state.etag ? { etag: state.etag } : {}),
      };
    }
    if (operation === "deleteInstanceConsoleConnection") {
      if (state.deletePending)
        records.get(request.instanceConsoleConnectionId)!.lifecycleState = "DELETING";
      else records.delete(request.instanceConsoleConnectionId);
      return {};
    }
    throw new Error("Unexpected test operation " + operation);
  });
  const clientClose = vi.fn();
  const client = { call, close: clientClose };
  const clients: OciClients = {
    identity: client,
    compute: client,
    network: client,
    storage: client,
    monitoring: client,
  };
  const clientFactory = vi.fn(() => clients);
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const sshClose = vi.fn(async () => {
    resolveClosed();
  });
  const open = vi.fn(async () => ({
    close: sshClose,
    closed,
    connect: async () => new PassThrough(),
  }));
  const ssh: ConsoleSshFactory = vi.fn(async () => ({
    publicKey: "ssh-rsa TEST-ONLY",
    open,
    close: sshClose,
  }));
  const transport = createConsoleTransport({
    clientFactory,
    ssh,
    pollIntervalMs: 0,
    maxPolls: 2,
  });
  const controller = new AbortController();
  const onConnectionCreated = vi.fn();
  const input = { target, sessionId, signal: controller.signal, onConnectionCreated };
  return {
    records,
    history,
    state,
    call,
    clientClose,
    clientFactory,
    ssh,
    sshClose,
    open,
    transport,
    controller,
    onConnectionCreated,
    input,
  };
}

describe("OCI VNC command and key verification", () => {
  it("accepts ECDSA-only OCI service keys and pins only the API fingerprint match", () => {
    const ecdsa = key("ecdsa-sha2-nistp256", "oci-singapore-ecdsa-service-contract");
    const expected = "oci-console-service ecdsa-sha2-nistp256 " + ecdsa.encoded + "\n";
    expect(verifiedServiceHostKey(ecdsa.scan, ecdsa.fingerprint)).toBe(expected);
    expect(verifiedServiceHostKey(outerKey.scan + ecdsa.scan, ecdsa.fingerprint)).toBe(expected);
    expect(() => verifiedServiceHostKey(ecdsa.scan, outerKey.fingerprint)).toThrowError(
      expect.objectContaining({ code: "CONSOLE_HOST_KEY_MISMATCH" }),
    );
  });

  it("parses the official command and only admits the expected Oracle region and OCIDs", () => {
    expect(endpoint()).toEqual({
      serviceHost,
      connectionId,
      instanceId: target.instanceId,
      innerSshPort: 22,
      vncHost: target.instanceId,
      vncPort: 5900,
    });
    const modern = officialCommand("instance-console.us-phoenix-1.oci.oraclecloud.com");
    expect(
      parseVncConnectionString(modern, {
        instanceId: target.instanceId,
        connectionId,
        region: target.region,
      }).serviceHost,
    ).toContain(".oci.oraclecloud.com");
  });

  it.each([
    (value: string) => value + "; id",
    (value: string) => value + "\nwhoami",
    (value: string) => value.replace("-N", "-o StrictHostKeyChecking=no -N"),
    (value: string) => value.replace("localhost:5900", "0.0.0.0:5900"),
    (value: string) =>
      value.replace(serviceHost, "instance-console.us-phoenix-1.oraclecloud.com.evil.test"),
    (value: string) => value.replace(serviceHost, "instance-console.uk-london-1.oraclecloud.com"),
    (value: string) => value.replace(connectionId, id("instanceconsoleconnection", "other")),
    (value: string) => value.replace("%h:%p", "$HOME"),
    (value: string) => value.replace("%h:%p", "\u0060id\u0060"),
    (value: string) => value.replace("-L localhost", "-L 127.0.0.1:1:localhost"),
    (value: string) => value.replace("ssh -W", "sh -c"),
  ])("rejects command injection, unexpected options, targets and forwarding", (mutate) => {
    expect(() =>
      parseVncConnectionString(mutate(officialCommand()), {
        instanceId: target.instanceId,
        connectionId,
        region: target.region,
      }),
    ).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_CONSOLE_COMMAND" }));
  });

  it("requires the exact API fingerprint for each accepted service key", () => {
    expect(verifiedServiceHostKey(outerKey.scan, outerKey.fingerprint)).toBe(
      "oci-console-service ssh-rsa " + outerKey.encoded + "\n",
    );
    expect(() => verifiedServiceHostKey(outerKey.scan, innerKey.fingerprint)).toThrowError(
      expect.objectContaining({ code: "CONSOLE_HOST_KEY_MISMATCH" }),
    );
    expect(verifiedServiceHostKey(innerKey.scan, innerKey.fingerprint)).toBe(
      "oci-console-service ssh-ed25519 " + innerKey.encoded + "\n",
    );
    expect(() => verifiedServiceHostKey(outerKey.scan, "not-a-fingerprint")).toThrowError(
      expect.objectContaining({ code: "CONSOLE_FINGERPRINT_INVALID" }),
    );
  });
});

describe("OCI console transport ownership and lifetime", () => {
  it("lists only public connection metadata for the verified instance without changing resources", async () => {
    const h = setup();
    const deletedId = id("instanceconsoleconnection", "deleted");
    const foreignId = id("instanceconsoleconnection", "foreign");
    h.records.set(connectionId, live({ freeformTags: {} }));
    h.records.set(deletedId, live({ id: deletedId, lifecycleState: "DELETED" }));
    h.records.set(foreignId, live({ id: foreignId, instanceId: id("instance", "foreign") }));
    expect(await h.transport.connections(h.input)).toEqual([{ id: connectionId, state: "ACTIVE" }]);
    expect(h.history.at(-1)).toEqual({
      operation: "listInstanceConsoleConnections",
      request: { compartmentId: target.credentials.tenancyId, instanceId: target.instanceId },
    });
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "fresh-etag"])(
    "replaces only the explicitly confirmed untagged connection using a fresh read (%s)",
    async (etag) => {
      const h = setup();
      const oldId = id("instanceconsoleconnection", "old");
      h.state.etag = etag;
      h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
      const tunnel = await h.transport.start({ ...h.input, replaceConnectionId: oldId });
      const deletionIndex = h.history.findIndex(
        (entry) => entry.operation === "deleteInstanceConsoleConnection",
      );
      expect(h.history[deletionIndex - 1]).toEqual({
        operation: "getInstanceConsoleConnection",
        request: { instanceConsoleConnectionId: oldId },
      });
      expect(h.history[deletionIndex].request).toEqual({
        instanceConsoleConnectionId: oldId,
        ...(etag ? { ifMatch: etag } : {}),
      });
      const createIndex = h.history.findIndex(
        (entry) => entry.operation === "createInstanceConsoleConnection",
      );
      expect(createIndex).toBeGreaterThan(deletionIndex);
      expect(
        h.history.slice(deletionIndex + 1, createIndex).map((entry) => entry.operation),
      ).toEqual(["listInstanceConsoleConnections", "listInstanceConsoleConnections"]);
      expect([...h.records.keys()]).toEqual([connectionId]);
      expect(h.records.get(connectionId)?.freeformTags).toEqual(consoleTags(target, sessionId));
      await tunnel.close();
    },
  );

  it.each([
    { instanceId: id("instance", "foreign") },
    { compartmentId: id("compartment", "foreign") },
    { id: id("instanceconsoleconnection", "different") },
  ])("does not replace a connection whose fresh identity changed: %j", async (overrides) => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.transformGet = (value) => ({ ...value, ...overrides });
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toBeDefined();
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.records.has(oldId)).toBe(true);
    expect(h.sshClose).toHaveBeenCalledTimes(1);
  });

  it("refuses a different live connection even when another ID was confirmed", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.records.set(connectionId, live({ freeformTags: {} }));
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toMatchObject({ code: "CONSOLE_CONNECTION_EXISTS" });
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.ssh).not.toHaveBeenCalled();
  });

  it("prepares the local SSH session before ending the confirmed connection", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    vi.mocked(h.ssh).mockRejectedValue(new Error("SSH unavailable"));
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toBeDefined();
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.records.has(oldId)).toBe(true);
  });

  it("keeps the selected connection and creates nothing when cancellation follows listing", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.afterList = () => h.controller.abort();
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.ssh).not.toHaveBeenCalled();
  });

  it.each(["CREATING", "DELETING"])(
    "does not create another connection while the old connection is %s",
    async (lifecycleState) => {
      const h = setup();
      const oldId = id("instanceconsoleconnection", "old");
      h.records.set(oldId, live({ id: oldId, lifecycleState, freeformTags: {} }));
      await expect(
        h.transport.start({ ...h.input, replaceConnectionId: oldId }),
      ).rejects.toMatchObject({
        code:
          lifecycleState === "CREATING"
            ? "CONSOLE_CONNECTION_EXISTS"
            : "CONSOLE_REPLACEMENT_PENDING",
      });
      expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
      expect(h.records.has(oldId)).toBe(true);
    },
  );

  it("does not create if the explicitly deleted connection remains pending", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.deletePending = true;
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toMatchObject({ code: "CONSOLE_REPLACEMENT_PENDING" });
    expect(h.history.filter((entry) => entry.operation.startsWith("delete"))).toHaveLength(1);
    expect(h.history.some((entry) => entry.operation.startsWith("create"))).toBe(false);
    expect(h.records.get(oldId)?.lifecycleState).toBe("DELETING");
  });

  it("does not infer deletion or start a new connection after a fresh read returns permission 404", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.readError = { statusCode: 404, code: "NotAuthorizedOrNotFound" };
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toMatchObject({ code: "NotAuthorizedOrNotFound" });
    expect(h.history.some((entry) => /create|delete/i.test(entry.operation))).toBe(false);
    expect(h.records.has(oldId)).toBe(true);
  });

  it("accepts a concurrently removed old connection only after a complete scoped list proves absence", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.transformGet = (value) => {
      if (value.id === oldId) {
        h.records.delete(oldId);
        throw { statusCode: 404, code: "NotAuthorizedOrNotFound" };
      }
      return structuredClone(value);
    };
    const tunnel = await h.transport.start({ ...h.input, replaceConnectionId: oldId });
    expect(h.history.some((entry) => entry.operation.startsWith("delete"))).toBe(false);
    expect([...h.records.keys()]).toEqual([connectionId]);
    expect(h.onConnectionCreated).toHaveBeenCalledExactlyOnceWith(connectionId);
    await tunnel.close();
  });

  it("does not create if deletion cannot be proven by a successful scoped list", async () => {
    const h = setup();
    const oldId = id("instanceconsoleconnection", "old");
    h.records.set(oldId, live({ id: oldId, freeformTags: {} }));
    h.state.transformGet = (value) => {
      h.state.listError = { statusCode: 403, code: "NotAuthorizedOrNotFound" };
      return structuredClone(value);
    };
    await expect(
      h.transport.start({ ...h.input, replaceConnectionId: oldId }),
    ).rejects.toMatchObject({ code: "NotAuthorizedOrNotFound" });
    expect(h.history.filter((entry) => entry.operation.startsWith("delete"))).toHaveLength(1);
    expect(h.history.some((entry) => entry.operation.startsWith("create"))).toBe(false);
    expect(h.onConnectionCreated).not.toHaveBeenCalled();
  });

  it("cleans a known OCI connection without an undocumented ETag or a compartment scan", async () => {
    for (const etag of [undefined, "optional-console-etag"]) {
      const h = setup();
      h.state.etag = etag;
      h.records.set(connectionId, live());
      await h.transport.cleanup({ ...h.input, connectionId });
      expect(h.history.map((entry) => entry.operation)).toEqual([
        "getInstanceConsoleConnection",
        "deleteInstanceConsoleConnection",
        "getInstanceConsoleConnection",
        "listInstanceConsoleConnections",
      ]);
      const deletion = h.history[1].request;
      expect(deletion).toEqual({
        instanceConsoleConnectionId: connectionId,
        ...(etag ? { ifMatch: etag } : {}),
      });
      expect(h.records.size).toBe(0);
    }
  });

  it("verifies a missing known connection with a complete scoped list before releasing it", async () => {
    const h = setup();
    await h.transport.cleanup({ ...h.input, connectionId });
    expect(h.history.map((entry) => entry.operation)).toEqual([
      "getInstanceConsoleConnection",
      "getInstance",
      "listInstanceConsoleConnections",
    ]);
    expect(h.history.at(-1)?.request).toEqual({
      compartmentId: target.credentials.tenancyId,
      instanceId: target.instanceId,
    });
  });

  it("retains cleanup when a permission 404 hides a still-listed connection", async () => {
    const h = setup();
    h.records.set(connectionId, live());
    h.state.readError = { statusCode: 404, code: "NotAuthorizedOrNotFound" };
    await expect(h.transport.cleanup({ ...h.input, connectionId })).rejects.toMatchObject({
      code: "CONSOLE_CLEANUP_UNCONFIRMED",
      retryable: true,
    });
    expect(h.records.size).toBe(1);
    expect(h.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
      false,
    );
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it.each([403, 404])(
    "retains cleanup when both read and listing lose access (%i)",
    async (status) => {
      const h = setup();
      h.records.set(connectionId, live());
      h.state.readError = { statusCode: 404, code: "NotAuthorizedOrNotFound" };
      h.state.listError = { statusCode: status, code: "NotAuthorizedOrNotFound" };
      await expect(h.transport.cleanup({ ...h.input, connectionId })).rejects.toMatchObject({
        code: "NotAuthorizedOrNotFound",
      });
      expect(h.records.size).toBe(1);
      expect(h.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
        false,
      );
    },
  );

  it("does not release a deleted connection until its absence can be confirmed", async () => {
    const h = setup();
    h.records.set(connectionId, live());
    h.state.listError = { statusCode: 403, code: "NotAuthorizedOrNotFound" };
    await expect(h.transport.cleanup({ ...h.input, connectionId })).rejects.toMatchObject({
      code: "NotAuthorizedOrNotFound",
    });
    expect(h.records.size).toBe(0);
    h.state.listError = undefined;
    await h.transport.cleanup({ ...h.input, connectionId });
    expect(
      h.history.filter((entry) => entry.operation === "deleteInstanceConsoleConnection"),
    ).toHaveLength(1);
  });

  it("persists create ID immediately, validates the target, uses retry token, and releases clients", async () => {
    const h = setup();
    h.onConnectionCreated.mockImplementation(() => {
      expect(h.history.at(-1)?.operation).toBe("createInstanceConsoleConnection");
    });
    const tunnel = await h.transport.start(h.input);
    expect(tunnel.connectionId).toBe(connectionId);
    expect(h.onConnectionCreated).toHaveBeenCalledExactlyOnceWith(connectionId);
    const request = h.history.find(
      (item) => item.operation === "createInstanceConsoleConnection",
    )!.request;
    expect(request.opcRetryToken).toBe(sessionId);
    expect(request.createInstanceConsoleConnectionDetails.freeformTags).toEqual(
      consoleTags(target, sessionId),
    );
    expect(h.open).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceHostKeyFingerprint: outerKey.fingerprint,
      }),
    );
    expect(h.clientClose).toHaveBeenCalledTimes(1);
    await tunnel.close();
  });

  it("refuses all existing nondeleted connections without deleting or generating a new key", async () => {
    const h = setup();
    h.records.set(connectionId, live({ freeformTags: { owner: "somebody-else" } }));
    await expect(h.transport.start(h.input)).rejects.toMatchObject({
      code: "CONSOLE_CONNECTION_EXISTS",
    });
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.history.some((entry) => entry.operation.startsWith("delete"))).toBe(false);
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it("refuses an instance outside the tenancy and a mismatched credential region", async () => {
    const h = setup();
    h.state.instance = { id: target.instanceId, compartmentId: id("compartment", "outside") };
    await expect(h.transport.start(h.input)).rejects.toMatchObject({ code: "RESOURCE_MISMATCH" });
    expect(h.ssh).not.toHaveBeenCalled();
    expect(h.clientClose).toHaveBeenCalledTimes(1);
    await expect(
      h.transport.start({
        ...h.input,
        target: { ...target, region: "uk-london-1" },
      }),
    ).rejects.toMatchObject({ code: "CONSOLE_TARGET_MISMATCH" });
    expect(h.clientFactory).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost create response by tags without issuing another create", async () => {
    const h = setup();
    h.state.createError = { code: "ECONNRESET", message: "TOPSECRET authorization header" };
    const tunnel = await h.transport.start(h.input);
    expect(
      h.history.filter((entry) => entry.operation === "createInstanceConsoleConnection"),
    ).toHaveLength(1);
    expect(h.onConnectionCreated).toHaveBeenCalledExactlyOnceWith(connectionId);
    expect(h.open).toHaveBeenCalledTimes(1);
    await tunnel.close();
  });

  it("records the ID even when cancellation arrives with the create response, then cleans its connection", async () => {
    const h = setup();
    h.state.afterCreate = () => h.controller.abort();
    await expect(h.transport.start(h.input)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(h.onConnectionCreated).toHaveBeenCalledExactlyOnceWith(connectionId);
    expect(h.records.size).toBe(0);
    expect(h.open).not.toHaveBeenCalled();
    expect(h.sshClose).toHaveBeenCalledTimes(1);
    expect(h.clientClose).toHaveBeenCalledTimes(h.clientFactory.mock.calls.length);
  });

  it("does not open SSH when persistence fails, and removes the created connection", async () => {
    const h = setup();
    h.onConnectionCreated.mockImplementation(() => {
      throw new Error("TOPSECRET database detail");
    });
    await expect(h.transport.start(h.input)).rejects.toMatchObject({ code: "OCI_ERROR" });
    expect(h.open).not.toHaveBeenCalled();
    expect(h.records.size).toBe(0);
  });

  it("sanitizes SSH failures, cleans only its created connection and closes every SDK scope", async () => {
    const h = setup();
    h.open.mockRejectedValue(new Error("TOPSECRET temporary private key"));
    await expect(h.transport.start(h.input)).rejects.toThrow("OCI 控制台连接失败");
    expect(h.records.size).toBe(0);
    expect(h.sshClose).toHaveBeenCalledTimes(1);
    expect(h.clientClose).toHaveBeenCalledTimes(h.clientFactory.mock.calls.length);
  });

  it.each([
    { freeformTags: { ...consoleTags(target, sessionId), "oci-dash-session": "foreign-session" } },
    { freeformTags: { ...consoleTags(target, sessionId), "oci-dash-account": "foreign-account" } },
    { instanceId: id("instance", "foreign") },
    { compartmentId: id("compartment", "foreign") },
  ])("refuses cleanup when any ownership boundary does not match", async (overrides) => {
    const h = setup();
    h.records.set(connectionId, live(overrides));
    await expect(
      h.transport.cleanup({
        ...h.input,
        connectionId: "compartmentId" in overrides ? null : connectionId,
      }),
    ).rejects.toBeDefined();
    expect(h.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
      false,
    );
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it("recovers tagged orphan IDs, leaving another session's connection untouched", async () => {
    const h = setup();
    const foreignId = id("instanceconsoleconnection", "foreign");
    h.records.set(connectionId, live());
    h.records.set(
      foreignId,
      live({
        id: foreignId,
        freeformTags: { ...consoleTags(target, sessionId), "oci-dash-session": "foreign" },
      }),
    );
    await h.transport.cleanup({ ...h.input, connectionId: null });
    expect([...h.records.keys()]).toEqual([foreignId]);
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it("does not report cleanup complete while OCI still reports DELETING", async () => {
    const h = setup();
    h.state.deletePending = true;
    h.records.set(connectionId, live());
    await expect(h.transport.cleanup({ ...h.input, connectionId })).rejects.toMatchObject({
      code: "CONSOLE_CLEANUP_PENDING",
      retryable: true,
    });
    expect(h.records.get(connectionId)?.lifecycleState).toBe("DELETING");
    expect(h.clientClose).toHaveBeenCalledTimes(1);
  });

  it("refreshes list observations and refuses deletion after the owner changes", async () => {
    const h = setup();
    h.records.set(connectionId, live());
    h.state.transformGet = (value) => ({
      ...value,
      freeformTags: { ...value.freeformTags, "oci-dash-session": "changed" },
    });
    await expect(h.transport.cleanup({ ...h.input, connectionId: null })).rejects.toMatchObject({
      code: "CONSOLE_OWNERSHIP_MISMATCH",
    });
    expect(h.history.some((entry) => entry.operation === "deleteInstanceConsoleConnection")).toBe(
      false,
    );
  });
});

describe("OpenSSH session lifecycle (offline process boundary)", () => {
  const root = join(
    process.env.OCI_DASH_TEST_TMP ?? process.cwd(),
    ".test-tmp",
    "console-transport",
  );
  beforeEach(async () => {
    await mkdir(root, { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function processMock(input: { wrongOuter?: boolean; failedControl?: boolean } = {}) {
    const calls: { command: string; args: string[] }[] = [];
    const masters: { process: ConsoleSshProcess; finish: () => void }[] = [];
    const runner: ConsoleSshRunner = (command, args) => {
      calls.push({ command, args });
      let resolve!: (value: { code: number | null; stdout: string }) => void;
      const exited = new Promise<{ code: number | null; stdout: string }>((done) => {
        resolve = done;
      });
      const stop = vi.fn(async () => {
        resolve({ code: 0, stdout: "" });
      });
      const process = { exited, stop };
      if (command === "ssh-keyscan") {
        const isOuter = args.at(-1) === serviceHost;
        resolve({
          code: 0,
          stdout: isOuter ? (input.wrongOuter ? innerKey.scan : outerKey.scan) : innerKey.scan,
        });
      } else if (args.includes("-O")) resolve({ code: input.failedControl ? 1 : 0, stdout: "" });
      else masters.push({ process, finish: () => resolve({ code: 1, stdout: "" }) });
      return process;
    };
    return { calls, masters, runner };
  }

  it("pins the public service and discovers inner keys only inside its authenticated loopback tunnel", async () => {
    const h = processMock(),
      controller = new AbortController();
    const factory = createOpenSshFactory({ runner: h.runner, tempRoot: root });
    const session = await factory({ sessionId, signal: controller.signal });
    const [directoryName] = await readdir(root);
    const directory = join(root, directoryName);
    expect(await readFile(join(directory, "identity"), "utf8")).toContain("BEGIN RSA PRIVATE KEY");
    expect(session.publicKey).toMatch(/^ssh-rsa [A-Za-z0-9+/]+=* oci-dash-console$/);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "identity"))).mode & 0o777).toBe(0o600);
    }
    const tunnel = await session.open({
      endpoint: endpoint(),
      serviceHostKeyFingerprint: outerKey.fingerprint,
      signal: controller.signal,
    });
    expect(h.calls.map((entry) => entry.command)).toEqual([
      "ssh-keyscan",
      "ssh",
      "ssh",
      "ssh",
      "ssh",
    ]);
    expect(h.calls[0].args).toContain("rsa,ecdsa,ed25519");
    expect(h.calls[2].args).toContain("check");
    expect(h.calls[3].args.at(-1)).toBe("127.0.0.1");
    const known = await readFile(join(directory, "known_hosts"), "utf8");
    expect(known).toContain("oci-console-service ssh-rsa " + outerKey.encoded);
    for (const call of h.calls.filter((entry) => entry.command === "ssh")) {
      const inner = call.args.at(-1) === "127.0.0.1";
      expect(call.args).toContain("StrictHostKeyChecking=" + (inner ? "accept-new" : "yes"));
      expect(call.args).toContain("UserKnownHostsFile=" + join(directory, "known_hosts"));
      expect(call.args).toContain("IdentityAgent=none");
      expect(call.args).toContain("ExitOnForwardFailure=yes");
      expect(call.args).toContain("BatchMode=yes");
      expect(call.args.join(" ")).not.toContain("ProxyCommand");
      if (call.args.includes("-L"))
        expect(call.args[call.args.indexOf("-L") + 1]).toMatch(/^127\.0\.0\.1:\d+:/);
    }
    expect(h.calls.filter((call) => call.command === "ssh-keyscan")).toHaveLength(1);
    expect(
      h.calls.filter((call) => call.args.includes("-M") && call.args.at(-1) === "127.0.0.1"),
    ).toHaveLength(1);
    if (process.platform !== "win32")
      expect((await stat(join(directory, "known_hosts"))).mode & 0o777).toBe(0o600);
    await tunnel.close();
    await tunnel.closed;
    expect(h.masters.every((master) => master.process.stop)).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("a mismatched API fingerprint starts no SSH and removes temporary private material", async () => {
    const h = processMock({ wrongOuter: true }),
      controller = new AbortController();
    const session = await createOpenSshFactory({ runner: h.runner, tempRoot: root })({
      sessionId,
      signal: controller.signal,
    });
    await expect(
      session.open({
        endpoint: endpoint(),
        serviceHostKeyFingerprint: outerKey.fingerprint,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CONSOLE_HOST_KEY_MISMATCH" });
    expect(h.calls.some((entry) => entry.command === "ssh")).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });

  it("abort and unexpected master exit both stop peer processes and clean session files", async () => {
    for (const cause of ["abort", "exit"]) {
      const h = processMock(),
        controller = new AbortController();
      const session = await createOpenSshFactory({ runner: h.runner, tempRoot: root })({
        sessionId,
        signal: controller.signal,
      });
      const tunnel = await session.open({
        endpoint: endpoint(),
        serviceHostKeyFingerprint: outerKey.fingerprint,
        signal: controller.signal,
      });
      if (cause === "abort") controller.abort();
      else h.masters[0].finish();
      await tunnel.closed;
      expect(vi.mocked(h.masters[1].process.stop)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(h.masters[0].process.stop)).toHaveBeenCalledTimes(cause === "abort" ? 1 : 0);
      expect(await readdir(root)).toEqual([]);
    }
  });

  it("preserves the RFB banner for noVNC and refuses a second socket", async () => {
    const h = processMock(),
      controller = new AbortController();
    const session = await createOpenSshFactory({ runner: h.runner, tempRoot: root })({
      sessionId,
      signal: controller.signal,
    });
    const tunnel = await session.open({
      endpoint: endpoint(),
      serviceHostKeyFingerprint: outerKey.fingerprint,
      signal: controller.signal,
    });
    const forwards = h.calls.filter((call) => call.command === "ssh" && call.args.includes("-L"));
    const forward = forwards[1].args[forwards[1].args.indexOf("-L") + 1];
    const port = Number(forward.split(":")[1]);
    const peers = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      peers.add(socket);
      socket.once("close", () => peers.delete(socket));
      socket.write("RFB 003.008\n");
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    try {
      const stream = await tunnel.connect();
      expect((stream.read(12) as Buffer).toString()).toBe("RFB 003.008\n");
      await expect(tunnel.connect()).rejects.toMatchObject({ code: "CONSOLE_CHANNEL_UNAVAILABLE" });
    } finally {
      await tunnel.close();
      peers.forEach((peer) => peer.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("stops the outer master and removes keys when authentication readiness times out", async () => {
    const h = processMock({ failedControl: true }),
      controller = new AbortController();
    const session = await createOpenSshFactory({
      runner: h.runner,
      tempRoot: root,
      startupTimeoutMs: 10,
      pollIntervalMs: 1,
    })({ sessionId, signal: controller.signal });
    await expect(
      session.open({
        endpoint: endpoint(),
        serviceHostKeyFingerprint: outerKey.fingerprint,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CONSOLE_OUTER_AUTH_TIMEOUT" });
    expect(h.masters).toHaveLength(1);
    expect(h.masters[0].process.stop).toHaveBeenCalledTimes(1);
    expect(h.calls.filter((call) => call.command === "ssh-keyscan")).toHaveLength(1);
    expect(await readdir(root)).toEqual([]);
  });
});
