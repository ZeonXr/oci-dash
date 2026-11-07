import type { AuditEvent, InstanceSummary, InventoryResult } from "@/lib/contracts";
import { getDatabase } from "./db";
import { AppError } from "./errors";

export function listInstances(): InstanceSummary[] {
  return (getDatabase().prepare("SELECT data FROM resources ORDER BY account_id,region,id").all() as { data: string }[]).map(row => JSON.parse(row.data) as InstanceSummary);
}
export function getInstance(id: string): InstanceSummary {
  const row = getDatabase().prepare("SELECT data FROM resources WHERE id=?").get(id) as { data: string } | undefined;
  if (!row) throw new AppError("实例不存在或尚未同步", 404, "INSTANCE_NOT_FOUND");
  return JSON.parse(row.data) as InstanceSummary;
}
export function saveInventory(accountId: string, result: InventoryResult): void {
  const db = getDatabase(), now = new Date().toISOString();
  db.transaction(() => {
    if (!result.warnings.length) db.prepare("DELETE FROM resources WHERE account_id=?").run(accountId);
    const upsert = db.prepare("INSERT INTO resources(id,account_id,region,data,synced_at) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,synced_at=excluded.synced_at,region=excluded.region");
    for (const instance of result.instances) upsert.run(instance.id, accountId, instance.region, JSON.stringify({ ...instance, accountId, syncedAt: instance.syncedAt || now }), now);
    db.prepare("UPDATE accounts SET last_sync_at=?,status=?,last_error=? WHERE id=?")
      .run(now, result.warnings.length ? "error" : "connected", result.warnings.length ? result.warnings.join("；").slice(0, 1200) : null, accountId);
  })();
}
export function recentActivity(limit = 30): AuditEvent[] {
  return getDatabase().prepare("SELECT id,action,resource,result,created_at as createdAt FROM audit_events ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.min(limit, 100))) as AuditEvent[];
}
