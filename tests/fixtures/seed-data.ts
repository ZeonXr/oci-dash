import type {
  AccountSummary,
  AuditEvent,
  InstanceSummary,
  JobEvent,
  JobSummary,
  MetricsResult,
  SecurityGroup,
} from "../../src/lib/contracts";

const createdAt = "2026-11-01T02:00:00.000Z";
const accountInfo = [
  ["Singapore Account", "ap-singapore-1"],
  ["Tokyo Account", "ap-tokyo-1"],
  ["Phoenix Account", "us-phoenix-1"],
  ["London Account", "uk-london-1"],
  ["Core Account", "ap-singapore-1"],
  ["Backup Account", "ap-singapore-1"],
];
export function fixtureAccounts(): AccountSummary[] {
  return accountInfo.map(([name, region], i) => ({
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    name,
    tenancyId: `ocid1.tenancy.oc1..fixture${i}`,
    userId: `ocid1.user.oc1..fixture${i}`,
    fingerprint: "00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00",
    homeRegion: region!,
    regions: i === 4 ? [region!, "ap-osaka-1"] : [region!],
    status: "connected",
    lastSyncAt: new Date().toISOString(),
    lastError: null,
    createdAt,
  }));
}
export function fixtureInstances(): InstanceSummary[] {
  const accounts = fixtureAccounts();
  const rows: [string, number, string, boolean, number, number, number][] = [
    ["SG-Oracle-02", 0, "ap-singapore-1", true, 1, 1, 50],
    ["JP-Oracle-02", 1, "ap-tokyo-1", true, 1, 1, 50],
    ["US-Oracle", 2, "us-phoenix-1", true, 1, 1, 50],
    ["UK-Oracle", 3, "uk-london-1", true, 1, 1, 50],
    ["SG-Production", 4, "ap-singapore-1", true, 2, 12, 100],
    ["JP-Oracle-01", 4, "ap-osaka-1", true, 4, 24, 200],
    ["US-Workspace", 2, "us-phoenix-1", true, 2, 12, 100],
    ["SG-Backup", 5, "ap-singapore-1", true, 1, 6, 50],
    ["JP-Standby", 1, "ap-tokyo-1", false, 1, 1, 50],
    ["UK-Standby", 3, "uk-london-1", false, 1, 1, 50],
  ];
  return rows.map(([name, a, region, running, ocpus, memoryGb, sizeGb], index) => {
    const account = accounts[a]!,
      id = `fixture-instance-${index + 1}`,
      vnicId = `fixture-vnic-${index + 1}`;
    return {
      id,
      accountId: account.id,
      accountName: account.name,
      displayName: name,
      region,
      availabilityDomain: `${region}:AD-1`,
      compartmentId: account.tenancyId,
      state: running ? "RUNNING" : "STOPPED",
      shape: memoryGb > 1 ? "VM.Standard.A1.Flex" : "VM.Standard.E2.1.Micro",
      ocpus,
      memoryGb,
      os: "Ubuntu 24.04 LTS",
      createdAt,
      tags: { environment: "fixture", role: running ? "production" : "standby" },
      syncedAt: new Date().toISOString(),
      vnics: [
        {
          id: vnicId,
          name: "Primary VNIC",
          primary: true,
          subnetId: "fixture-subnet",
          nsgIds: ["fixture-nsg"],
          ipv6: [],
          privateIps: [
            {
              privateIpId: `${vnicId}-private-primary`,
              privateIp: `10.0.0.${10 + index}`,
              isPrimary: true,
              vnicId,
              publicIpId: `${vnicId}-ephemeral`,
              publicIp: `198.51.100.${20 + index}`,
              lifetime: "EPHEMERAL",
              protected: false,
            },
            {
              privateIpId: `${vnicId}-private-secondary`,
              privateIp: `10.0.0.${100 + index}`,
              isPrimary: false,
              vnicId,
              publicIpId: `${vnicId}-reserved`,
              publicIp: `203.0.113.${24 + index * 8}`,
              lifetime: "RESERVED",
              protected: true,
            },
          ],
        },
      ],
      bootVolumes: [
        {
          id: `fixture-boot-${index + 1}`,
          accountId: account.id,
          region,
          name: `boot-${name.toLowerCase()}`,
          state: "AVAILABLE",
          sizeGb,
          vpusPerGb: 100,
          attachmentId: `fixture-attachment-${index + 1}`,
        },
      ],
      metrics: {
        cpuPercent: null,
        memoryPercent: null,
        receivedMbps: null,
        sentMbps: null,
      },
    };
  });
}
export function fixtureMetrics(range: "1h" | "24h" | "7d"): MetricsResult {
  const duration = range === "1h" ? 3600000 : range === "24h" ? 86400000 : 604800000,
    now = Date.now();
  return {
    source: "oci",
    intervalSeconds: range === "1h" ? 60 : range === "24h" ? 300 : 3600,
    available: true,
    note: "测试指标，不代表真实服务器状态",
    points: Array.from({ length: 24 }, (_, i) => ({
      timestamp: new Date(now - duration + (duration * i) / 23).toISOString(),
      cpu: Math.round(24 + Math.sin(i * 0.8) * 12),
      receivedBytes: Math.round((18 + Math.sin(i * 0.6) * 6) * 1024 ** 2),
      sentBytes: Math.round((32 + Math.cos(i * 0.5) * 10) * 1024 ** 2),
    })),
  };
}
export function fixtureJobs(): JobSummary[] {
  const accounts = fixtureAccounts();
  return ["SG-Oracle-02", "JP-Oracle-02", "UK-Oracle"].map((_, i) => ({
    id: `fixture-job-${i + 1}`,
    kind: i ? "instance-rename" : "sync-account",
    accountId: accounts[i]!.id,
    accountName: accounts[i]!.name,
    region: accounts[i]!.homeRegion,
    resourceId: `fixture-instance-${i + 1}`,
    state: "succeeded",
    attempt: 1,
    maxAttempts: 3,
    createdAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
    startedAt: new Date(Date.now() - (i + 1) * 3600000 + 1000).toISOString(),
    finishedAt: new Date(Date.now() - (i + 1) * 3600000 + 12000).toISOString(),
    nextRunAt: null,
    lastError: null,
    result: { message: "示例任务已完成" },
  }));
}
export function fixtureEvents(jobId: string): JobEvent[] {
  return ["任务已创建（测试）", "已检查资源状态（测试）", "操作完成（测试）"].map((message, i) => ({
    id: i + 1,
    jobId,
    level: "info",
    message,
    detail: null,
    createdAt: new Date(Date.now() - 60000 + i * 10000).toISOString(),
  }));
}
export const fixtureActivity = (): AuditEvent[] =>
  ["资源同步完成", "实例名称已更新", "启动卷配置已更新"].map((action, i) => ({
    id: i + 1,
    action,
    resource: ["SG-Oracle-02", "JP-Oracle-02", "UK-Oracle"][i]!,
    result: "测试记录",
    createdAt: new Date(Date.now() - (i + 1) * 600000).toISOString(),
  }));
export const fixtureSecurity = (): SecurityGroup[] => [
  {
    id: "fixture-nsg",
    name: "web-access",
    kind: "nsg",
    rules: [
      {
        id: "fixture-rule-1",
        direction: "INGRESS",
        protocol: "6",
        peer: "203.0.113.0/24",
        peerType: "CIDR_BLOCK",
        description: "管理员 SSH",
        stateless: false,
        portMin: 22,
        portMax: 22,
      },
      {
        id: "fixture-rule-2",
        direction: "INGRESS",
        protocol: "6",
        peer: "0.0.0.0/0",
        peerType: "CIDR_BLOCK",
        description: "HTTPS",
        stateless: false,
        portMin: 443,
        portMax: 443,
      },
    ],
  },
];
