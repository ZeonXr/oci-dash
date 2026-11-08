import type {
  AccountSummary,
  CreateOptions,
  CreateOptionsSelection,
  InstanceSummary,
  InventoryDetailCoverage,
  InventoryResult,
  MetricPoint,
  MetricsResult,
  SecurityGroup,
  VnicSummary,
} from "@/lib/contracts";
import { CloudError, type ExecutionContext, type OciCredentials } from "./types";
import { mapInventory, type InventoryImageReader } from "./inventory-performance";
import {
  allPages,
  cloudError,
  invoke,
  optionalGet,
  type CloudDocument,
  type OciClients,
} from "./sdk";
import {
  compartments,
  iso,
  ocid,
  protectedPublicIp,
  requireCompartment,
  ruleFromCloud,
  securityListRuleId,
} from "./helpers";

export async function verifyAccount(clients: OciClients, credentials: OciCredentials) {
  const tenancyId = ocid(credentials.tenancyId, "tenancy", "租户 ID");
  ocid(credentials.userId, "user", "用户 ID");
  const [tenancyResponse, regions] = await Promise.all([
    invoke(clients.identity, "getTenancy", { tenancyId }),
    allPages(clients.identity, "listRegionSubscriptions", { tenancyId }),
  ]);
  const tenancy = tenancyResponse.tenancy;
  if (!tenancy || tenancy.id !== tenancyId)
    throw new CloudError("OCI 返回的租户身份不一致", "RESOURCE_MISMATCH");
  const ready = regions.filter((region) => region.status === "READY");
  return {
    tenancyName: tenancy.name ?? tenancyId,
    homeRegion: ready.find((region) => region.isHomeRegion)?.regionName ?? credentials.region,
    regions: ready.map((region) => region.regionName),
  };
}

export async function attachedVnics(
  clients: OciClients,
  instance: CloudDocument,
  context?: ExecutionContext,
): Promise<CloudDocument[]> {
  const attachments = await allPages(
    clients.compute,
    "listVnicAttachments",
    { compartmentId: instance.compartmentId, instanceId: instance.id },
    context,
  );
  const result: CloudDocument[] = [];
  for (const attachment of attachments.filter((a) => a.lifecycleState === "ATTACHED")) {
    if (attachment.instanceId && attachment.instanceId !== instance.id)
      throw new CloudError("网卡挂载不属于所选实例", "RESOURCE_MISMATCH");
    const { vnic } = await invoke(
      clients.network,
      "getVnic",
      { vnicId: attachment.vnicId },
      context,
    );
    if (!vnic || vnic.id !== attachment.vnicId)
      throw new CloudError("网卡读取结果不一致", "RESOURCE_MISMATCH");
    result.push(vnic);
  }
  return result;
}

export async function getPublicBinding(
  clients: OciClients,
  privateIpId: string,
  context?: ExecutionContext,
): Promise<CloudDocument | null> {
  const response = await optionalGet(
    clients.network,
    "getPublicIpByPrivateIpId",
    { getPublicIpByPrivateIpIdDetails: { privateIpId } },
    context,
  );
  const ip = response?.publicIp ?? null;
  if (ip && ip.privateIpId !== privateIpId)
    throw new CloudError("公网 IP 绑定已发生变化", "RESOURCE_MISMATCH");
  return ip;
}

export async function inventoryRegion(
  clients: OciClients,
  credentials: OciCredentials,
  account: AccountSummary,
  region: string,
  context?: ExecutionContext,
  imageReader?: InventoryImageReader,
): Promise<InventoryResult & { successfulLists: number }> {
  const accessible = await compartments(clients, credentials, context);
  const instances: InstanceSummary[] = [],
    warnings: string[] = [];
  const completedScopes: NonNullable<InventoryResult["completedScopes"]> = [];
  const details: NonNullable<InventoryResult["details"]> = {};
  let successfulLists = 0;
  const warning = (subject: string, error: unknown) => {
    if (error instanceof CloudError && error.code === "CANCELLED") throw error;
    return `${region} / ${subject}：${cloudError(error).message}`;
  };
  for (const compartment of accessible) {
    let rawInstances: CloudDocument[];
    try {
      rawInstances = await allPages(
        clients.compute,
        "listInstances",
        { compartmentId: compartment.id },
        context,
      );
      for (const instance of rawInstances) {
        ocid(instance.id, "instance");
        if (instance.compartmentId !== compartment.id)
          throw new CloudError("实例清单包含其他区间的资源", "RESOURCE_MISMATCH");
      }
      successfulLists++;
      completedScopes.push({ region, compartmentId: compartment.id });
    } catch (error) {
      if (error instanceof CloudError && error.code === "CANCELLED") throw error;
      warnings.push(warning(compartment.name, error));
      continue;
    }
    const found = await mapInventory(
      rawInstances.filter((i) => i.lifecycleState !== "TERMINATED"),
      2,
      async (raw) => {
        const row: InstanceSummary = {
          id: raw.id,
          accountId: account.id,
          accountName: account.name,
          displayName: raw.displayName ?? raw.id,
          region,
          availabilityDomain: raw.availabilityDomain,
          compartmentId: raw.compartmentId,
          state: raw.lifecycleState,
          shape: raw.shape,
          ocpus: Number(raw.shapeConfig?.ocpus ?? 0),
          memoryGb: Number(raw.shapeConfig?.memoryInGBs ?? 0),
          os: "未知",
          createdAt: iso(raw.timeCreated),
          vnics: [],
          bootVolumes: [],
          tags: Object.fromEntries(
            Object.entries(raw.freeformTags ?? {}).filter(
              ([key, value]) =>
                typeof value === "string" &&
                !/password|secret|token|credential|private.?key|api.?key/i.test(key),
            ),
          ) as Record<string, string>,
          syncedAt: new Date().toISOString(),
          metrics: { cpuPercent: null, memoryPercent: null, receivedMbps: null, sentMbps: null },
        };
        const coverage: InventoryDetailCoverage = {
          vnics: false,
          bootVolumes: false,
          os: !raw.imageId,
          vnicDetails: {},
        };
        const detailWarnings: string[][] = [[], [], []];
        const warn = (part: number, subject: string, error: unknown) =>
          detailWarnings[part].push(warning(subject, error));
        await mapInventory(
          [
            async () => {
              try {
                const vnics = await attachedVnics(clients, raw, context);
                coverage.vnics = true;
                for (const vnic of vnics) {
                  const summary: VnicSummary = {
                    id: vnic.id,
                    name: vnic.displayName ?? vnic.id,
                    primary: Boolean(vnic.isPrimary),
                    subnetId: vnic.subnetId,
                    nsgIds: vnic.nsgIds ?? [],
                    privateIps: [],
                    ipv6: [],
                  };
                  row.vnics.push(summary);
                  const vnicCoverage: InventoryDetailCoverage["vnicDetails"][string] = {
                    privateIps: false,
                    ipv6: false,
                    publicBindings: [],
                  };
                  coverage.vnicDetails[vnic.id] = vnicCoverage;
                  const ipWarnings: string[] = [],
                    ipv6Warnings: string[] = [];
                  await mapInventory(
                    [
                      async () => {
                        try {
                          const privateIps = await allPages(
                            clients.network,
                            "listPrivateIps",
                            { vnicId: vnic.id },
                            context,
                          );
                          const bindings = await mapInventory(
                            privateIps,
                            2,
                            async (ip) => {
                              let publicIp: CloudDocument | null = null;
                              let read = false,
                                errorMessage: string | undefined;
                              try {
                                publicIp = await getPublicBinding(clients, ip.id, context);
                                read = true;
                              } catch (error) {
                                errorMessage = warning(`${row.displayName} 公网 IP`, error);
                              }
                              return {
                                read,
                                errorMessage,
                                binding: {
                                  privateIpId: ip.id,
                                  privateIp: ip.ipAddress,
                                  isPrimary: Boolean(ip.isPrimary),
                                  vnicId: vnic.id,
                                  ...(publicIp
                                    ? {
                                        publicIpId: publicIp.id,
                                        publicIp: publicIp.ipAddress,
                                        lifetime: publicIp.lifetime,
                                      }
                                    : {}),
                                  protected: publicIp ? protectedPublicIp(publicIp) : true,
                                },
                              };
                            },
                            context?.signal,
                          );
                          summary.privateIps = bindings.map((item) => item.binding);
                          for (const item of bindings) {
                            if (item.read)
                              vnicCoverage.publicBindings.push(item.binding.privateIpId);
                            if (item.errorMessage) ipWarnings.push(item.errorMessage);
                          }
                          vnicCoverage.privateIps = true;
                        } catch (error) {
                          ipWarnings.push(warning(`${row.displayName} 私网 IP`, error));
                        }
                      },
                      async () => {
                        try {
                          summary.ipv6 = (
                            await allPages(
                              clients.network,
                              "listIpv6s",
                              { vnicId: vnic.id },
                              context,
                            )
                          ).map((ip) => ip.ipAddress);
                          vnicCoverage.ipv6 = true;
                        } catch (error) {
                          ipv6Warnings.push(warning(`${row.displayName} IPv6`, error));
                        }
                      },
                    ],
                    2,
                    (read) => read(),
                    context?.signal,
                  );
                  detailWarnings[0].push(...ipWarnings, ...ipv6Warnings);
                }
              } catch (error) {
                warn(0, `${row.displayName} 网卡`, error);
              }
            },
            async () => {
              try {
                const attachments = await allPages(
                  clients.compute,
                  "listBootVolumeAttachments",
                  {
                    compartmentId: raw.compartmentId,
                    availabilityDomain: raw.availabilityDomain,
                    instanceId: raw.id,
                  },
                  context,
                );
                for (const attachment of attachments.filter(
                  (a) => a.lifecycleState === "ATTACHED",
                )) {
                  const { bootVolume } = await invoke(
                    clients.storage,
                    "getBootVolume",
                    { bootVolumeId: attachment.bootVolumeId },
                    context,
                  );
                  row.bootVolumes.push({
                    id: bootVolume.id,
                    accountId: account.id,
                    region,
                    name: bootVolume.displayName ?? bootVolume.id,
                    state: bootVolume.lifecycleState,
                    sizeGb: Number(bootVolume.sizeInGBs),
                    vpusPerGb: Number(bootVolume.vpusPerGB),
                    attachmentId: attachment.id,
                  });
                }
                coverage.bootVolumes = true;
              } catch (error) {
                warn(1, `${row.displayName} 启动卷`, error);
              }
            },
            async () => {
              if (raw.imageId) {
                try {
                  if (imageReader) row.os = await imageReader(raw.imageId);
                  else {
                    const { image } = await invoke(
                      clients.compute,
                      "getImage",
                      { imageId: raw.imageId },
                      context,
                    );
                    row.os =
                      [image.operatingSystem, image.operatingSystemVersion]
                        .filter(Boolean)
                        .join(" ") ||
                      image.displayName ||
                      "未知";
                  }
                  coverage.os = true;
                } catch (error) {
                  warn(2, `${row.displayName} 系统镜像`, error);
                }
              }
            },
          ],
          3,
          (read) => read(),
          context?.signal,
        );
        return { row, coverage, warnings: detailWarnings.flat() };
      },
      context?.signal,
    );
    for (const item of found) {
      instances.push(item.row);
      details[item.row.id] = item.coverage;
      warnings.push(...item.warnings);
    }
    await context?.progress(`已同步 ${region} / ${compartment.name}`, {
      instances: instances.length,
    });
  }
  return {
    instances,
    warnings,
    regions: [region],
    successfulLists,
    completedScopes,
    details,
  };
}

export async function getCreateOptions(
  clients: OciClients,
  credentials: OciCredentials,
  requestedCompartment?: string,
  requested: CreateOptionsSelection = {},
): Promise<CreateOptions> {
  const available = await compartments(clients, credentials);
  const compartmentId = requestedCompartment ?? credentials.tenancyId;
  requireCompartment(compartmentId, available);
  const [domains, subnets] = await Promise.all([
    allPages(clients.identity, "listAvailabilityDomains", { compartmentId: credentials.tenancyId }),
    allPages(clients.network, "listSubnets", { compartmentId, lifecycleState: "AVAILABLE" }),
  ]);
  const availabilityDomains = domains.map((domain) => domain.name as string);
  const availabilityDomain = requested.availabilityDomain ?? availabilityDomains[0] ?? "";
  if (availabilityDomain && !availabilityDomains.includes(availabilityDomain))
    throw new CloudError("该区域不存在所选可用域", "VALIDATION_ERROR");
  const shapes = availabilityDomain
    ? await allPages(clients.compute, "listShapes", { compartmentId, availabilityDomain })
    : [];
  const shape = requested.shape ?? shapes[0]?.shape ?? "";
  if (shape && !shapes.some((candidate) => candidate.shape === shape))
    throw new CloudError("该可用域不支持所选实例规格", "VALIDATION_ERROR");
  const images = shape
    ? await allPages(clients.compute, "listImages", {
        compartmentId,
        shape,
        lifecycleState: "AVAILABLE",
        sortBy: "TIMECREATED",
        sortOrder: "DESC",
      })
    : [];
  return {
    selection: { compartmentId, availabilityDomain, shape },
    availabilityDomains,
    compartments: available,
    shapes: [...new Map(shapes.map((s) => [s.shape, s])).values()].map((s) => ({
      name: s.shape,
      ocpus: Number(s.ocpus ?? 0),
      memoryGb: Number(s.memoryInGBs ?? 0),
      flexible: Boolean(s.isFlexible),
      minOcpus: s.ocpuOptions?.min,
      maxOcpus: s.ocpuOptions?.max,
      minMemoryGb: s.memoryOptions?.minInGBs,
      maxMemoryGb: s.memoryOptions?.maxInGBs,
    })),
    images: images.map((i) => ({
      id: i.id,
      name: i.displayName ?? `${i.operatingSystem} ${i.operatingSystemVersion}`,
    })),
    subnets: subnets
      .filter(
        (subnet) => !subnet.availabilityDomain || subnet.availabilityDomain === availabilityDomain,
      )
      .map((s) => ({ id: s.id, name: `${s.displayName ?? s.id} (${s.cidrBlock})` })),
  };
}

export async function getSecurityGroups(
  clients: OciClients,
  credentials: OciCredentials,
  snapshot: InstanceSummary,
): Promise<SecurityGroup[]> {
  const { instance } = await invoke(clients.compute, "getInstance", {
    instanceId: ocid(snapshot.id, "instance"),
  });
  requireCompartment(instance.compartmentId, await compartments(clients, credentials));
  const vnics = await attachedVnics(clients, instance);
  const nsgIds = [...new Set<string>(vnics.flatMap((v) => v.nsgIds ?? []))];
  const securityListIds = new Set<string>();
  for (const subnetId of new Set(vnics.map((v) => v.subnetId))) {
    const { subnet } = await invoke(clients.network, "getSubnet", { subnetId });
    for (const id of subnet.securityListIds ?? []) securityListIds.add(id);
  }
  const groups: SecurityGroup[] = [];
  for (const id of nsgIds) {
    const { networkSecurityGroup: nsg, etag } = await invoke(
      clients.network,
      "getNetworkSecurityGroup",
      { networkSecurityGroupId: id },
    );
    const rules = await allPages(clients.network, "listNetworkSecurityGroupSecurityRules", {
      networkSecurityGroupId: id,
    });
    groups.push({
      id,
      name: nsg.displayName ?? id,
      kind: "nsg",
      etag,
      rules: rules.map((r) => ruleFromCloud(r, r.direction)),
    });
  }
  for (const id of securityListIds) {
    const { securityList: list, etag } = await invoke(clients.network, "getSecurityList", {
      securityListId: id,
    });
    groups.push({
      id,
      name: list.displayName ?? id,
      kind: "security-list",
      etag,
      rules: [
        ...(list.ingressSecurityRules ?? []).map((r: CloudDocument, index: number) =>
          ruleFromCloud(r, "INGRESS", securityListRuleId("INGRESS", index, r)),
        ),
        ...(list.egressSecurityRules ?? []).map((r: CloudDocument, index: number) =>
          ruleFromCloud(r, "EGRESS", securityListRuleId("EGRESS", index, r)),
        ),
      ],
    });
  }
  return groups;
}

export async function getMetrics(
  clients: OciClients,
  credentials: OciCredentials,
  snapshot: InstanceSummary,
  range: "1h" | "24h" | "7d",
  now: number,
  signal?: AbortSignal,
): Promise<MetricsResult> {
  const [response, available] = await Promise.allSettled([
    invoke(clients.compute, "getInstance", { instanceId: ocid(snapshot.id, "instance") }),
    compartments(clients, credentials),
  ]);
  if (response.status === "rejected") throw response.reason;
  if (available.status === "rejected") throw available.reason;
  const instance = response.value.instance;
  if (!instance || instance.id !== snapshot.id)
    throw new CloudError("实例监控归属不一致", "RESOURCE_MISMATCH");
  requireCompartment(instance.compartmentId, available.value);
  const duration = { "1h": 3600000, "24h": 86400000, "7d": 604800000 }[range];
  if (!duration) throw new CloudError("指标时间范围不正确", "VALIDATION_ERROR");
  const interval = range === "1h" ? "1m" : range === "24h" ? "5m" : "1h";
  const intervalSeconds = range === "1h" ? 60 : range === "24h" ? 300 : 3600;
  const points = new Map<string, MetricPoint>();
  const networkCoverage = new Map<string, { receivedBytes: Set<string>; sentBytes: Set<string> }>();
  const notes = new Set<string>();
  const collect = async (
    namespace: string,
    metric: string,
    id: string,
    field: "cpu" | "receivedBytes" | "sentBytes",
    compartmentId: string,
    additive = false,
  ): Promise<number> => {
    try {
      ocid(id, field === "cpu" ? "instance" : ["instance", "vnic"]);
      const response = await invoke(clients.monitoring, "summarizeMetricsData", {
        compartmentId,
        summarizeMetricsDataDetails: {
          namespace,
          query: `${metric}[${interval}]{resourceId = "${id}"}.${field === "cpu" ? "mean" : "sum"}()`,
          startTime: new Date(now - duration),
          endTime: new Date(now),
          resolution: interval,
        },
      });
      let count = 0;
      for (const series of response.items ?? [])
        for (const sample of series.aggregatedDatapoints ?? []) {
          const timestamp = iso(sample.timestamp);
          if (!timestamp || typeof sample.value !== "number" || !Number.isFinite(sample.value))
            continue;
          const point = points.get(timestamp) ?? {
            timestamp,
            cpu: null,
            receivedBytes: null,
            sentBytes: null,
          };
          point[field] = additive ? (point[field] ?? 0) + sample.value : sample.value;
          points.set(timestamp, point);
          if (field !== "cpu") {
            const coverage = networkCoverage.get(timestamp) ?? {
              receivedBytes: new Set<string>(),
              sentBytes: new Set<string>(),
            };
            coverage[field].add(id);
            networkCoverage.set(timestamp, coverage);
          }
          count++;
        }
      return count;
    } catch {
      if (signal?.aborted) throw new CloudError("指标查询已取消", "CANCELLED");
      notes.add("部分 OCI 指标不可读或尚未提供数据");
      return 0;
    }
  };
  // VNIC counters come from OCI networking; no host agent or fabricated memory percentage is needed.
  const vnics = await attachedVnics(clients, instance);
  await mapInventory(
    [
      async () => {
        const count = await collect(
          "oci_computeagent",
          "CpuUtilization",
          instance.id,
          "cpu",
          instance.compartmentId,
        );
        if (!count) notes.add("CPU 指标需要实例的 OCI 监控代理提供数据");
      },
      ...vnics.flatMap((vnic) => [
        () =>
          collect(
            "oci_vcn",
            "VnicFromNetworkBytes",
            vnic.id,
            "receivedBytes",
            vnic.compartmentId ?? instance.compartmentId,
            true,
          ),
        () =>
          collect(
            "oci_vcn",
            "VnicToNetworkBytes",
            vnic.id,
            "sentBytes",
            vnic.compartmentId ?? instance.compartmentId,
            true,
          ),
      ]),
    ],
    4,
    async (read) => {
      await read();
    },
    signal,
  );
  for (const point of points.values()) {
    const coverage = networkCoverage.get(point.timestamp);
    for (const field of ["receivedBytes", "sentBytes"] as const) {
      if (point[field] !== null && coverage?.[field].size !== vnics.length) {
        point[field] = null;
        notes.add("部分网卡采样缺失，未将不完整的网络合计视作完整流量");
      }
    }
  }
  return {
    intervalSeconds,
    points: [...points.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
    available: points.size > 0,
    source: "oci",
    ...(notes.size || !points.size
      ? {
          note: [
            ...notes,
            ...(!points.size ? ["此时间段无可用数据，未将缺失指标视作零"] : []),
          ].join("；"),
        }
      : {}),
  };
}
