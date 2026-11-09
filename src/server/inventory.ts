import type {
  AuditEvent,
  InstanceSummary,
  InventoryDetailCoverage,
  InventoryResult,
} from "@/lib/contracts";
import { getDatabase } from "./db";
import { AppError } from "./errors";

interface StoredInstance {
  id: string;
  accountId: string;
  accountName: string;
  region: string;
  data: string;
}
const instanceColumns = "r.id,r.account_id AS accountId,r.region,r.data,a.name AS accountName";
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
  return (
    getDatabase()
      .prepare(
        `SELECT ${instanceColumns} FROM resources r JOIN accounts a ON a.id=r.account_id ORDER BY r.account_id,r.region,r.id`,
      )
      .all() as StoredInstance[]
  ).map(canonicalInstance);
}
export function getInstance(id: string): InstanceSummary {
  const row = getDatabase()
    .prepare(
      `SELECT ${instanceColumns} FROM resources r JOIN accounts a ON a.id=r.account_id WHERE r.id=?`,
    )
    .get(id) as StoredInstance | undefined;
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
    const account = db.prepare("SELECT name FROM accounts WHERE id=?").get(accountId) as
      { name: string } | undefined;
    if (!account) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
    const previous = new Map(
      (
        db
          .prepare(
            `SELECT ${instanceColumns} FROM resources r JOIN accounts a ON a.id=r.account_id WHERE r.account_id=?`,
          )
          .all(accountId) as StoredInstance[]
      ).map((row) => [row.id, canonicalInstance(row)]),
    );
    const owner = db.prepare(
      "SELECT r.account_id AS accountId,a.name FROM resources r JOIN accounts a ON a.id=r.account_id WHERE r.id=?",
    );
    for (const instance of result.instances) {
      const existing = owner.get(instance.id) as { accountId: string; name: string } | undefined;
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
    const remove = db.prepare("DELETE FROM resources WHERE id=? AND account_id=?");
    const retain = db.prepare("UPDATE resources SET data=? WHERE id=? AND account_id=?");
    let uncovered = 0;
    for (const old of previous.values()) {
      if (ids.has(old.id)) continue;
      if (
        completedRegions.has(old.region) ||
        completedScopes.has(JSON.stringify([old.region, old.compartmentId]))
      ) {
        remove.run(old.id, accountId);
        continue;
      }
      // Missing coverage cannot prove deletion. Keep the last snapshot and its
      // timestamp, but mark the whole instance (including its addresses) stale.
      const staleFields = [
        ...new Set(["实例状态", ...(old.staleFields ?? []), "网卡", "启动卷", "系统镜像"]),
      ];
      retain.run(JSON.stringify({ ...old, staleFields }), old.id, accountId);
      uncovered++;
    }
    const upsert = db.prepare(
      "INSERT INTO resources(id,account_id,region,data,synced_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,synced_at=excluded.synced_at,region=excluded.region WHERE resources.account_id=excluded.account_id",
    );
    for (const instance of result.instances) {
      const merged = mergeDetails(
        instance,
        previous.get(instance.id),
        result.details?.[instance.id],
        result.warnings.length > 0,
      );
      upsert.run(
        instance.id,
        accountId,
        instance.region,
        JSON.stringify({
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
        now,
      );
    }
    if (uncovered)
      coverageWarnings.push(
        `本轮未覆盖 ${uncovered} 个已有实例所在的区间或区域；已保留旧值并标记未更新。`,
      );
    const warnings = [...result.warnings, ...coverageWarnings];
    db.prepare("UPDATE accounts SET last_sync_at=?,status=?,last_error=? WHERE id=?").run(
      now,
      warnings.length ? "error" : "connected",
      warnings.length ? warnings.join("；").slice(0, 1200) : null,
      accountId,
    );
  }).immediate();
  // Publish coverage warnings only after commit; fresh detail merging above
  // must continue to use the warnings from the OCI read itself.
  for (const warning of coverageWarnings)
    if (!result.warnings.includes(warning)) result.warnings.push(warning);
}
export function recentActivity(limit = 30): AuditEvent[] {
  return getDatabase()
    .prepare(
      "SELECT id,action,resource,result,created_at as createdAt FROM audit_events ORDER BY id DESC LIMIT ?",
    )
    .all(Math.max(1, Math.min(limit, 100))) as AuditEvent[];
}
