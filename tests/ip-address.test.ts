import { describe, expect, it } from "vitest";
import type { InstanceSummary } from "@/lib/contracts";
import { getIpDetails, primaryIpTarget, targetForBinding } from "@/components/ip-address";
import { ipRotationContext } from "@/components/public-ip-rotation";

function fixture() {
  const instance: InstanceSummary = {
    id: "instance-fixture",
    displayName: "Fixture server",
    accountId: "account-fixture",
    accountName: "Fixture account",
    region: "ap-tokyo-1",
    compartmentId: "compartment-fixture",
    availabilityDomain: "AD-1",
    state: "RUNNING",
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    createdAt: "2026-11-01T00:00:00Z",
    syncedAt: "2026-11-01T00:00:00Z",
    bootVolumes: [],
    tags: {},
    vnics: [
      {
        id: "vnic-fixed",
        name: "Primary",
        primary: true,
        subnetId: "subnet-fixture",
        nsgIds: [],
        ipv6: [],
        privateIps: [
          {
            privateIpId: "private-fixed",
            privateIp: "10.0.0.2",
            isPrimary: true,
            vnicId: "vnic-fixed",
            publicIpId: "public-fixed",
            publicIp: "203.0.113.10",
            lifetime: "RESERVED",
            protected: false,
          },
        ],
      },
      {
        id: "vnic-target",
        name: "26-11-6 20:45",
        primary: false,
        subnetId: "subnet-fixture",
        nsgIds: [],
        ipv6: ["2001:db8::20"],
        privateIps: [
          {
            privateIpId: "private-target",
            privateIp: "10.1.0.20",
            isPrimary: true,
            vnicId: "vnic-target",
            publicIpId: "public-target",
            publicIp: "198.51.100.20",
            lifetime: "EPHEMERAL",
            protected: false,
          },
        ],
      },
    ],
  };
  const vnic = instance.vnics[1],
    binding = vnic.privateIps[0];
  const target = targetForBinding(vnic, binding);
  return { instance, vnic, binding, target };
}

describe("shared IP details and replacement eligibility", () => {
  it("keeps the selected secondary binding and its date-shaped interface name", () => {
    const { instance, target } = fixture();
    const details = getIpDetails(instance, target);
    expect(details.vnic?.name).toBe("26-11-6 20:45");
    expect(details.vnic?.primary).toBe(false);
    expect(details.reason).toBeUndefined();
    expect(details.operation).toEqual({
      kind: "public-ip-rotate",
      accountId: instance.accountId,
      region: instance.region,
      resourceId: instance.id,
      payload: {
        vnicId: "vnic-target",
        privateIpId: "private-target",
        expectedPublicIpId: "public-target",
        expectedPublicIp: "198.51.100.20",
      },
    });
  });

  it.each(["reserved", "protected", "unknown-type", "missing-id", "private", "ipv6"])(
    "opens %s address information without offering an operation",
    (kind) => {
      const { instance, vnic, binding, target } = fixture();
      if (kind === "reserved") binding.lifetime = "RESERVED";
      if (kind === "protected") binding.protected = true;
      if (kind === "unknown-type") binding.lifetime = undefined;
      if (kind === "missing-id") binding.publicIpId = undefined;
      const selected =
        kind === "private"
          ? targetForBinding(vnic, binding, "private")
          : kind === "ipv6"
            ? { kind: "ipv6" as const, address: vnic.ipv6[0], vnicId: vnic.id }
            : kind === "missing-id"
              ? targetForBinding(vnic, binding)
              : target;
      const details = getIpDetails(instance, selected);
      expect(details.vnic?.id).toBe(vnic.id);
      expect(details.reason).toBeTruthy();
      expect(details.operation).toBeUndefined();
    },
  );

  it.each(["public-id", "address", "private-id", "vnic-owner", "removed"])(
    "does not retarget the selection after its %s changes",
    (change) => {
      const { instance, vnic, binding, target } = fixture();
      if (change === "public-id") binding.publicIpId = "reassigned-public-id";
      if (change === "address") binding.publicIp = "198.51.100.120";
      if (change === "private-id") binding.privateIpId = "reassigned-private-id";
      if (change === "vnic-owner") binding.vnicId = instance.vnics[0].id;
      if (change === "removed") vnic.privateIps = [];
      const details = getIpDetails(instance, target);
      expect(details.reason).toBeTruthy();
      expect(details.operation).toBeUndefined();
      expect(target.address).toBe("198.51.100.20");
      expect(target.publicIpId).toBe("public-target");
    },
  );

  it.each(["STARTING", "TERMINATING", "TERMINATED"])(
    "keeps %s instance addresses read-only",
    (state) => {
      const { instance, target } = fixture();
      instance.state = state;
      const details = getIpDetails(instance, target);
      expect(details.reason).toBeTruthy();
      expect(details.operation).toBeUndefined();
    },
  );

  it("blocks mutation while task state or inventory is unconfirmed", () => {
    const { instance, target } = fixture();
    const reason = "地址同步不完整，请先刷新资源";
    expect(getIpDetails(instance, target, reason)).toMatchObject({ reason, operation: undefined });
    expect(getIpDetails(undefined, target).operation).toBeUndefined();
  });

  it("blocks stale address inventory without blocking an unrelated stale volume", () => {
    const { instance, target } = fixture();
    const state = { jobs: [], loading: false, error: null, busyInstanceIds: new Set<string>() };
    instance.staleFields = ["公网 IP"];
    const stale = ipRotationContext(instance, state);
    expect(stale.blockedReason).toBeTruthy();
    expect(getIpDetails(instance, target, stale.blockedReason).operation).toBeUndefined();
    instance.staleFields = ["启动卷"];
    const unrelated = ipRotationContext(instance, state);
    expect(unrelated.blockedReason).toBeUndefined();
    expect(getIpDetails(instance, target, unrelated.blockedReason).operation).toBeDefined();
  });

  it("resolves the table or card address across fixed, private and IPv6-only inventory", () => {
    const { instance } = fixture();
    expect(primaryIpTarget(instance)).toMatchObject({
      kind: "public",
      address: "203.0.113.10",
      vnicId: "vnic-fixed",
    });
    for (const vnic of instance.vnics)
      for (const binding of vnic.privateIps) binding.publicIp = undefined;
    expect(primaryIpTarget(instance)).toMatchObject({
      kind: "private",
      address: "10.0.0.2",
      privateIpId: "private-fixed",
    });
    for (const vnic of instance.vnics) vnic.privateIps = [];
    expect(primaryIpTarget(instance)).toEqual({
      kind: "ipv6",
      address: "2001:db8::20",
      vnicId: "vnic-target",
    });
    instance.vnics[1].ipv6 = [];
    expect(primaryIpTarget(instance)).toBeUndefined();
  });
});
