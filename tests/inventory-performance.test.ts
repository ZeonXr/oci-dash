import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountSummary } from "@/lib/contracts";
import { createOciAdapter } from "@/server/oci/adapter";
import type { CloudDocument, OciClientFactory, OciClients } from "@/server/oci/sdk";
import type { ExecutionContext, OciCredentials } from "@/server/oci/types";

afterEach(() => vi.useRealTimers());
const id = (kind: string, suffix: string) => `ocid1.${kind}.oc1..${suffix}`;
const suffix = (value: string) => value.split("..")[1];
const credentials: OciCredentials = {
  tenancyId: id("tenancy", "performance"),
  userId: id("user", "performance"),
  fingerprint: "synthetic-fingerprint",
  privateKey: "synthetic-key-not-used-for-signing",
  region: "ap-tokyo-1",
};
function account(access: OciCredentials): AccountSummary {
  return {
    id: "test-account",
    name: "Inventory performance",
    tenancyId: access.tenancyId,
    userId: access.userId,
    fingerprint: access.fingerprint,
    homeRegion: access.region,
    regions: [access.region],
    status: "connected",
    lastSyncAt: null,
    lastError: null,
    createdAt: "2026-11-08T00:00:00.000Z",
  };
}
function context(signal: AbortSignal): ExecutionContext {
  return {
    jobId: "synthetic-performance-job",
    signal,
    checkpoints: {},
    progress: async () => {},
    checkpoint: async () => {},
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
interface Call {
  operation: string;
  request: CloudDocument;
  region: string;
  client: number;
}
function harness() {
  const calls: Call[] = [];
  const state = {
    instances: 4,
    privateIps: 1,
    now: 1_000_000,
    delay: 0,
    os: "Ubuntu",
    version: "24.04",
    publicIp: "192.0.2.1",
    vpus: 10,
    wrongImageId: false,
    imageFor: (_index: number) => id("image", "shared"),
    failures: new Set<string>(),
    before: undefined as ((call: Call) => Promise<void>) | undefined,
    active: 0,
    peak: 0,
    clients: 0,
    peakClients: 0,
    opened: 0,
    closed: 0,
    closedWhileActive: false,
    calledAfterClose: false,
  };
  const factory: OciClientFactory = (access, region) => {
    const clientId = ++state.opened;
    state.clients++;
    state.peakClients = Math.max(state.peakClients, state.clients);
    let localActive = 0;
    let closed = false;
    const client = {
      async call(operation: string, request: CloudDocument): Promise<CloudDocument> {
        if (closed) state.calledAfterClose = true;
        localActive++;
        state.active++;
        state.peak = Math.max(state.peak, state.active);
        const call = { operation, request, region, client: clientId };
        calls.push(call);
        try {
          if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
          await state.before?.(call);
          if (state.failures.has(operation))
            throw { statusCode: 403, serviceCode: "NotAuthorizedOrNotFound" };
          if (operation === "listCompartments") return { items: [] };
          if (operation === "listInstances")
            return {
              items: Array.from({ length: state.instances }, (_, index) => ({
                id: id("instance", `${region}-${index}`),
                displayName: `Instance ${index}`,
                compartmentId: access.tenancyId,
                lifecycleState: "RUNNING",
                availabilityDomain: "TEST:AD-1",
                shape: "test-shape",
                shapeConfig: { ocpus: 1, memoryInGBs: 1 },
                timeCreated: new Date(0),
                imageId: state.imageFor(index),
              })),
            };
          if (operation === "listVnicAttachments")
            return {
              items: [
                {
                  instanceId: request.instanceId,
                  vnicId: id("vnic", suffix(request.instanceId)),
                  lifecycleState: "ATTACHED",
                },
              ],
            };
          if (operation === "getVnic")
            return {
              vnic: {
                id: request.vnicId,
                displayName: "NIC",
                isPrimary: true,
                subnetId: id("subnet", region),
                nsgIds: [],
              },
            };
          if (operation === "listPrivateIps")
            return {
              items: Array.from({ length: state.privateIps }, (_, index) => ({
                id: id("privateip", suffix(request.vnicId) + (index ? "-ip" + index : "")),
                vnicId: request.vnicId,
                ipAddress: "10.0.0." + (index + 1),
                isPrimary: index === 0,
              })),
            };
          if (operation === "getPublicIpByPrivateIpId") {
            const privateIpId = request.getPublicIpByPrivateIpIdDetails.privateIpId;
            return {
              publicIp: {
                id: id("publicip", suffix(privateIpId)),
                privateIpId,
                ipAddress: state.publicIp,
                lifetime: "EPHEMERAL",
              },
            };
          }
          if (operation === "listIpv6s") return { items: [] };
          if (operation === "listBootVolumeAttachments")
            return {
              items: [
                {
                  id: "boot-attachment",
                  bootVolumeId: id("bootvolume", suffix(request.instanceId)),
                  lifecycleState: "ATTACHED",
                },
              ],
            };
          if (operation === "getBootVolume")
            return {
              bootVolume: {
                id: request.bootVolumeId,
                displayName: "Boot",
                lifecycleState: "AVAILABLE",
                sizeInGBs: 50,
                vpusPerGB: state.vpus,
              },
            };
          if (operation === "getImage")
            return {
              image: {
                id: state.wrongImageId ? id("image", "wrong") : request.imageId,
                operatingSystem: state.os,
                operatingSystemVersion: state.version,
              },
            };
          throw Error("Unexpected mock operation " + operation);
        } finally {
          localActive--;
          state.active--;
        }
      },
      close() {
        if (closed) throw Error("Client closed twice");
        closed = true;
        state.closedWhileActive ||= localActive > 0;
        state.clients--;
        state.closed++;
      },
    };
    return Object.fromEntries(
      ["identity", "compute", "network", "storage", "monitoring"].map((service) => [
        service,
        client,
      ]),
    ) as unknown as OciClients;
  };
  const adapter = createOciAdapter({ clientFactory: factory, now: () => state.now });
  return {
    state,
    calls,
    adapter,
    count: (operation: string) => calls.filter((call) => call.operation === operation).length,
    run: (access = credentials, regions = [access.region], signal?: AbortSignal) =>
      adapter.inventory(access, account(access), regions, signal ? context(signal) : undefined),
  };
}

describe("bounded inventory concurrency", () => {
  it("shares four actual RPC slots and two region client lifecycles across concurrent accounts", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.delay = 10;
    const requests = Array.from({ length: 3 }, (_, index) =>
      h.run(
        {
          ...credentials,
          tenancyId: id("tenancy", "account" + index),
          userId: id("user", "account" + index),
        },
        ["ap-tokyo-1", "uk-london-1", "us-phoenix-1"],
      ),
    );
    await vi.runAllTimersAsync();
    const results = await Promise.all(requests);
    expect(h.state.peak).toBe(4);
    expect(h.state.peakClients).toBe(2);
    expect(h.state.closed).toBe(9);
    expect(h.state.closedWhileActive).toBe(false);
    expect(h.state.calledAfterClose).toBe(false);
    for (const result of results)
      expect(result.instances.map((row) => row.id)).toEqual(
        ["ap-tokyo-1", "uk-london-1", "us-phoenix-1"].flatMap((region) =>
          Array.from({ length: 4 }, (_, index) => id("instance", `${region}-${index}`)),
        ),
      );
  });

  it("starts at most two instances per region while independent details overlap", async () => {
    const h = harness();
    h.state.instances = 8;
    const gate = deferred();
    h.state.before = async (call) => {
      if (["listVnicAttachments", "listBootVolumeAttachments", "getImage"].includes(call.operation))
        await gate.promise;
    };
    const pending = h.run();
    try {
      await vi.waitFor(() => expect(h.state.active).toBe(4));
      expect(h.count("listVnicAttachments")).toBeLessThanOrEqual(2);
      expect(h.count("listBootVolumeAttachments")).toBeLessThanOrEqual(2);
      expect(
        new Set(
          h.calls.filter((call) => call.request.instanceId).map((call) => call.request.instanceId),
        ).size,
      ).toBe(2);
    } finally {
      gate.resolve();
    }
    const result = await pending;
    expect(result.instances).toHaveLength(8);
    expect(h.state.peak).toBe(4);
  });

  it("reduces mock latency and coalesces one shared image without changing fresh reads", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.state.delay = 20;
    const started = Date.now();
    let elapsed = 0;
    const pending = h.run().then((result) => {
      elapsed = Date.now() - started;
      return result;
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.instances).toHaveLength(4);
    expect(h.calls).toHaveLength(31);
    expect(h.count("getImage")).toBe(1);
    expect(elapsed).toBeLessThan(h.calls.length * h.state.delay * 0.75);
    expect(h.count("getBootVolume")).toBe(4);
    expect(h.count("getPublicIpByPrivateIpId")).toBe(4);
  });

  it("stops queued work on abort and drains actual RPCs before close or slot reuse", async () => {
    const h = harness();
    const gate = deferred();
    h.state.before = async (call) => {
      if (["listVnicAttachments", "listBootVolumeAttachments", "getImage"].includes(call.operation))
        await gate.promise;
    };
    const controller = new AbortController();
    let finished = false;
    const pending = h
      .run(credentials, ["ap-tokyo-1", "uk-london-1", "us-phoenix-1"], controller.signal)
      .then(
        () => {
          finished = true;
          return "unexpected-success";
        },
        (error) => {
          finished = true;
          return error.code;
        },
      );
    await vi.waitFor(() => expect(h.state.active).toBe(4));
    controller.abort();
    const callsAtAbort = h.calls.length;
    const openedAtAbort = h.state.opened;
    const later = h.run({ ...credentials, tenancyId: id("tenancy", "later") });
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(h.calls).toHaveLength(callsAtAbort);
      // A region with only queued work may close immediately and lend its client slot.
      // The four already dispatched RPCs still own all RPC slots until the gate settles.
      expect(h.state.opened).toBeLessThanOrEqual(openedAtAbort + 1);
      expect(h.state.clients).toBeLessThanOrEqual(2);
      expect(h.state.closedWhileActive).toBe(false);
      expect(finished).toBe(false);
      expect(h.state.active).toBe(4);
    } finally {
      gate.resolve();
    }
    expect(await pending).toBe("CANCELLED");
    await later;
    expect(h.state.opened).toBe(3);
    expect(h.state.closed).toBe(3);
    expect(h.state.closedWhileActive).toBe(false);
    expect(h.state.peak).toBe(4);
    expect(h.calls.some((call) => call.region === "us-phoenix-1")).toBe(false);
  });

  it("does not create clients for an already aborted inventory request", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.run(credentials, [credentials.region], controller.signal)).rejects.toMatchObject(
      { code: "CANCELLED" },
    );
    expect(h.state.opened).toBe(0);
    expect(h.calls).toEqual([]);
  });

  it("reads IPv6 beside the IPv4 chain and limits each VNIC to two public-binding reads", async () => {
    const h = harness();
    h.state.instances = 1;
    h.state.privateIps = 5;
    const gate = deferred();
    h.state.before = async (call) => {
      if (call.operation === "getPublicIpByPrivateIpId") await gate.promise;
    };
    const pending = h.run();
    try {
      await vi.waitFor(() => expect(h.count("getPublicIpByPrivateIpId")).toBe(2));
      expect(h.count("listIpv6s")).toBe(1);
      expect(h.state.active).toBe(2);
      expect(h.state.peak).toBeLessThanOrEqual(4);
    } finally {
      gate.resolve();
    }
    const result = await pending;
    const ips = result.instances[0].vnics[0].privateIps;
    expect(ips.map((ip) => ip.privateIp)).toEqual([
      "10.0.0.1",
      "10.0.0.2",
      "10.0.0.3",
      "10.0.0.4",
      "10.0.0.5",
    ]);
    expect(h.count("getPublicIpByPrivateIpId")).toBe(5);
    expect(
      result.details?.[result.instances[0].id].vnicDetails[result.instances[0].vnics[0].id]
        .publicBindings,
    ).toEqual(ips.map((ip) => ip.privateIpId));
  });

  it("keeps nested partial coverage and warning order when IPv6 finishes before public bindings", async () => {
    const h = harness();
    h.state.instances = 1;
    h.state.privateIps = 3;
    const gate = deferred();
    h.state.before = async (call) => {
      if (call.operation === "listIpv6s") throw { statusCode: 403 };
      if (call.operation === "getPublicIpByPrivateIpId") {
        const privateId = call.request.getPublicIpByPrivateIpIdDetails.privateIpId as string;
        if (privateId.endsWith("-ip1")) throw { statusCode: 500 };
        if (!privateId.endsWith("-ip2")) await gate.promise;
      }
    };
    const pending = h.run();
    try {
      await vi.waitFor(() => expect(h.count("getPublicIpByPrivateIpId")).toBe(3));
    } finally {
      gate.resolve();
    }
    const result = await pending;
    const row = result.instances[0],
      vnic = row.vnics[0];
    expect(vnic.privateIps.map((ip) => ip.privateIp)).toEqual(["10.0.0.1", "10.0.0.2", "10.0.0.3"]);
    expect(vnic.privateIps[1]).not.toHaveProperty("publicIp");
    expect(result.details?.[row.id].vnicDetails[vnic.id]).toEqual({
      privateIps: true,
      ipv6: false,
      publicBindings: [vnic.privateIps[0].privateIpId, vnic.privateIps[2].privateIpId],
    });
    expect(result.warnings.map((message) => message.split("：")[0])).toEqual([
      credentials.region + " / Instance 0 公网 IP",
      credentials.region + " / Instance 0 IPv6",
    ]);
  });

  it("does not dispatch remaining public bindings after cancellation or close before active ones settle", async () => {
    const h = harness();
    h.state.instances = 1;
    h.state.privateIps = 5;
    const gate = deferred();
    h.state.before = async (call) => {
      if (call.operation === "getPublicIpByPrivateIpId") await gate.promise;
    };
    const controller = new AbortController();
    const pending = h
      .run(credentials, [credentials.region], controller.signal)
      .catch((error) => error.code);
    await vi.waitFor(() => expect(h.count("getPublicIpByPrivateIpId")).toBe(2));
    controller.abort();
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(h.state.closed).toBe(0);
      expect(h.state.active).toBe(2);
    } finally {
      gate.resolve();
    }
    expect(await pending).toBe("CANCELLED");
    expect(h.count("getPublicIpByPrivateIpId")).toBe(2);
    expect(h.state.closedWhileActive).toBe(false);
    expect(h.state.closed).toBe(1);
  });

  it("retains partial coverage and deterministic instance/detail warning order", async () => {
    const h = harness();
    h.state.failures = new Set(["listPrivateIps", "getBootVolume", "getImage"]);
    const result = await h.run();
    expect(result.completedScopes).toEqual([
      { region: credentials.region, compartmentId: credentials.tenancyId },
    ]);
    expect(result.warnings.map((message) => message.split("：")[0])).toEqual(
      Array.from({ length: 4 }, (_, index) =>
        ["私网 IP", "启动卷", "系统镜像"].map(
          (field) => `${credentials.region} / Instance ${index} ${field}`,
        ),
      ).flat(),
    );
    for (const row of result.instances) {
      expect(result.details?.[row.id]).toMatchObject({
        vnics: true,
        bootVolumes: false,
        os: false,
      });
      expect(result.details?.[row.id].vnicDetails[row.vnics[0].id]).toEqual({
        privateIps: false,
        ipv6: true,
        publicBindings: [],
      });
    }
    expect(h.state.closedWhileActive).toBe(false);
  });
});

describe("isolated and bounded inventory image metadata cache", () => {
  it("expires after one hour while every public-IP and disk read stays fresh", async () => {
    const h = harness();
    h.state.instances = 1;
    expect((await h.run()).instances[0].os).toBe("Ubuntu 24.04");
    h.state.os = "Debian";
    h.state.version = "13";
    h.state.publicIp = "192.0.2.9";
    h.state.vpus = 100;
    const cached = await h.run();
    expect(cached.instances[0].os).toBe("Ubuntu 24.04");
    expect(cached.instances[0].bootVolumes[0].vpusPerGb).toBe(100);
    expect(cached.instances[0].vnics[0].privateIps[0].publicIp).toBe("192.0.2.9");
    expect(h.count("getImage")).toBe(1);
    h.state.now += 3_600_001;
    expect((await h.run()).instances[0].os).toBe("Debian 13");
    expect(h.count("getImage")).toBe(2);
    expect(h.count("getBootVolume")).toBe(3);
    expect(h.count("getPublicIpByPrivateIpId")).toBe(3);
  });

  it("isolates cached images by tenancy, user, fingerprint, private-key digest and region", async () => {
    const h = harness();
    h.state.instances = 1;
    await h.run();
    for (const change of [
      { tenancyId: id("tenancy", "other") },
      { userId: id("user", "other") },
      { fingerprint: "other-synthetic-fingerprint" },
      { privateKey: "other-synthetic-test-key" },
      { region: "uk-london-1" },
    ])
      await h.run({ ...credentials, ...change });
    expect(h.count("getImage")).toBe(6);
    await h.run();
    expect(h.count("getImage")).toBe(6);
  });

  it("does not cache failed or mismatched image responses", async () => {
    const h = harness();
    h.state.instances = 1;
    h.state.failures.add("getImage");
    expect((await h.run()).details?.[id("instance", credentials.region + "-0")].os).toBe(false);
    h.state.failures.clear();
    h.state.wrongImageId = true;
    expect((await h.run()).warnings).toHaveLength(1);
    h.state.wrongImageId = false;
    expect((await h.run()).instances[0].os).toBe("Ubuntu 24.04");
    expect(h.count("getImage")).toBe(3);
    await h.run();
    expect(h.count("getImage")).toBe(3);
  });

  it("does not publish an image result completed after its caller was cancelled", async () => {
    const h = harness();
    h.state.instances = 1;
    const gate = deferred();
    h.state.before = async (call) => {
      if (call.operation === "getImage") await gate.promise;
    };
    const controller = new AbortController();
    const pending = h
      .run(credentials, [credentials.region], controller.signal)
      .catch((error) => error.code);
    await vi.waitFor(() => expect(h.count("getImage")).toBe(1));
    controller.abort();
    gate.resolve();
    expect(await pending).toBe("CANCELLED");
    h.state.before = undefined;
    await h.run();
    expect(h.count("getImage")).toBe(2);
  });

  it("evicts old image metadata when the 256-entry bound is reached", async () => {
    const h = harness();
    h.state.instances = 1;
    for (let index = 0; index < 257; index++) {
      h.state.imageFor = () => id("image", "image" + index);
      await h.run();
    }
    expect(h.count("getImage")).toBe(257);
    h.state.imageFor = () => id("image", "image0");
    await h.run();
    expect(h.count("getImage")).toBe(258);
    expect(h.state.clients).toBe(0);
  });
});
