"use client";

import type { InstanceSummary, PublicIpBinding, VnicSummary } from "@/lib/contracts";
import { primaryAddress } from "./format";
import { publicIpRotation } from "./public-ip-rotation";

/** Preserve the address and public-IP identity the user selected, even if inventory changes. */
export interface IpDetailsTarget {
  kind: "public" | "private" | "ipv6";
  address: string;
  vnicId: string;
  privateIpId?: string;
  publicIpId?: string;
}

export function targetForBinding(
  vnic: VnicSummary,
  binding: PublicIpBinding,
  kind: "public" | "private" = "public",
): IpDetailsTarget {
  return {
    kind,
    address: kind === "public" ? binding.publicIp || "" : binding.privateIp,
    vnicId: vnic.id,
    privateIpId: binding.privateIpId,
    publicIpId: kind === "public" ? binding.publicIpId : undefined,
  };
}

export function primaryIpTarget(instance: InstanceSummary): IpDetailsTarget | undefined {
  const address = primaryAddress(instance);
  for (const vnic of instance.vnics) {
    const publicBinding = vnic.privateIps.find((binding) => binding.publicIp === address);
    if (publicBinding) return targetForBinding(vnic, publicBinding);
    const privateBinding = vnic.privateIps.find((binding) => binding.privateIp === address);
    if (privateBinding) return targetForBinding(vnic, privateBinding, "private");
  }
  const vnic = instance.vnics.find((item) => item.ipv6.length);
  return vnic ? { kind: "ipv6", address: vnic.ipv6[0], vnicId: vnic.id } : undefined;
}

export function getIpDetails(
  instance: InstanceSummary | undefined,
  target: IpDetailsTarget,
  blockedReason?: string,
) {
  const vnic = instance?.vnics.find((item) => item.id === target.vnicId);
  const binding = vnic?.privateIps.find((item) => item.privateIpId === target.privateIpId);
  let reason: string | undefined;
  if (!instance || !vnic) reason = "实例或网卡信息已变化，请关闭详情并刷新资源。";
  else if (target.kind === "ipv6")
    reason = vnic.ipv6.includes(target.address)
      ? "此地址为 IPv6，不支持在此更换公网 IPv4。"
      : "此地址已不在当前网卡中，请关闭详情并刷新资源。";
  else if (
    !binding ||
    binding.vnicId !== vnic.id ||
    (target.kind === "private"
      ? binding.privateIp !== target.address
      : binding.publicIp !== target.address || binding.publicIpId !== target.publicIpId)
  )
    reason = "地址绑定已变化，请关闭详情并重新打开当前地址。";
  else if (target.kind === "private") reason = "此地址为私网 IPv4，不支持在此更换。";
  else if (binding.protected) reason = "此公网 IP 已受保护，不能更换。";
  else if (binding.lifetime === "RESERVED") reason = "此地址为保留公网 IP，不支持在此更换。";
  else if (binding.lifetime !== "EPHEMERAL") reason = "公网 IP 类型未确认，请先刷新资源。";
  else if (!binding.publicIpId || !binding.publicIp || !binding.privateIpId)
    reason = "地址信息不完整，请先刷新资源。";
  else if (!["RUNNING", "STOPPED"].includes(instance.state)) reason = "当前实例状态不可更换 IP。";
  else if (blockedReason) reason = blockedReason;

  const rotation =
    !reason && instance && vnic && binding ? publicIpRotation(instance, vnic, binding) : null;
  if (!reason && !rotation) reason = "地址绑定信息不一致，请先刷新资源。";
  return { vnic, binding, reason, operation: rotation?.operation };
}

export function IpAddressButton({
  target,
  onClick,
  label,
}: {
  target: IpDetailsTarget;
  onClick: (target: IpDetailsTarget) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      className="inline min-w-0 max-w-full rounded-sm border-0 bg-transparent p-0 text-start font-mono text-primary wrap-anywhere hover:underline hover:underline-offset-4"
      aria-label={label ?? `查看 IP ${target.address} 详情`}
      title="查看 IP 详情"
      onClick={() => onClick(target)}
    >
      {target.address}
    </button>
  );
}
