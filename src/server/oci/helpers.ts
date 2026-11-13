import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { SecurityRule, SelectOption } from "@/lib/contracts";
import { CloudError, type ExecutionContext, type OciCredentials } from "./types";
import { allPages, type CloudDocument, type OciClients } from "./sdk";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function text(value: unknown, name: string, max = 255): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value))
    throw new CloudError(`${name}不正确`, "VALIDATION_ERROR");
  return value.trim();
}
export function ocid(value: unknown, kinds: string | string[], name = "资源 ID"): string {
  const id = text(value, name, 512);
  const allowed = Array.isArray(kinds) ? kinds : [kinds];
  if (
    !/^ocid1\.[a-z0-9]+\.[a-z0-9]+\.[a-z0-9.-]+$/.test(id) ||
    !allowed.some((kind) => id.startsWith(`ocid1.${kind}.`))
  )
    throw new CloudError(`${name}类型不正确`, "VALIDATION_ERROR");
  return id;
}
export function regionName(region: string): string {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(region))
    throw new CloudError("区域不正确", "VALIDATION_ERROR");
  return region;
}
export function numeric(
  value: unknown,
  name: string,
  min: number,
  max: number,
  integer = false,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  )
    throw new CloudError(`${name}超出允许范围`, "VALIDATION_ERROR");
  return value;
}
export function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}
export function protectedPublicIp(ip: CloudDocument): boolean {
  return (
    ip.lifetime !== "EPHEMERAL" ||
    ["oci-dash-protected", "protected"].some((key) =>
      ["true", "1", "yes"].includes(String(ip.freeformTags?.[key]).toLowerCase()),
    )
  );
}
export async function compartments(
  clients: OciClients,
  credentials: OciCredentials,
  context?: ExecutionContext,
): Promise<SelectOption[]> {
  const root = ocid(credentials.tenancyId, "tenancy", "租户 ID");
  const values = await allPages(
    clients.identity,
    "listCompartments",
    {
      compartmentId: root,
      compartmentIdInSubtree: true,
      accessLevel: "ACCESSIBLE",
      lifecycleState: "ACTIVE",
    },
    context,
  );
  return [
    { id: root, name: "根区间" },
    ...values
      .filter((c) => c.lifecycleState === "ACTIVE" && c.id !== root)
      .map((c) => ({ id: c.id, name: c.name ?? c.id })),
  ];
}
export function requireCompartment(id: string, available: SelectOption[]): void {
  ocid(id, ["tenancy", "compartment"], "区间 ID");
  if (!available.some((c) => c.id === id))
    throw new CloudError("资源不属于此账号的可访问区间", "RESOURCE_MISMATCH");
}
export function checkEtag(actual: unknown, expected: unknown, required = false): string {
  if (required && (typeof expected !== "string" || !expected))
    throw new CloudError("请刷新资源后再提交修改", "ETAG_REQUIRED");
  if (typeof actual !== "string" || !actual)
    throw new CloudError("OCI 未返回并发保护标识，已拒绝修改", "ETAG_MISSING");
  if (expected !== undefined && expected !== actual)
    throw new CloudError("资源已被其他操作修改，请刷新后重试", "RESOURCE_CHANGED");
  return actual;
}
export async function checkpoint(
  context: ExecutionContext,
  key: string,
  value: unknown,
): Promise<void> {
  await context.checkpoint(key, value);
  context.checkpoints[key] = value;
}
export function retryWindow(intent: CloudDocument, now: number): void {
  if (!Number.isFinite(intent.startedAt) || now - intent.startedAt >= 23 * 60 * 60 * 1000)
    throw new CloudError(
      "OCI 幂等令牌已接近过期，无法确认结果时已停止自动重试，请核对云资源",
      "UNCERTAIN_OUTCOME",
    );
}
export function ruleFromCloud(
  raw: CloudDocument,
  direction: "INGRESS" | "EGRESS",
  id?: string,
): SecurityRule {
  const range = raw.tcpOptions?.destinationPortRange ?? raw.udpOptions?.destinationPortRange;
  return {
    id: id ?? raw.id,
    direction,
    protocol: String(raw.protocol),
    peer: direction === "INGRESS" ? raw.source : raw.destination,
    peerType:
      direction === "INGRESS"
        ? (raw.sourceType ?? "CIDR_BLOCK")
        : (raw.destinationType ?? "CIDR_BLOCK"),
    description: raw.description ?? "",
    stateless: Boolean(raw.isStateless),
    ...(range ? { portMin: range.min, portMax: range.max } : {}),
    ...(raw.icmpOptions ? { icmpType: raw.icmpOptions.type, icmpCode: raw.icmpOptions.code } : {}),
  };
}
export function ruleToCloud(input: unknown, nsg: boolean): CloudDocument {
  if (!input || typeof input !== "object")
    throw new CloudError("安全规则不正确", "VALIDATION_ERROR");
  const r = input as CloudDocument;
  if (!["INGRESS", "EGRESS"].includes(r.direction))
    throw new CloudError("安全规则方向不正确", "VALIDATION_ERROR");
  const protocol = text(r.protocol, "协议", 8);
  if (protocol !== "all" && (!/^\d{1,3}$/.test(protocol) || Number(protocol) > 255))
    throw new CloudError("协议编号不正确", "VALIDATION_ERROR");
  const peer = text(r.peer, "来源或目标", 512),
    peerType = text(r.peerType ?? "CIDR_BLOCK", "地址类型", 32);
  if (
    !["CIDR_BLOCK", "SERVICE_CIDR_BLOCK", ...(nsg ? ["NETWORK_SECURITY_GROUP"] : [])].includes(
      peerType,
    )
  )
    throw new CloudError("地址类型不正确", "VALIDATION_ERROR");
  if (peerType === "CIDR_BLOCK") {
    const [address, prefix, extra] = peer.split("/");
    const family = isIP(address);
    if (
      !family ||
      extra !== undefined ||
      !/^\d{1,3}$/.test(prefix ?? "") ||
      Number(prefix) > (family === 4 ? 32 : 128)
    )
      throw new CloudError("请提供有效的 CIDR 网段", "VALIDATION_ERROR");
  }
  if (peerType === "NETWORK_SECURITY_GROUP") ocid(peer, "networksecuritygroup");
  const description = typeof r.description === "string" ? r.description.slice(0, 255) : "";
  const result: CloudDocument = {
    protocol,
    isStateless: r.stateless === true,
    ...(description.trim() ? { description } : {}),
    ...(nsg ? { direction: r.direction } : {}),
    ...(r.direction === "INGRESS"
      ? { source: peer, sourceType: peerType }
      : { destination: peer, destinationType: peerType }),
  };
  if (r.portMin !== undefined || r.portMax !== undefined) {
    if (!["6", "17"].includes(protocol))
      throw new CloudError("仅 TCP 或 UDP 可指定端口", "VALIDATION_ERROR");
    const min = numeric(r.portMin, "起始端口", 1, 65535, true),
      max = numeric(r.portMax ?? min, "结束端口", min, 65535, true);
    result[protocol === "6" ? "tcpOptions" : "udpOptions"] = { destinationPortRange: { min, max } };
  }
  if (r.icmpType !== undefined) {
    if (!["1", "58"].includes(protocol))
      throw new CloudError("仅 ICMP 可指定类型", "VALIDATION_ERROR");
    result.icmpOptions = {
      type: numeric(r.icmpType, "ICMP 类型", 0, 255, true),
      ...(r.icmpCode !== undefined ? { code: numeric(r.icmpCode, "ICMP 代码", 0, 255, true) } : {}),
    };
  }
  if (r.icmpCode !== undefined && r.icmpType === undefined)
    throw new CloudError("ICMP 代码需要同时指定类型", "VALIDATION_ERROR");
  return result;
}
export function securityListRuleId(
  direction: "INGRESS" | "EGRESS",
  index: number,
  raw: CloudDocument,
): string {
  return `${direction}:${index}:${digest(raw).slice(0, 24)}`;
}
