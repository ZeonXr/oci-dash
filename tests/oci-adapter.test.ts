import { describe, expect, it, vi } from "vitest";
import { createOciAdapter } from "@/server/oci/adapter";
import { allPages, cloudError, type CloudDocument, type OciClients } from "@/server/oci/sdk";
import { CloudError, type ExecutionContext, type OciCredentials } from "@/server/oci/types";
import type { AccountSummary, InstanceSummary, OperationRequest } from "@/lib/contracts";

const id = (kind: string, suffix = "a") => `ocid1.${kind}.oc1..${suffix}`;
const ids = {
  tenancy: id("tenancy"),
  instance: id("instance"),
  vnic: id("vnic"),
  primary: id("privateip", "primary"),
  fixed: id("privateip", "fixed"),
  oldPublic: id("publicip", "old"),
  fixedPublic: id("publicip", "fixed"),
  newPublic: id("publicip", "new"),
  subnet: id("subnet"),
  nsg: id("networksecuritygroup"),
  securityList: id("securitylist"),
  boot: id("bootvolume"),
  image: id("image"),
};
const credentials: OciCredentials = {
  tenancyId: ids.tenancy,
  userId: id("user"),
  fingerprint: "test-fingerprint",
  privateKey: "TEST-ONLY-NOT-A-KEY",
  region: "ap-test-1",
};
const account: AccountSummary = {
  id: "account-a",
  name: "测试账号",
  tenancyId: ids.tenancy,
  userId: id("user"),
  fingerprint: "test-fingerprint",
  homeRegion: "ap-test-1",
  regions: ["ap-test-1"],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
function jobContext(
  saved: Record<string, unknown> = {},
  jobId = "11111111-1111-4111-8111-111111111111",
): ExecutionContext & { saved: Record<string, unknown> } {
  const context = {
    jobId,
    signal: new AbortController().signal,
    checkpoints: structuredClone(saved),
    saved,
    progress: vi.fn(async () => {}),
    checkpoint: vi.fn(async (key: string, value: unknown) => {
      saved[key] = structuredClone(value);
    }),
  };
  return context;
}
function operation(kind: OperationRequest["kind"], payload: CloudDocument = {}): OperationRequest {
  return {
    kind,
    accountId: account.id,
    region: credentials.region,
    resourceId: ids.instance,
    payload,
  };
}
const rotate = (patch: CloudDocument = {}) =>
  operation("public-ip-rotate", {
    vnicId: ids.vnic,
    privateIpId: ids.primary,
    expectedPublicIpId: ids.oldPublic,
    ...patch,
  });
function fixture() {
  const instance: CloudDocument = {
    id: ids.instance,
    compartmentId: ids.tenancy,
    displayName: "test-server",
    lifecycleState: "RUNNING",
    availabilityDomain: "TEST:AD-1",
    shape: "VM.Standard.E2.1.Micro",
    shapeConfig: { ocpus: 1, memoryInGBs: 1 },
    imageId: ids.image,
    timeCreated: new Date("2026-01-01T00:00:00Z"),
    freeformTags: {
      owner: "test",
      root_password: "MUST-NOT-BE-RETURNED",
      "private-key": "MUST-NOT-BE-RETURNED",
      API_KEY: "MUST-NOT-BE-RETURNED",
      appSecret: "MUST-NOT-BE-RETURNED",
      accessToken: "MUST-NOT-BE-RETURNED",
      credential: "MUST-NOT-BE-RETURNED",
    },
  };
  const vnic: CloudDocument = {
    id: ids.vnic,
    compartmentId: ids.tenancy,
    displayName: "vnic",
    isPrimary: true,
    subnetId: ids.subnet,
    nsgIds: [ids.nsg],
  };
  const bindings = new Map<string, CloudDocument>([
    [
      ids.primary,
      {
        id: ids.oldPublic,
        privateIpId: ids.primary,
        ipAddress: "192.0.2.1",
        lifetime: "EPHEMERAL",
        compartmentId: ids.tenancy,
      },
    ],
    [
      ids.fixed,
      {
        id: ids.fixedPublic,
        privateIpId: ids.fixed,
        ipAddress: "192.0.2.2",
        lifetime: "RESERVED",
        compartmentId: ids.tenancy,
      },
    ],
  ]);
  const privateIps = [
    { id: ids.fixed, vnicId: ids.vnic, ipAddress: "10.0.0.2", isPrimary: false },
    { id: ids.primary, vnicId: ids.vnic, ipAddress: "10.0.0.1", isPrimary: true },
  ];
  const boot: CloudDocument = {
    id: ids.boot,
    compartmentId: ids.tenancy,
    displayName: "boot",
    lifecycleState: "AVAILABLE",
    sizeInGBs: 50,
    vpusPerGB: 10,
  };
  let securityList: CloudDocument = {
    id: ids.securityList,
    displayName: "list",
    ingressSecurityRules: [
      {
        source: "10.0.0.0/8",
        sourceType: "CIDR_BLOCK",
        protocol: "6",
        isStateless: false,
        description: "keep",
        tcpOptions: {
          sourcePortRange: { min: 3000, max: 4000 },
          destinationPortRange: { min: 22, max: 22 },
        },
      },
    ],
    egressSecurityRules: [
      {
        destination: "0.0.0.0/0",
        destinationType: "CIDR_BLOCK",
        protocol: "all",
        isStateless: false,
      },
    ],
  };
  const nsgRules: CloudDocument[] = [];
  const ipv6s: CloudDocument[] = [];
  let instanceEtag = "instance-e1",
    listEtag = "list-e1";
  const handlers: Record<
    string,
    (request: CloudDocument) => CloudDocument | Promise<CloudDocument>
  > = {
    getTenancy: () => ({ tenancy: { id: ids.tenancy, name: "test-tenancy" } }),
    listRegionSubscriptions: () => ({
      items: [{ regionName: credentials.region, status: "READY", isHomeRegion: true }],
    }),
    listCompartments: () => ({ items: [] }),
    listInstances: () => ({ items: [instance] }),
    getInstance: () => ({ instance: structuredClone(instance), etag: instanceEtag }),
    listVnicAttachments: (request) => ({
      items: [
        {
          id: "attachment",
          instanceId: request.instanceId,
          vnicId: ids.vnic,
          lifecycleState: "ATTACHED",
        },
      ],
    }),
    getVnic: () => ({ vnic }),
    listPrivateIps: () => ({ items: privateIps }),
    getPrivateIp: (request) => ({
      privateIp: privateIps.find((p) => p.id === request.privateIpId),
    }),
    getPublicIpByPrivateIpId: (request) => {
      const publicIp = bindings.get(request.getPublicIpByPrivateIpIdDetails.privateIpId);
      if (!publicIp) throw { statusCode: 404, serviceCode: "NotAuthorizedOrNotFound" };
      return { publicIp: structuredClone(publicIp), etag: "public-e1" };
    },
    getPublicIp: (request) => {
      const publicIp = [...bindings.values()].find((p) => p.id === request.publicIpId);
      if (!publicIp) throw { statusCode: 404 };
      return { publicIp: structuredClone(publicIp), etag: "public-e1" };
    },
    deletePublicIp: (request) => {
      for (const [privateId, ip] of bindings)
        if (ip.id === request.publicIpId) bindings.delete(privateId);
      return {};
    },
    createPublicIp: (request) => {
      const publicIp = {
        id: ids.newPublic,
        ipAddress: "192.0.2.3",
        ...request.createPublicIpDetails,
      };
      bindings.set(publicIp.privateIpId, publicIp);
      return { publicIp };
    },
    listIpv6s: () => ({ items: ipv6s }),
    listBootVolumeAttachments: () => ({
      items: [{ id: "boot-attachment", bootVolumeId: ids.boot, lifecycleState: "ATTACHED" }],
    }),
    getBootVolume: () => ({ bootVolume: structuredClone(boot), etag: "boot-e1" }),
    updateBootVolume: (request) => {
      Object.assign(boot, request.updateBootVolumeDetails);
      return { bootVolume: boot };
    },
    getImage: () => ({
      image: {
        id: ids.image,
        operatingSystem: "Ubuntu",
        operatingSystemVersion: "24.04",
        lifecycleState: "AVAILABLE",
      },
    }),
    getSubnet: () => ({
      subnet: {
        id: ids.subnet,
        compartmentId: ids.tenancy,
        securityListIds: [ids.securityList],
        lifecycleState: "AVAILABLE",
        ipv6CidrBlocks: ["2001:db8::/64"],
      },
    }),
    getNetworkSecurityGroup: () => ({
      networkSecurityGroup: { id: ids.nsg, displayName: "nsg" },
      etag: "nsg-e1",
    }),
    listNetworkSecurityGroupSecurityRules: () => ({ items: structuredClone(nsgRules) }),
    addNetworkSecurityGroupSecurityRules: (request) => {
      nsgRules.push(
        ...request.addNetworkSecurityGroupSecurityRulesDetails.securityRules.map(
          (r: CloudDocument) => ({ ...r, id: "rule-1", isValid: true }),
        ),
      );
      return {};
    },
    removeNetworkSecurityGroupSecurityRules: (request) => {
      const removeIds = request.removeNetworkSecurityGroupSecurityRulesDetails.securityRuleIds;
      const keep = nsgRules.filter((r) => !removeIds.includes(r.id));
      nsgRules.splice(0, nsgRules.length, ...keep);
      return {};
    },
    getSecurityList: () => ({ securityList: structuredClone(securityList), etag: listEtag }),
    updateSecurityList: (request) => {
      securityList = { ...securityList, ...structuredClone(request.updateSecurityListDetails) };
      listEtag = "list-e2";
      return { securityList };
    },
    listAvailabilityDomains: () => ({ items: [{ name: "TEST:AD-1" }] }),
    listShapes: () => ({
      items: [{ shape: "VM.Standard.E2.1.Micro", ocpus: 1, memoryInGBs: 1, isFlexible: false }],
    }),
    listImages: () => ({
      items: [{ id: ids.image, displayName: "Ubuntu", lifecycleState: "AVAILABLE" }],
    }),
    listSubnets: () => ({
      items: [{ id: ids.subnet, displayName: "test-subnet", cidrBlock: "10.0.0.0/24" }],
    }),
    instanceAction: (request) => {
      instance.lifecycleState = request.action === "SOFTSTOP" ? "STOPPED" : "RUNNING";
      instanceEtag = "instance-e2";
      return { instance };
    },
    updateInstance: (request) => {
      Object.assign(instance, request.updateInstanceDetails);
      instanceEtag = "instance-e2";
      return { instance };
    },
    terminateInstance: () => {
      instance.lifecycleState = "TERMINATED";
      return {};
    },
    launchInstance: (request) => {
      Object.assign(instance, request.launchInstanceDetails, { lifecycleState: "RUNNING" });
      return { instance };
    },
    createIpv6: (request) => {
      const ipv6 = { id: id("ipv6"), ipAddress: "2001:db8::1", ...request.createIpv6Details };
      ipv6s.push(ipv6);
      return { ipv6 };
    },
    summarizeMetricsData: () => ({ items: [] }),
  };
  const calls: { service: string; operation: string; request: CloudDocument }[] = [];
  const clients = Object.fromEntries(
    ["identity", "compute", "network", "storage", "monitoring"].map((service) => [
      service,
      {
        call: vi.fn(async (name: string, request: CloudDocument) => {
          calls.push({ service, operation: name, request: structuredClone(request) });
          if (!handlers[name]) throw Error(`Unimplemented fake: ${name}`);
          return handlers[name](request);
        }),
        close: vi.fn(),
      },
    ]),
  ) as unknown as OciClients;
  const factory = vi.fn((_credentials: OciCredentials, _region: string) => clients);
  const adapter = createOciAdapter({
    clientFactory: factory,
    pollIntervalMs: 0,
    pollAttempts: 2,
    now: () => Date.parse("2026-11-07T00:00:00Z"),
  });
  const writes = () =>
    calls.filter((c) =>
      /^(create|delete|update|launch|terminate|instanceAction|addNetwork|removeNetwork)/.test(
        c.operation,
      ),
    );
  return {
    instance,
    vnic,
    boot,
    bindings,
    privateIps,
    handlers,
    calls,
    clients,
    factory,
    adapter,
    writes,
    nsgRules,
    ipv6s,
  };
}

describe("OCI public IP protection and recovery", () => {
  it("targets the explicit private IP even when the fixed secondary address is listed first", async () => {
    const f = fixture();
    const done = await f.adapter.execute(credentials, rotate(), jobContext());
    expect(done.details?.publicIp).toBe("192.0.2.3");
    expect(f.bindings.get(ids.fixed)?.id).toBe(ids.fixedPublic);
    expect(f.writes().map((w) => w.operation)).toEqual(["deletePublicIp", "createPublicIp"]);
    expect(f.writes()[0].request).toMatchObject({
      publicIpId: ids.oldPublic,
      ifMatch: "public-e1",
    });
    expect(f.writes()[1].request.createPublicIpDetails.privateIpId).toBe(ids.primary);
    expect(f.calls.some((c) => c.operation === "listPublicIps")).toBe(false);
  });
  it("refuses reserved IP rotation even if the client claims protected=false", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        rotate({ privateIpId: ids.fixed, expectedPublicIpId: ids.fixedPublic, protected: false }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "PROTECTED_PUBLIC_IP" });
    expect(f.writes()).toEqual([]);
  });
  it("refuses a private IP from another VNIC", async () => {
    const f = fixture();
    f.privateIps[1].vnicId = id("vnic", "other");
    await expect(f.adapter.execute(credentials, rotate(), jobContext())).rejects.toMatchObject({
      code: "RESOURCE_MISMATCH",
    });
    expect(f.writes()).toEqual([]);
  });
  it("refuses a stale old-IP selection", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        rotate({ expectedPublicIpId: id("publicip", "stale") }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CHANGED" });
    expect(f.writes()).toEqual([]);
  });
  it("recovers a delete whose successful response was lost without touching the fixed IP", async () => {
    const f = fixture();
    const remove = f.handlers.deletePublicIp;
    f.handlers.deletePublicIp = (request) => {
      remove(request);
      throw { code: "ECONNRESET" };
    };
    const saved = {};
    const first = jobContext(saved);
    await expect(f.adapter.execute(credentials, rotate(), first)).rejects.toMatchObject({
      retryable: true,
    });
    expect(f.bindings.has(ids.primary)).toBe(false);
    await f.adapter.execute(credentials, rotate(), jobContext(saved));
    expect(f.calls.filter((c) => c.operation === "deletePublicIp")).toHaveLength(1);
    expect(f.bindings.get(ids.fixed)?.lifetime).toBe("RESERVED");
  });
  it("reconciles a create whose successful response was lost, rather than allocating again", async () => {
    const f = fixture();
    const create = f.handlers.createPublicIp;
    f.handlers.createPublicIp = (request) => {
      create(request);
      throw { code: "ETIMEDOUT" };
    };
    const saved = {};
    await expect(f.adapter.execute(credentials, rotate(), jobContext(saved))).rejects.toMatchObject(
      { retryable: true },
    );
    const done = await f.adapter.execute(credentials, rotate(), jobContext(saved));
    expect(done.details?.publicIpId).toBe(ids.newPublic);
    expect(f.calls.filter((c) => c.operation === "createPublicIp")).toHaveLength(1);
  });
  it("retries allocation with the same persisted OCI token and exact request after a service rejection", async () => {
    const f = fixture();
    const create = f.handlers.createPublicIp;
    let attempted = false;
    f.handlers.createPublicIp = (request) => {
      if (!attempted) {
        attempted = true;
        throw { statusCode: 429, serviceCode: "TooManyRequests" };
      }
      return create(request);
    };
    const saved = {};
    await expect(f.adapter.execute(credentials, rotate(), jobContext(saved))).rejects.toMatchObject(
      { retryable: true },
    );
    await f.adapter.execute(credentials, rotate(), jobContext(saved));
    const requests = f.calls.filter((c) => c.operation === "createPublicIp").map((c) => c.request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].opcRetryToken).toBe(jobContext().jobId);
    expect(f.calls.filter((c) => c.operation === "deletePublicIp")).toHaveLength(1);
  });
  it("does not delete a reserved IP attached by another actor while rotation was interrupted", async () => {
    const f = fixture();
    f.handlers.createPublicIp = () => {
      throw { statusCode: 429 };
    };
    const saved = {};
    await expect(
      f.adapter.execute(credentials, rotate(), jobContext(saved)),
    ).rejects.toBeInstanceOf(CloudError);
    f.bindings.set(ids.primary, {
      id: id("publicip", "external"),
      privateIpId: ids.primary,
      lifetime: "RESERVED",
      ipAddress: "192.0.2.10",
    });
    await expect(f.adapter.execute(credentials, rotate(), jobContext(saved))).rejects.toMatchObject(
      { code: "PROTECTED_PUBLIC_IP" },
    );
    expect(f.calls.filter((c) => c.operation === "deletePublicIp")).toHaveLength(1);
  });
  it("stops after the OCI retry-token window expires when allocation cannot be reconciled", async () => {
    const f = fixture();
    f.handlers.createPublicIp = () => {
      throw { statusCode: 429 };
    };
    const saved = {};
    await expect(
      f.adapter.execute(credentials, rotate(), jobContext(saved)),
    ).rejects.toBeInstanceOf(CloudError);
    const later = createOciAdapter({
      clientFactory: f.factory,
      now: () => Date.parse("2026-11-09T00:00:00Z"),
      pollIntervalMs: 0,
    });
    await expect(later.execute(credentials, rotate(), jobContext(saved))).rejects.toMatchObject({
      code: "UNCERTAIN_OUTCOME",
      retryable: false,
    });
    expect(f.calls.filter((c) => c.operation === "createPublicIp")).toHaveLength(1);
  });
});

describe("OCI inventory and client boundaries", () => {
  it("paginates compartments and instances, reports all IP bindings, and never invents memory usage", async () => {
    const f = fixture();
    const child = id("compartment", "child"),
      child2 = id("compartment", "childtwo");
    f.handlers.listCompartments = (request) =>
      request.page
        ? { items: [{ id: child2, name: "child2", lifecycleState: "ACTIVE" }] }
        : {
            items: [{ id: child, name: "child", lifecycleState: "ACTIVE" }],
            opcNextPage: "comp-page-2",
          };
    f.handlers.listInstances = (request) =>
      request.compartmentId !== ids.tenancy
        ? { items: [] }
        : request.page
          ? { items: [{ ...f.instance, id: id("instance", "second"), displayName: "second" }] }
          : { items: [f.instance], opcNextPage: "inst-page-2" };
    const result = await f.adapter.inventory(credentials, account, ["ap-test-1"]);
    expect(result.instances).toHaveLength(2);
    expect(result.instances[0].vnics[0].privateIps).toHaveLength(2);
    expect(
      result.instances[0].vnics[0].privateIps.find((p) => p.publicIpId === ids.fixedPublic)
        ?.protected,
    ).toBe(true);
    expect(result.instances[0].bootVolumes[0].vpusPerGb).toBe(10);
    expect(result.instances[0].metrics?.memoryPercent).toBeNull();
    expect(result.instances[0].tags).toEqual({ owner: "test" });
    expect(JSON.stringify(result)).not.toContain("MUST-NOT-BE-RETURNED");
    expect(
      f.calls.some((c) => c.operation === "listInstances" && c.request.compartmentId === child2),
    ).toBe(true);
    for (const client of Object.values(f.clients)) expect(client.close).toHaveBeenCalledTimes(1);
  });
  it("constructs a separate immutable region scope for every inventory region", async () => {
    const f = fixture();
    await f.adapter.inventory(credentials, account, ["ap-test-1", "eu-test-1"]);
    expect(f.factory.mock.calls.map((call) => call[1])).toEqual(["ap-test-1", "eu-test-1"]);
    expect(credentials.region).toBe("ap-test-1");
  });
  it("detects a repeated pagination cursor", async () => {
    const f = fixture();
    f.handlers.listCompartments = () => ({ items: [], opcNextPage: "same" });
    await expect(allPages(f.clients.identity, "listCompartments", {})).rejects.toMatchObject({
      code: "PAGINATION_LOOP",
    });
  });
  it("closes clients and strips credentials from SDK error messages", async () => {
    const f = fixture();
    f.handlers.getTenancy = () => {
      throw {
        statusCode: 401,
        serviceCode: "NotAuthenticated",
        message: "privateKey=LEAK Authorization=LEAK",
      };
    };
    await expect(f.adapter.verify(credentials)).rejects.toMatchObject({
      code: "NotAuthenticated",
      retryable: false,
    });
    try {
      await f.adapter.verify(credentials);
    } catch (error) {
      expect(String(error)).not.toContain("LEAK");
    }
    for (const client of Object.values(f.clients)) expect(client.close).toHaveBeenCalledTimes(2);
  });
  it("classifies flattened official-SDK transport failures as retryable without exposing request data", () => {
    for (const [raw, code] of [
      [
        { message: "fetch failed", requestEndpoint: "https://example.invalid/private-resource" },
        "OCI_NETWORK_ERROR",
      ],
      [
        {
          message: "The operation was aborted due to timeout",
          requestEndpoint: "https://example.invalid/private-resource",
        },
        "OCI_TIMEOUT",
      ],
      [
        { statusCode: "EOPENBREAKER", serviceCode: "unknown code", message: "internal details" },
        "EOPENBREAKER",
      ],
    ] as const) {
      const error = cloudError(raw);
      expect(error).toMatchObject({ code, retryable: true });
      expect(String(error)).not.toContain("private-resource");
      expect(String(error)).not.toContain("internal details");
    }
  });
  it("returns native metric data and leaves missing network measurements null", async () => {
    const f = fixture();
    f.handlers.summarizeMetricsData = (request) =>
      request.summarizeMetricsDataDetails.namespace === "oci_computeagent"
        ? {
            items: [
              {
                aggregatedDatapoints: [{ timestamp: new Date("2026-11-06T23:30:00Z"), value: 12 }],
              },
            ],
          }
        : { items: [] };
    const snapshot = { id: ids.instance, region: "ap-test-1" } as InstanceSummary;
    const metrics = await f.adapter.metrics(credentials, snapshot, "1h");
    expect(metrics).toMatchObject({ source: "oci", available: true });
    expect(metrics.points[0]).toMatchObject({ cpu: 12, receivedBytes: null, sentBytes: null });
  });
});

describe("OCI mutations are scoped and optimistic", () => {
  const rule = {
    direction: "INGRESS",
    protocol: "6",
    peer: "192.0.2.0/24",
    peerType: "CIDR_BLOCK",
    description: "new",
    stateless: false,
    portMin: 443,
    portMax: 443,
  };
  it("requires security-list ETag and preserves untouched rules and their source-port options", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        operation("security-rule-add", {
          groupKind: "security-list",
          groupId: ids.securityList,
          rule,
        }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "ETAG_REQUIRED" });
    expect(f.writes()).toEqual([]);
    await f.adapter.execute(
      credentials,
      operation("security-rule-add", {
        groupKind: "security-list",
        groupId: ids.securityList,
        etag: "list-e1",
        rule,
      }),
      jobContext(),
    );
    const write = f.writes()[0];
    expect(write.request.ifMatch).toBe("list-e1");
    expect(
      write.request.updateSecurityListDetails.ingressSecurityRules[0].tcpOptions.sourcePortRange,
    ).toEqual({ min: 3000, max: 4000 });
    expect(write.request.updateSecurityListDetails.egressSecurityRules).toHaveLength(1);
  });
  it("refuses stale security-list state without overwriting concurrent edits", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        operation("security-rule-add", {
          groupKind: "security-list",
          groupId: ids.securityList,
          etag: "old",
          rule,
        }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_CHANGED" });
    expect(f.writes()).toEqual([]);
  });
  it("reconciles an applied security-list update after a lost response without replacing it twice", async () => {
    const f = fixture(),
      update = f.handlers.updateSecurityList;
    f.handlers.updateSecurityList = (request) => {
      update(request);
      throw { code: "ECONNRESET" };
    };
    const saved = {},
      op = operation("security-rule-add", {
        groupKind: "security-list",
        groupId: ids.securityList,
        etag: "list-e1",
        rule,
      });
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      retryable: true,
    });
    await f.adapter.execute(credentials, op, jobContext(saved));
    expect(f.calls.filter((c) => c.operation === "updateSecurityList")).toHaveLength(1);
  });
  it("refuses an unassociated security group", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        operation("security-rule-add", {
          groupKind: "nsg",
          groupId: id("networksecuritygroup", "other"),
          rule,
        }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_MISMATCH" });
    expect(f.writes()).toEqual([]);
  });
  it("recovers a lost NSG-add response by reading the rule instead of appending a duplicate", async () => {
    const f = fixture(),
      add = f.handlers.addNetworkSecurityGroupSecurityRules;
    f.handlers.addNetworkSecurityGroupSecurityRules = (request) => {
      add(request);
      throw { code: "ECONNRESET" };
    };
    const saved = {},
      op = operation("security-rule-add", { groupKind: "nsg", groupId: ids.nsg, rule });
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      code: "UNCERTAIN_OUTCOME",
    });
    await f.adapter.execute(credentials, op, jobContext(saved));
    expect(f.nsgRules).toHaveLength(1);
    expect(
      f.calls.filter((c) => c.operation === "addNetworkSecurityGroupSecurityRules"),
    ).toHaveLength(1);
  });
  it("does not blindly repeat an NSG add when a lost response cannot yet be reconciled", async () => {
    const f = fixture();
    f.handlers.addNetworkSecurityGroupSecurityRules = () => {
      throw { code: "ETIMEDOUT" };
    };
    const saved = {},
      op = operation("security-rule-add", { groupKind: "nsg", groupId: ids.nsg, rule });
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      code: "UNCERTAIN_OUTCOME",
    });
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      code: "UNCERTAIN_OUTCOME",
      retryable: false,
    });
    expect(
      f.calls.filter((c) => c.operation === "addNetworkSecurityGroupSecurityRules"),
    ).toHaveLength(1);
  });
  it("refuses boot-volume shrink and updates only a currently attached boot volume", async () => {
    const f = fixture();
    await expect(
      f.adapter.execute(
        credentials,
        operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 25 }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "VOLUME_SHRINK_REFUSED" });
    await expect(
      f.adapter.execute(
        credentials,
        operation("boot-volume-update", { bootVolumeId: id("bootvolume", "other"), sizeGb: 100 }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "RESOURCE_MISMATCH" });
    expect(f.writes()).toEqual([]);
    await f.adapter.execute(
      credentials,
      operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 100, vpusPerGb: 100 }),
      jobContext(),
    );
    expect(f.boot).toMatchObject({ sizeInGBs: 100, vpusPerGB: 100 });
  });
  it("updates VPU on a legacy 47-GiB boot volume without resending its size", async () => {
    const f = fixture();
    f.boot.sizeInGBs = 47;
    await f.adapter.execute(
      credentials,
      operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 47, vpusPerGb: 100 }),
      jobContext(),
    );
    expect(f.writes()[0].request.updateBootVolumeDetails).toEqual({ vpusPerGB: 100 });
    expect(f.boot).toMatchObject({ sizeInGBs: 47, vpusPerGB: 100 });
  });
  it("requires at least 50 GiB only when actually expanding a legacy boot volume", async () => {
    const f = fixture();
    f.boot.sizeInGBs = 47;
    await expect(
      f.adapter.execute(
        credentials,
        operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 48, vpusPerGb: 10 }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      f.adapter.execute(
        credentials,
        operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 46, vpusPerGb: 10 }),
        jobContext(),
      ),
    ).rejects.toMatchObject({ code: "VOLUME_SHRINK_REFUSED" });
    expect(f.writes()).toEqual([]);
    await f.adapter.execute(
      credentials,
      operation("boot-volume-update", { bootVolumeId: ids.boot, sizeGb: 50, vpusPerGb: 10 }),
      jobContext(),
    );
    expect(f.writes()[0].request.updateBootVolumeDetails).toEqual({ sizeInGBs: 50 });
  });
  it("keeps volumes by default when termination has the exact name confirmation", async () => {
    const f = fixture(),
      op = operation("instance-terminate");
    await expect(f.adapter.execute(credentials, op, jobContext())).rejects.toMatchObject({
      code: "CONFIRMATION_REQUIRED",
    });
    await f.adapter.execute(credentials, { ...op, confirmation: "test-server" }, jobContext());
    expect(f.writes()[0].request).toMatchObject({
      preserveBootVolume: true,
      preserveDataVolumesCreatedAtLaunch: true,
      ifMatch: "instance-e1",
    });
  });
  it("sends power requests with the persisted job token and handles idempotent stop", async () => {
    const f = fixture(),
      saved = {};
    await f.adapter.execute(
      credentials,
      operation("instance-stop", { expectedState: "RUNNING" }),
      jobContext(saved),
    );
    await f.adapter.execute(
      credentials,
      operation("instance-stop", { expectedState: "RUNNING" }),
      jobContext(saved),
    );
    expect(f.calls.filter((c) => c.operation === "instanceAction")).toHaveLength(1);
    expect(f.writes()[0].request).toMatchObject({
      action: "SOFTSTOP",
      opcRetryToken: jobContext().jobId,
      ifMatch: "instance-e1",
    });
  });
  it("reuses exactly the same reboot token after an unacknowledged power request", async () => {
    const f = fixture(),
      saved = {},
      seen = new Set<string>();
    let effects = 0;
    f.handlers.instanceAction = (request) => {
      if (!seen.has(request.opcRetryToken)) {
        seen.add(request.opcRetryToken);
        effects++;
        throw { code: "ECONNRESET" };
      }
      return { instance: f.instance };
    };
    const op = operation("instance-reboot");
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      retryable: true,
    });
    await f.adapter.execute(credentials, op, jobContext(saved));
    const requests = f.calls.filter((c) => c.operation === "instanceAction").map((c) => c.request);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(effects).toBe(1);
  });
  it("does not execute mutations after cancellation", async () => {
    const f = fixture(),
      context = jobContext(),
      controller = new AbortController();
    controller.abort();
    context.signal = controller.signal;
    await expect(f.adapter.execute(credentials, rotate(), context)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(f.writes()).toEqual([]);
  });
  it("reconciles an instance launch whose successful response was lost", async () => {
    const f = fixture();
    f.handlers.listInstances = () => ({
      items: f.instance.freeformTags?.["oci-dash-job"] ? [f.instance] : [],
    });
    const launch = f.handlers.launchInstance;
    f.handlers.launchInstance = (request) => {
      launch(request);
      throw { code: "ECONNRESET" };
    };
    const op = operation("instance-create", {
      compartmentId: ids.tenancy,
      availabilityDomain: "TEST:AD-1",
      displayName: "new-server",
      shape: "VM.Standard.E2.1.Micro",
      imageId: ids.image,
      subnetId: ids.subnet,
      assignPublicIp: true,
      sshPublicKey: "ssh-ed25519 AAAATESTPUBLICKEY test",
    });
    delete op.resourceId;
    const saved = {};
    await expect(f.adapter.execute(credentials, op, jobContext(saved))).rejects.toMatchObject({
      retryable: true,
    });
    await f.adapter.execute(credentials, op, jobContext(saved));
    expect(f.calls.filter((c) => c.operation === "launchInstance")).toHaveLength(1);
    expect(f.writes()[0].request.opcRetryToken).toBe(jobContext().jobId);
  });
  it("does not allocate IPv6 twice when a prior allocation is already visible", async () => {
    const f = fixture(),
      saved = {},
      op = operation("ipv6-assign", { vnicId: ids.vnic });
    await f.adapter.execute(credentials, op, jobContext(saved));
    await f.adapter.execute(credentials, op, jobContext(saved));
    expect(f.ipv6s).toHaveLength(1);
    expect(f.calls.filter((c) => c.operation === "createIpv6")).toHaveLength(1);
  });
});
