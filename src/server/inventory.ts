import type {
  AuditEvent,
  InstanceSummary,
  InventoryDetailCoverage,
  InventoryResult,
} from "@/lib/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDatabase, getOrm } from "./db";
import { accounts, auditEvents, resources } from "./database/schema";
import { AppError } from "./errors";

type StoredInstance = Omit<typeof resources.$inferSelect, "syncedAt"> & { accountName: string };
const instanceColumns = {
  id: resources.id,
  accountId: resources.accountId,
  region: resources.region,
  data: resources.data,
  accountName: accounts.name,
};
function canonicalInstance(row: StoredInstance): InstanceSummary {
  const data = JSON.parse(row.data) as InstanceSummary;
  return {
    ...data,
    id: row.id,
    accountId: row.accountId,
    accountName: row.accountName,
    region: row.region,
    bootVolumes: data.bootVolumes.map((volume) => ({
      ...volume,
      accountId: row.accountId,
      region: row.region,
    })),
  };
}
export function listInstances(): InstanceSummary[] {
  return getOrm()
    .select(instanceColumns)
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .orderBy(resources.accountId, resources.region, resources.id)
    .all()
    .map(canonicalInstance);
}
export function getInstance(id: string): InstanceSummary {
  const row = getOrm()
    .select(instanceColumns)
    .from(resources)
    .innerJoin(accounts, eq(accounts.id, resources.accountId))
    .where(eq(resources.id, id))
    .get();
  if (!row) throw new AppError("实例不存在或尚未同步", 404, "INSTANCE_NOT_FOUND");
  return canonicalInstance(row);
}

function mergeDetails(
  incoming: InstanceSummary,
  previous: InstanceSummary | undefined,
  coverage: InventoryDetailCoverage | undefined,
  legacyPartial: boolean,
): InstanceSummary {
  if (!coverage) {
    if (legacyPartial && previous)
      return {
        ...incoming,
        vnics: previous.vnics,
        bootVolumes: previous.bootVolumes,
        os: previous.os,
        staleFields: ["网卡", "启动卷", "系统镜像"],
      };
    return { ...incoming, staleFields: undefined };
  }
  const stale = new Set<string>();
  const next = { ...incoming };
  if (!coverage.vnics) {
    next.vnics = previous?.vnics ?? incoming.vnics;
    stale.add("网卡");
  } else {
    const oldVnics = new Map(previous?.vnics.map((vnic) => [vnic.id, vnic]));
    next.vnics = incoming.vnics.map((vnic) => {
      const old = oldVnics.get(vnic.id);
      const read = coverage.vnicDetails[vnic.id];
      const updated = { ...vnic };
      if (!read?.privateIps) {
        updated.privateIps = old?.privateIps ?? vnic.privateIps;
        stale.add("私网 IP");
      } else {
        const oldIps = new Map(old?.privateIps.map((ip) => [ip.privateIpId, ip]));
        const complete = new Set(read.publicBindings);
        updated.privateIps = vnic.privateIps.map((ip) => {
          if (complete.has(ip.privateIpId)) return ip;
          stale.add("公网 IP");
          const prior = oldIps.get(ip.privateIpId);
          return prior
            ? {
                ...ip,
                publicIpId: prior.publicIpId,
                publicIp: prior.publicIp,
                lifetime: prior.lifetime,
                protected: prior.protected,
              }
            : ip;
        });
      }
      if (!read?.ipv6) {
        updated.ipv6 = old?.ipv6 ?? vnic.ipv6;
        stale.add("IPv6");
      }
      return updated;
    });
  }
  if (!coverage.bootVolumes) {
    next.bootVolumes = previous?.bootVolumes ?? incoming.bootVolumes;
    stale.add("启动卷");
  }
  if (!coverage.os) {
    next.os = previous?.os ?? incoming.os;
    stale.add("系统镜像");
  }
  next.staleFields = stale.size ? [...stale] : undefined;
  return next;
}
/** Persist the snapshot and publish missing-coverage warnings after the transaction succeeds. */
export function saveInventory(accountId: string, result: InventoryResult): void {
  const db = getDatabase(),
    now = new Date().toISOString();
  const coverageWarnings: string[] = [];
  db.transaction(() => {
    const orm = getOrm();
    const account = orm
      .select({ name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .get();
    if (!account) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
    const previous = new Map(
      orm
        .select(instanceColumns)
        .from(resources)
        .innerJoin(accounts, eq(accounts.id, resources.accountId))
        .where(eq(resources.accountId, accountId))
        .all()
        .map((row) => [row.id, canonicalInstance(row)]),
    );
    for (const instance of result.instances) {
      const existing = orm
        .select({ accountId: resources.accountId, name: accounts.name })
        .from(resources)
        .innerJoin(accounts, eq(accounts.id, resources.accountId))
        .where(eq(resources.id, instance.id))
        .get();
      if (existing && existing.accountId !== accountId)
        throw new AppError(
          `实例“${instance.displayName}”已归属账号“${existing.name}”，请在设置中处理重复租户配置后重新同步。`,
          409,
          "RESOURCE_ACCOUNT_CONFLICT",
        );
    }
    const ids = new Set(result.instances.map((instance) => instance.id));
    const completedRegions = new Set(
      result.completedScopes === undefined && !result.warnings.length ? result.regions : [],
    );
    const completedScopes = new Set(
      result.completedScopes?.map((scope) => JSON.stringify([scope.region, scope.compartmentId])),
    );
    let uncovered = 0;
    for (const old of previous.values()) {
      if (ids.has(old.id)) continue;
      if (
        completedRegions.has(old.region) ||
        completedScopes.has(JSON.stringify([old.region, old.compartmentId]))
      ) {
        orm
          .delete(resources)
          .where(and(eq(resources.id, old.id), eq(resources.accountId, accountId)))
          .run();
        continue;
      }
      // Missing coverage cannot prove deletion. Keep the last snapshot and its
      // timestamp, but mark the whole instance (including its addresses) stale.
      const staleFields = [
        ...new Set(["实例状态", ...(old.staleFields ?? []), "网卡", "启动卷", "系统镜像"]),
      ];
      orm
        .update(resources)
        .set({ data: JSON.stringify({ ...old, staleFields }) })
        .where(and(eq(resources.id, old.id), eq(resources.accountId, accountId)))
        .run();
      uncovered++;
    }
    for (const instance of result.instances) {
      const merged = mergeDetails(
        instance,
        previous.get(instance.id),
        result.details?.[instance.id],
        result.warnings.length > 0,
      );
      orm
        .insert(resources)
        .values({
          id: instance.id,
          accountId,
          region: instance.region,
          data: JSON.stringify({
            ...merged,
            accountId,
            accountName: account.name,
            bootVolumes: merged.bootVolumes.map((volume) => ({
              ...volume,
              accountId,
              region: instance.region,
            })),
            syncedAt: instance.syncedAt || now,
          }),
          syncedAt: now,
        })
        .onConflictDoUpdate({
          target: resources.id,
          set: {
            data: sql`excluded.data`,
            syncedAt: sql`excluded.synced_at`,
            region: sql`excluded.region`,
          },
          setWhere: eq(resources.accountId, sql`excluded.account_id`),
        })
        .run();
    }
    if (uncovered)
      coverageWarnings.push(
        `本轮未覆盖 ${uncovered} 个已有实例所在的区间或区域；已保留旧值并标记未更新。`,
      );
    const warnings = [...result.warnings, ...coverageWarnings];
    orm
      .update(accounts)
      .set({
        lastSyncAt: now,
        status: warnings.length ? "error" : "connected",
        lastError: warnings.length ? warnings.join("；").slice(0, 1200) : null,
      })
      .where(eq(accounts.id, accountId))
      .run();
  }).immediate();
  // Publish coverage warnings only after commit; fresh detail merging above
  // must continue to use the warnings from the OCI read itself.
  for (const warning of coverageWarnings)
    if (!result.warnings.includes(warning)) result.warnings.push(warning);
}
export function recentActivity(limit = 30): AuditEvent[] {
  return getOrm()
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      resource: auditEvents.resource,
      result: auditEvents.result,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .orderBy(desc(auditEvents.id))
    .limit(Math.max(1, Math.min(limit, 100)))
    .all();
}
