import { randomUUID, createPrivateKey, createPublicKey, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AccountSummary } from "@/lib/contracts";
import type { OciCredentials } from "./oci/types";
import { getDatabase, getOrm, audit } from "./db";
import { accounts } from "./schema";
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
function publicAccount(row: typeof accounts.$inferSelect): AccountSummary {
  const { credential: _secret, revision: _revision, ...rest } = row;
  return { ...rest, status: rest.status as AccountSummary["status"] };
}
export function listAccounts(): AccountSummary[] {
  return getOrm().select().from(accounts).all().map(publicAccount);
}
export function getAccount(id: string): AccountSummary | null {
  const row = getOrm().select().from(accounts).where(eq(accounts.id, id)).get();
  return row ? publicAccount(row) : null;
}
export function getCredentialSnapshot(
  id: string,
  region?: string,
): { credentials: OciCredentials; revision: number } {
  const row = getOrm().select().from(accounts).where(eq(accounts.id, id)).get();
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
function assertAccountIdle(id: string): void {
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
  getOrm()
    .insert(accounts)
    .values({
      id,
      name: input.name,
      tenancyId: input.tenancyId,
      userId: input.userId,
      fingerprint: input.fingerprint.toLowerCase(),
      homeRegion: input.homeRegion,
      regions: [...new Set([input.homeRegion, ...input.regions])],
      credential: encryptSecret(input.privateKey.trim()),
      status: "unchecked",
      createdAt,
    })
    .run();
  audit(actor, "account.create", input.name, "账号配置已保存");
  return getAccount(id)!;
}
export function updateAccount(
  id: string,
  input: Partial<AccountInput>,
  actor: string,
): AccountSummary {
  const existing = getOrm().select().from(accounts).where(eq(accounts.id, id)).get();
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
  const changes: Partial<typeof accounts.$inferInsert> = {
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
      const current = getDatabase().prepare("SELECT revision FROM accounts WHERE id=?").get(id) as
        { revision: number } | undefined;
      if (!current || current.revision !== existing.revision)
        throw new AppError("账号配置已变更，请刷新后重试", 409, "ACCOUNT_CHANGED");
      if (scopeChanged) {
        assertAccountIdle(id);
        changes.revision = existing.revision + 1;
      }
      getOrm().update(accounts).set(changes).where(eq(accounts.id, id)).run();
      if (credentialChanged)
        getDatabase().prepare("DELETE FROM resources WHERE account_id=?").run(id);
    })
    .immediate();
  audit(actor, "account.update", existing.name, "账号配置已更新");
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
  const changes: Partial<typeof accounts.$inferInsert> = { status, lastError: error };
  return getDatabase()
    .transaction(() => {
      const current = getDatabase().prepare("SELECT revision FROM accounts WHERE id=?").get(id) as
        { revision: number } | undefined;
      if (!current || current.revision !== expectedRevision) return false;
      getOrm().update(accounts).set(changes).where(eq(accounts.id, id)).run();
      return true;
    })
    .immediate();
}
