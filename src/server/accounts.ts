import { randomUUID, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import type { AccountSummary } from "@/lib/contracts";
import type { OciCredentials } from "./oci/types";
import { getDatabase, getOrm, audit } from "./db";
import { accounts, consoleSessions, jobs, resources } from "./database/schema";
import { encryptSecret, decryptSecret } from "./crypto";
import { AppError } from "./errors";

export interface AccountInput {
  name?: string;
  tenancyId: string;
  userId: string;
  fingerprint: string;
  homeRegion: string;
  regions: string[];
  privateKey: string;
}
export type AccountPatchInput = Partial<AccountInput> & { recoverConsoleCleanup?: boolean };
type AccountRow = typeof accounts.$inferSelect;
type AccountRecord = Omit<AccountRow, "regions"> & { regions: string[] };

function readAccount(row: AccountRow): AccountRecord {
  return { ...row, regions: JSON.parse(row.regions) as string[] };
}
function storedAccount(id: string): AccountRecord | undefined {
  const row = getOrm().select().from(accounts).where(eq(accounts.id, id)).get();
  return row && readAccount(row);
}
function publicAccount(row: AccountRecord): AccountSummary {
  const { credential: _secret, revision: _revision, ...rest } = row;
  return rest;
}
export function listAccounts(): AccountSummary[] {
  return getOrm().select().from(accounts).all().map(readAccount).map(publicAccount);
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
  const conflict = getOrm()
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.tenancyId, tenancyId), ne(accounts.id, exceptId ?? "")))
    .get();
  if (conflict)
    throw new AppError(
      `此租户已配置在账号“${conflict.name}”中，请编辑该账号的区域或凭据，不要重复添加。`,
      409,
      "DUPLICATE_TENANCY",
    );
}
function assertAccountIdle(id: string): void {
  if (
    getOrm()
      .select({ id: consoleSessions.id })
      .from(consoleSessions)
      .where(and(eq(consoleSessions.accountId, id), eq(consoleSessions.slot, 1)))
      .get()
  )
    throw new AppError("账号仍有控制台会话或清理任务，请先断开并等待清理完成", 409, "ACCOUNT_BUSY");
  assertAccountTasksIdle(id);
}
function assertAccountTasksIdle(id: string): void {
  if (
    getOrm()
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.accountId, id),
          inArray(jobs.state, ["queued", "running", "retrying", "cancel_requested", "interrupted"]),
        ),
      )
      .get()
  )
    throw new AppError("账号仍有未结束的任务，请先取消或等待任务结束", 409, "ACCOUNT_BUSY");
}
function assertConsoleCredentialRecovery(id: string): void {
  assertAccountTasksIdle(id);
  const ready = getOrm()
    .select({ id: consoleSessions.id })
    .from(consoleSessions)
    .where(
      and(
        eq(consoleSessions.accountId, id),
        eq(consoleSessions.slot, 1),
        eq(consoleSessions.state, "failed"),
        eq(consoleSessions.cleanupPending, 1),
        eq(consoleSessions.credentialRecoveryReady, 1),
      ),
    )
    .get();
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
    createdAt = new Date().toISOString(),
    customName = input.name?.trim(),
    name = customName || `OCI-${input.tenancyId.slice(-8)}`;
  return getDatabase()
    .transaction(() => {
      assertUniqueTenancy(input.tenancyId);
      getOrm()
        .insert(accounts)
        .values({
          id,
          name,
          nameSource: customName ? "custom" : "pending",
          tenancyId: input.tenancyId,
          userId: input.userId,
          fingerprint: input.fingerprint.toLowerCase(),
          homeRegion: input.homeRegion,
          regions: JSON.stringify([...new Set([input.homeRegion, ...input.regions])]),
          credential: encryptSecret(input.privateKey.trim()),
          status: "unchecked",
          createdAt,
        })
        .run();
      audit(actor, "account.create", name, "账号配置已保存");
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
      if (input.name !== undefined) {
        const customName = input.name.trim();
        if (customName) {
          changes.name = customName;
          changes.nameSource = "custom";
        } else if (current.nameSource === "custom") {
          // A running sync may already have skipped verification. Require a fresh
          // task when switching an existing name to OCI's tenancy name.
          assertAccountTasksIdle(id);
          changes.nameSource = "pending";
        }
      }
      if (
        input.tenancyId &&
        input.tenancyId !== current.tenancyId &&
        (changes.nameSource ?? current.nameSource) !== "custom"
      )
        changes.nameSource = "pending";
      if (input.tenancyId && input.tenancyId !== existing.tenancyId)
        assertUniqueTenancy(input.tenancyId, id);
      if (scopeChanged) {
        if (recovering) assertConsoleCredentialRecovery(id);
        else assertAccountIdle(id);
        changes.revision = existing.revision + 1;
      }
      const next = { ...current, ...changes };
      getOrm()
        .update(accounts)
        .set({ ...changes, regions: JSON.stringify(next.regions) })
        .where(eq(accounts.id, id))
        .run();
      if (next.name !== current.name) updateJobAccountNames(id, next.name);
      if (recovering)
        getOrm()
          .update(consoleSessions)
          .set({ credentialRecoveryReady: 0 })
          .where(and(eq(consoleSessions.accountId, id), eq(consoleSessions.slot, 1)))
          .run();
      else if (credentialChanged)
        getOrm().delete(resources).where(eq(resources.accountId, id)).run();
      else if (scopeChanged)
        getOrm()
          .delete(resources)
          .where(and(eq(resources.accountId, id), notInArray(resources.region, regions)))
          .run();
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
    getOrm().delete(accounts).where(eq(accounts.id, id)).run();
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
    getOrm()
      .update(accounts)
      .set({ status, lastError: error })
      .where(and(eq(accounts.id, id), eq(accounts.revision, expectedRevision)))
      .run().changes === 1
  );
}

function updateJobAccountNames(id: string, name: string): void {
  getOrm().update(jobs).set({ accountName: name }).where(eq(jobs.accountId, id)).run();
}

/** Apply verified OCI identity only while automatic naming and credentials are still current. */
export function setAccountTenancyName(
  id: string,
  tenancyName: string,
  expectedRevision: number,
): boolean {
  if (typeof tenancyName !== "string") return false;
  const name = tenancyName.trim().slice(0, 80);
  if (!name || name.startsWith("ocid1.")) return false;
  const db = getDatabase();
  return db
    .transaction(() => {
      const updated =
        getOrm()
          .update(accounts)
          .set({ name, nameSource: "tenancy" })
          .where(
            and(
              eq(accounts.id, id),
              eq(accounts.revision, expectedRevision),
              inArray(accounts.nameSource, ["pending", "tenancy"]),
            ),
          )
          .run().changes === 1;
      if (updated) updateJobAccountNames(id, name);
      return updated;
    })
    .immediate();
}
