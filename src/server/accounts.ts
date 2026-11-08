import { randomUUID, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import type { AccountSummary } from "@/lib/contracts";
import type { OciCredentials } from "./oci/types";
import { getDatabase, audit } from "./db";
import { encryptSecret, decryptSecret } from "./crypto";
import { AppError } from "./errors";

export interface AccountInput {
  name: string;
  tenancyId: string;
  userId: string;
  fingerprint: string;
  homeRegion: string;
  regions: string[];
  privateKey: string;
}
export type AccountPatchInput = Partial<AccountInput> & { recoverConsoleCleanup?: boolean };
type AccountRecord = AccountSummary & { credential: string; revision: number };
type AccountRow = Omit<AccountRecord, "regions"> & { regions: string };
const accountColumns = `id,name,tenancy_id AS tenancyId,user_id AS userId,fingerprint,
  home_region AS homeRegion,regions,credential,status,last_sync_at AS lastSyncAt,
  last_error AS lastError,created_at AS createdAt,revision`;

function readAccount(row: AccountRow): AccountRecord {
  return { ...row, regions: JSON.parse(row.regions) as string[] };
}
function storedAccount(id: string): AccountRecord | undefined {
  const row = getDatabase().prepare(`SELECT ${accountColumns} FROM accounts WHERE id=?`).get(id) as
    AccountRow | undefined;
  return row && readAccount(row);
}
function publicAccount(row: AccountRecord): AccountSummary {
  const { credential: _secret, revision: _revision, ...rest } = row;
  return rest;
}
export function listAccounts(): AccountSummary[] {
  return (getDatabase().prepare(`SELECT ${accountColumns} FROM accounts`).all() as AccountRow[])
    .map(readAccount)
    .map(publicAccount);
}
export function getAccount(id: string): AccountSummary | null {
  const row = storedAccount(id);
  return row ? publicAccount(row) : null;
}
export function getCredentialSnapshot(
  id: string,
  region?: string,
): { credentials: OciCredentials; revision: number } {
  const row = storedAccount(id);
  if (!row) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
  const chosen = region || row.homeRegion;
  if (!row.regions.includes(chosen) && chosen !== row.homeRegion)
    throw new AppError("该账号未启用此区域", 400, "REGION_NOT_ENABLED");
  return {
    revision: row.revision,
    credentials: {
      tenancyId: row.tenancyId,
      userId: row.userId,
      fingerprint: row.fingerprint,
      privateKey: decryptSecret(row.credential),
      region: chosen,
    },
  };
}
export const getCredentials = (id: string, region?: string): OciCredentials =>
  getCredentialSnapshot(id, region).credentials;
function assertUniqueTenancy(tenancyId: string, exceptId?: string): void {
  const conflict = getDatabase()
    .prepare("SELECT id,name FROM accounts WHERE tenancy_id=? AND id<>? LIMIT 1")
    .get(tenancyId, exceptId ?? "") as { id: string; name: string } | undefined;
  if (conflict)
    throw new AppError(
      `此租户已配置在账号“${conflict.name}”中，请编辑该账号的区域或凭据，不要重复添加。`,
      409,
      "DUPLICATE_TENANCY",
    );
}
function assertAccountIdle(id: string): void {
  const db = getDatabase();
  if (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='console_sessions'")
      .get() &&
    db.prepare("SELECT id FROM console_sessions WHERE account_id=? AND slot=1").get(id)
  )
    throw new AppError("账号仍有控制台会话或清理任务，请先断开并等待清理完成", 409, "ACCOUNT_BUSY");
  assertAccountTasksIdle(id);
}
function assertAccountTasksIdle(id: string): void {
  const db = getDatabase();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'").get())
    return;
  if (
    db
      .prepare(
        "SELECT id FROM jobs WHERE account_id=? AND state IN ('queued','running','retrying','cancel_requested','interrupted') LIMIT 1",
      )
      .get(id)
  )
    throw new AppError("账号仍有未结束的任务，请先取消或等待任务结束", 409, "ACCOUNT_BUSY");
}
function assertConsoleCredentialRecovery(id: string): void {
  assertAccountTasksIdle(id);
  const db = getDatabase();
  const columns = db.prepare("PRAGMA table_info(console_sessions)").all() as { name: string }[];
  const ready =
    columns.some((column) => column.name === "credential_recovery_ready") &&
    db
      .prepare(
        "SELECT id FROM console_sessions WHERE account_id=? AND slot=1 AND state='failed' AND cleanup_pending=1 AND credential_recovery_ready=1",
      )
      .get(id);
  if (!ready)
    throw new AppError(
      "请先断开控制台，并等待当前清理请求结束后再恢复凭据；此操作仅适用于清理失败的会话",
      409,
      "CONSOLE_RECOVERY_NOT_READY",
    );
}
export function checkPrivateKey(privateKey: string, fingerprint: string): void {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("Unsupported key");
    const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
    const actual = createHash("md5").update(publicKey).digest("hex").match(/.{2}/g)!.join(":");
    if (actual.toLowerCase() !== fingerprint.toLowerCase())
      throw new AppError("私钥与指纹不匹配", 400, "KEY_FINGERPRINT_MISMATCH");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "请选择有效的 OCI RSA API 私钥（至少 2048 位、未加密 PEM）",
      400,
      "INVALID_PRIVATE_KEY",
    );
  }
}
export function createAccount(input: AccountInput, actor: string): AccountSummary {
  checkPrivateKey(input.privateKey, input.fingerprint);
  const id = randomUUID(),
    createdAt = new Date().toISOString();
  return getDatabase()
    .transaction(() => {
      assertUniqueTenancy(input.tenancyId);
      getDatabase()
        .prepare(
          `INSERT INTO accounts
          (id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,status,created_at)
          VALUES(@id,@name,@tenancyId,@userId,@fingerprint,@homeRegion,@regions,@credential,@status,@createdAt)`,
        )
        .run({
          id,
          name: input.name,
          tenancyId: input.tenancyId,
          userId: input.userId,
          fingerprint: input.fingerprint.toLowerCase(),
          homeRegion: input.homeRegion,
          regions: JSON.stringify([...new Set([input.homeRegion, ...input.regions])]),
          credential: encryptSecret(input.privateKey.trim()),
          status: "unchecked",
          createdAt,
        });
      audit(actor, "account.create", input.name, "账号配置已保存");
      return getAccount(id)!;
    })
    .immediate();
}
export function updateAccount(id: string, input: AccountPatchInput, actor: string): AccountSummary {
  const existing = storedAccount(id);
  if (!existing) throw new AppError("账号不存在", 404);
  const credentialChanged = !!input.privateKey;
  if (
    ((input.tenancyId && input.tenancyId !== existing.tenancyId) ||
      (input.userId && input.userId !== existing.userId) ||
      (input.fingerprint && input.fingerprint !== existing.fingerprint)) &&
    !credentialChanged
  )
    throw new AppError("修改身份或指纹时需要同时上传对应的私钥");
  if (input.privateKey)
    checkPrivateKey(input.privateKey, input.fingerprint ?? existing.fingerprint);
  const homeRegion = input.homeRegion ?? existing.homeRegion;
  const regions = [...new Set([homeRegion, ...(input.regions ?? existing.regions)])];
  const scopeChanged =
    credentialChanged ||
    homeRegion !== existing.homeRegion ||
    JSON.stringify([...regions].sort()) !== JSON.stringify([...existing.regions].sort());
  const recovering = input.recoverConsoleCleanup === true;
  if (
    recovering &&
    (!credentialChanged ||
      (input.tenancyId !== undefined && input.tenancyId !== existing.tenancyId) ||
      (input.userId !== undefined && input.userId !== existing.userId) ||
      homeRegion !== existing.homeRegion ||
      JSON.stringify([...regions].sort()) !== JSON.stringify([...existing.regions].sort()))
  )
    throw new AppError(
      "恢复控制台清理只能替换同一租户、同一用户的 API 密钥，不能修改区域范围",
      400,
      "CONSOLE_RECOVERY_SCOPE_MISMATCH",
    );
  const changes: Partial<AccountRecord> = {
    name: input.name ?? existing.name,
    homeRegion,
    regions,
  };
  if (credentialChanged)
    Object.assign(changes, {
      tenancyId: input.tenancyId ?? existing.tenancyId,
      userId: input.userId ?? existing.userId,
      fingerprint: (input.fingerprint ?? existing.fingerprint).toLowerCase(),
      credential: encryptSecret(input.privateKey!.trim()),
      status: "unchecked",
      lastError: null,
      lastSyncAt: null,
    });
  getDatabase()
    .transaction(() => {
      const current = storedAccount(id);
      if (!current || current.revision !== existing.revision)
        throw new AppError("账号配置已变更，请刷新后重试", 409, "ACCOUNT_CHANGED");
      if (input.tenancyId && input.tenancyId !== existing.tenancyId)
        assertUniqueTenancy(input.tenancyId, id);
      if (scopeChanged) {
        if (recovering) assertConsoleCredentialRecovery(id);
        else assertAccountIdle(id);
        changes.revision = existing.revision + 1;
      }
      const next = { ...current, ...changes };
      getDatabase()
        .prepare(
          `UPDATE accounts SET name=@name,tenancy_id=@tenancyId,user_id=@userId,
          fingerprint=@fingerprint,home_region=@homeRegion,regions=@regions,credential=@credential,
          status=@status,last_sync_at=@lastSyncAt,last_error=@lastError,revision=@revision WHERE id=@id`,
        )
        .run({ ...next, regions: JSON.stringify(next.regions) });
      if (recovering)
        getDatabase()
          .prepare(
            "UPDATE console_sessions SET credential_recovery_ready=0 WHERE account_id=? AND slot=1",
          )
          .run(id);
      else if (credentialChanged)
        getDatabase().prepare("DELETE FROM resources WHERE account_id=?").run(id);
      else if (scopeChanged)
        getDatabase()
          .prepare(
            `DELETE FROM resources WHERE account_id=? AND region NOT IN (${regions.map(() => "?").join(",")})`,
          )
          .run(id, ...regions);
    })
    .immediate();
  audit(
    actor,
    recovering ? "account.console-credential-recovery" : "account.update",
    existing.name,
    recovering ? "同一 OCI 身份的恢复凭据已保存，控制台仍等待验证清理" : "账号配置已更新",
  );
  return getAccount(id)!;
}
export function deleteAccount(id: string, actor: string): void {
  const account = getAccount(id);
  if (!account) throw new AppError("账号不存在", 404);
  const db = getDatabase();
  db.transaction(() => {
    assertAccountIdle(id);
    db.prepare("DELETE FROM accounts WHERE id=?").run(id);
  }).immediate();
  audit(actor, "account.delete", account.name, "已移除本地配置，云资源未删除");
}
export function setAccountStatus(
  id: string,
  status: AccountSummary["status"],
  error: string | null,
  expectedRevision: number,
): boolean {
  return (
    getDatabase()
      .prepare("UPDATE accounts SET status=?,last_error=? WHERE id=? AND revision=?")
      .run(status, error, id, expectedRevision).changes === 1
  );
}
