import { z } from "zod";
import type { OperationRequest } from "@/lib/contracts";
import { AppError } from "./errors";

export const regionSchema = z
  .string()
  .min(4)
  .max(80)
  .regex(/^[a-z][a-z0-9-]+-\d+$/, "区域名称不正确");
const ocid = (kind: string) =>
  z
    .string()
    .min(15)
    .max(512)
    .regex(new RegExp(`^ocid1\\.${kind}\\.[A-Za-z0-9._-]+$`), `需要有效的 ${kind} OCID`);
export const accountSchema = z.object({
  name: z.string().trim().max(80).optional(),
  tenancyId: ocid("tenancy"),
  userId: ocid("user"),
  fingerprint: z.string().regex(/^(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2}$/, "指纹格式不正确"),
  homeRegion: regionSchema,
  regions: z.array(regionSchema).max(100).default([]),
  privateKey: z.string().min(100, "请选择 API 私钥文件").max(32768),
});
export const accountPatchSchema = accountSchema.partial().extend({
  regions: z.array(regionSchema).max(100).optional(),
  recoverConsoleCleanup: z.boolean().optional(),
});
const port = z.number().int().min(1).max(65535);
const securityRuleSchema = z
  .object({
    direction: z.enum(["INGRESS", "EGRESS"]),
    protocol: z.enum(["all", "6", "17", "1", "58"]),
    peer: z.string().min(1).max(512),
    peerType: z
      .enum(["CIDR_BLOCK", "NETWORK_SECURITY_GROUP", "SERVICE_CIDR_BLOCK"])
      .default("CIDR_BLOCK"),
    description: z.string().max(256).default(""),
    stateless: z.boolean().default(false),
    portMin: port.optional(),
    portMax: port.optional(),
    icmpType: z.number().int().min(0).max(255).optional(),
    icmpCode: z.number().int().min(0).max(255).optional(),
  })
  .refine((v) => !(v.portMin && v.portMax && v.portMin > v.portMax), "端口范围不正确");
const preconditions = {
  expectedState: z.string().max(40).optional(),
  etag: z.string().max(512).optional(),
};
const payloads = {
  "sync-account": z.object({}),
  "instance-start": z.object(preconditions).strict(),
  "instance-stop": z.object(preconditions).strict(),
  "instance-reboot": z.object(preconditions).strict(),
  "instance-terminate": z.object({
    ...preconditions,
    preserveBootVolume: z.boolean().default(true),
    preserveDataVolumes: z.boolean().default(true),
  }),
  "instance-rename": z.object({ ...preconditions, displayName: z.string().trim().min(1).max(255) }),
  "instance-create": z.object({
    displayName: z.string().trim().min(1).max(255),
    compartmentId: z.string().min(15).max(512),
    availabilityDomain: z.string().min(1).max(100),
    shape: z.string().min(1).max(120),
    imageId: ocid("image"),
    subnetId: ocid("subnet"),
    ocpus: z.number().positive().max(128).optional(),
    memoryGb: z.number().positive().max(2048).optional(),
    bootVolumeSizeGb: z.number().int().min(50).max(32768).default(50),
    sshPublicKey: z
      .string()
      .trim()
      .min(50)
      .max(16384)
      .regex(
        /^(ssh-(rsa|ed25519)|ecdsa-sha2-nistp\d+) [A-Za-z0-9+/=]+(?: .*)?$/,
        "请输入 SSH 公钥，不是私钥",
      ),
    assignPublicIp: z.boolean().default(true),
  }),
  "public-ip-rotate": z.object({
    vnicId: ocid("vnic"),
    privateIpId: ocid("privateip"),
    expectedPublicIpId: ocid("publicip"),
    expectedPublicIp: z.string().max(50).optional(),
  }),
  "boot-volume-update": z.object({
    bootVolumeId: ocid("bootvolume"),
    sizeGb: z.number().int().min(1).max(32768),
    vpusPerGb: z
      .number()
      .int()
      .min(0)
      .max(120)
      .refine((v) => v % 10 === 0, "VPU 需为 10 的倍数"),
    etag: z.string().max(512).optional(),
  }),
  "security-rule-add": z.object({
    groupId: z.string().min(15).max(512),
    groupKind: z.enum(["nsg", "security-list"]),
    etag: z.string().max(512).optional(),
    rule: securityRuleSchema,
  }),
  "security-rule-delete": z.object({
    groupId: z.string().min(15).max(512),
    groupKind: z.enum(["nsg", "security-list"]),
    etag: z.string().max(512).optional(),
    ruleId: z.string().min(1).max(512),
  }),
  "ipv6-assign": z.object({
    vnicId: ocid("vnic"),
    subnetId: ocid("subnet").optional(),
    ipv6SubnetCidr: z.string().max(80).optional(),
  }),
};
export function validateOperation(value: unknown): OperationRequest {
  const base = z
    .object({
      kind: z.enum(Object.keys(payloads) as [keyof typeof payloads, ...(keyof typeof payloads)[]]),
      accountId: z.string().uuid(),
      region: regionSchema,
      resourceId: ocid("instance").optional(),
      payload: z.record(z.string(), z.unknown()).default({}),
      confirmation: z.string().max(255).optional(),
      idempotencyKey: z.string().min(8).max(120).optional(),
    })
    .parse(value);
  if (!["sync-account", "instance-create"].includes(base.kind) && !base.resourceId)
    throw new AppError("请选择操作实例");
  return { ...base, payload: payloads[base.kind].parse(base.payload) };
}
