import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createOciAdapter } from "@/server/oci/adapter";
import { createJobStore } from "@/server/jobs/store";
import { runWorker } from "@/server/jobs/worker";
import type { CloudDocument, OciClients } from "@/server/oci/sdk";
import type { ExecutionContext, OciCredentials } from "@/server/oci/types";
import type { AccountSummary, OperationRequest } from "@/lib/contracts";

const id = (kind: string) => `ocid1.${kind}.oc1..pendingtest`;
const credentials: OciCredentials = {
  tenancyId: id("tenancy"),
  userId: id("user"),
  fingerprint: "fixture",
  privateKey: "fixture-only",
  region: "ap-test-1",
};
const account: AccountSummary = {
  id: "pending-account",
  name: "Pending fixture",
  tenancyId: credentials.tenancyId,
  userId: credentials.userId,
  fingerprint: credentials.fingerprint,
  homeRegion: credentials.region,
  regions: [credentials.region],
  status: "connected",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-01-01T00:00:00Z",
};
const handles: Database.Database[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const db of handles.splice(0)) if (db.open) db.close();
});
function clients(handlers: Record<string, (request: CloudDocument) => CloudDocument>) {
  const call = vi.fn(async (method: string, request: CloudDocument) => {
    if (!handlers[method]) throw new Error(`Unexpected mocked OCI call: ${method}`);
    return handlers[method](request);
  });
  const port = { call, close() {} };
  return {
    call,
    value: {
      identity: port,
      compute: port,
      network: port,
      storage: port,
      monitoring: port,
    } satisfies OciClients,
  };
}

describe("OCI accepted-operation polling", () => {
  it("completes a three-minute instance launch with one cloud write and the default polling interval", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-01-01T00:00:00Z");
    vi.setSystemTime(start);
    vi.stubEnv("DEMO_MODE", "false");
    let instance: CloudDocument | null = null;
    const cloud = clients({
      listCompartments: () => ({ items: [] }),
      listInstances: () => ({ items: instance ? [instance] : [] }),
      listAvailabilityDomains: () => ({ items: [{ name: "TEST:AD-1" }] }),
      getSubnet: () => ({
        subnet: { id: id("subnet"), compartmentId: id("tenancy"), lifecycleState: "AVAILABLE" },
      }),
      getImage: () => ({ image: { id: id("image"), lifecycleState: "AVAILABLE" } }),
      listShapes: () => ({ items: [{ shape: "VM.Standard.E2.1.Micro", isFlexible: false }] }),
      launchInstance: (request) => {
        instance = {
          ...request.launchInstanceDetails,
          id: id("instance"),
          lifecycleState: "PROVISIONING",
        };
        return { instance: structuredClone(instance) };
      },
      getInstance: () => ({
        instance: {
          ...instance,
          lifecycleState: Date.now() - start >= 180000 ? "RUNNING" : "PROVISIONING",
        },
        etag: "fixture-etag",
      }),
    });
    const db = new Database(":memory:");
    handles.push(db);
    const store = createJobStore({ db, getAccount: () => account });
    const adapter = createOciAdapter({ clientFactory: () => cloud.value });
    const dependencies = {
      store,
      adapter: {
        ...adapter,
        inventory: vi.fn(async () => ({ instances: [], warnings: [], regions: account.regions })),
      },
      getCredentials: () => credentials,
      saveInventory: vi.fn(),
      setAccountError: vi.fn(),
    };
    const job = store.enqueueOperation(
      {
        kind: "instance-create",
        accountId: account.id,
        region: account.homeRegion,
        payload: {
          compartmentId: id("tenancy"),
          availabilityDomain: "TEST:AD-1",
          displayName: "Provisioning instance",
          shape: "VM.Standard.E2.1.Micro",
          subnetId: id("subnet"),
          imageId: id("image"),
          sshPublicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixture",
        },
      },
      "test-admin",
    );
    for (let observation = 0; observation < 10; observation++) {
      const worker = runWorker({ signal: new AbortController().signal, once: true, dependencies });
      await vi.advanceTimersByTimeAsync(30000);
      await worker;
      const current = store.getJob(job.id)!;
      if (current.state === "succeeded") break;
      expect(current).toMatchObject({ state: "retrying", waitingForCompletion: true, attempt: 1 });
      await vi.advanceTimersByTimeAsync(Math.max(0, Date.parse(current.nextRunAt!) - Date.now()));
    }
    expect(store.getJob(job.id)).toMatchObject({ state: "succeeded", attempt: 1 });
    expect(cloud.call.mock.calls.filter(([method]) => method === "launchInstance")).toHaveLength(1);
    expect(dependencies.saveInventory).toHaveBeenCalledOnce();
    expect(Date.now() - start).toBeGreaterThanOrEqual(180000);
  });

  it("keeps reconciling an acknowledged NSG add while list reads lag, without adding again", async () => {
    let visible = false;
    let added: CloudDocument | undefined;
    const cloud = clients({
      listCompartments: () => ({ items: [] }),
      getInstance: () => ({
        instance: { id: id("instance"), compartmentId: id("tenancy") },
        etag: "instance-etag",
      }),
      listVnicAttachments: () => ({
        items: [{ vnicId: id("vnic"), instanceId: id("instance"), lifecycleState: "ATTACHED" }],
      }),
      getVnic: () => ({ vnic: { id: id("vnic"), nsgIds: [id("networksecuritygroup")] } }),
      getNetworkSecurityGroup: () => ({
        networkSecurityGroup: { id: id("networksecuritygroup") },
        etag: "group-etag",
      }),
      listNetworkSecurityGroupSecurityRules: () => ({
        items: visible && added ? [{ ...added, id: "rule-id" }] : [],
      }),
      addNetworkSecurityGroupSecurityRules: (request) => {
        added = request.addNetworkSecurityGroupSecurityRulesDetails.securityRules[0];
        return {};
      },
    });
    const adapter = createOciAdapter({ clientFactory: () => cloud.value });
    const operation: OperationRequest = {
      kind: "security-rule-add",
      accountId: account.id,
      region: account.homeRegion,
      resourceId: id("instance"),
      payload: {
        groupKind: "nsg",
        groupId: id("networksecuritygroup"),
        rule: {
          direction: "INGRESS",
          protocol: "6",
          peer: "192.0.2.0/24",
          peerType: "CIDR_BLOCK",
          portMin: 443,
          portMax: 443,
        },
      },
    };
    const checkpoints: Record<string, unknown> = {};
    const context: ExecutionContext = {
      jobId: "test-job",
      checkpoints,
      signal: new AbortController().signal,
      progress: async () => {},
      checkpoint: async (key, value) => {
        checkpoints[key] = structuredClone(value);
      },
    };
    await expect(adapter.execute(credentials, operation, context)).rejects.toMatchObject({
      code: "RESOURCE_PENDING",
    });
    expect(checkpoints.nsgAccepted).toBe(true);
    await expect(adapter.execute(credentials, operation, context)).rejects.toMatchObject({
      code: "RESOURCE_PENDING",
    });
    visible = true;
    await expect(adapter.execute(credentials, operation, context)).resolves.toMatchObject({
      message: "安全规则已存在",
    });
    expect(
      cloud.call.mock.calls.filter(([method]) => method === "addNetworkSecurityGroupSecurityRules"),
    ).toHaveLength(1);
  });
});
