import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { and, eq, gt, lt, lte, ne, sql } from "drizzle-orm";
import type { SessionUser } from "@/lib/contracts";
import { getDatabase, getOrm, audit } from "./db";
import { loginAttempts, sessions, users } from "./database/schema";
import { ormFor } from "./database/client";
import { decryptSecret, encryptSecret, hashPassword, hashToken, verifyPassword } from "./crypto";
import { AppError } from "./errors";
import { assertRequestOrigin } from "./request-origin";
import {
  assertInitialAdminSetupAvailable,
  clearInitialAdminPassword,
  createInitialAdminSession,
  initialAdminState,
} from "./initial-admin";

export const SESSION_COOKIE = "oci_dash_session";
const SESSION_SECONDS = 12 * 60 * 60;
type UserRow = typeof users.$inferSelect;
const dummyPassword = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

function userRow(id: string, db = getDatabase()): UserRow {
  const row = ormFor(db).select().from(users).where(eq(users.id, id)).get();
  if (!row) throw new AppError("请重新登录", 401, "UNAUTHORIZED");
  return row;
}
function cookieToken(request: Request): string | null {
  const cookie = request.headers.get("cookie") ?? "";
  const raw = cookie
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(SESSION_COOKIE + "="))
    ?.slice(SESSION_COOKIE.length + 1);
  return raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}
export const currentSessionHash = (request: Request): string | undefined => {
  const token = cookieToken(request);
  return token ? hashToken(token) : undefined;
};
export function sessionCookie(token: string, request: Request, remove = false): string {
  const secure = assertRequestOrigin(request).protocol === "https:";
  return `${SESSION_COOKIE}=${remove ? "" : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${remove ? 0 : SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}
export function requireUser(request: Request): SessionUser {
  const token = cookieToken(request);
  if (!token) throw new AppError("请先登录", 401, "UNAUTHORIZED");
  const row = getOrm()
    .select({ id: users.id, username: users.username, mfaSecret: users.mfaSecret })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(
      and(
        eq(sessions.tokenHash, hashToken(token)),
        gt(sessions.expiresAt, new Date().toISOString()),
      ),
    )
    .get();
  if (!row) throw new AppError("登录已过期，请重新登录", 401, "UNAUTHORIZED");
  return { id: row.id, username: row.username, mfaEnabled: !!row.mfaSecret };
}
export function assertSameOrigin(request: Request): void {
  assertRequestOrigin(request);
}
function limitLogin(subject: string): void {
  const db = getDatabase(),
    orm = getOrm(),
    now = Date.now(),
    windowMs = 15 * 60 * 1000;
  db.transaction(() => {
    orm
      .delete(loginAttempts)
      .where(lte(loginAttempts.windowStart, now - windowMs))
      .run();
    const global = orm
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.subject, "global"))
      .get();
    if (global && now - global.windowStart < 60000 && global.count >= 40)
      throw new AppError("登录请求较多，请一分钟后重试", 429, "LOGIN_RATE_LIMIT");
    if (!global || now - global.windowStart >= 60000)
      orm
        .insert(loginAttempts)
        .values({ subject: "global", count: 1, windowStart: now })
        .onConflictDoUpdate({ target: loginAttempts.subject, set: { count: 1, windowStart: now } })
        .run();
    else
      orm
        .update(loginAttempts)
        .set({ count: sql`${loginAttempts.count} + 1` })
        .where(eq(loginAttempts.subject, "global"))
        .run();
    const current = orm
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.subject, subject))
      .get();
    if (current && now - current.windowStart < windowMs && current.count >= 10)
      throw new AppError("尝试次数过多，请 15 分钟后重试", 429, "LOGIN_RATE_LIMIT");
    if (!current || now - current.windowStart >= windowMs)
      orm
        .insert(loginAttempts)
        .values({ subject, count: 1, windowStart: now })
        .onConflictDoUpdate({ target: loginAttempts.subject, set: { count: 1, windowStart: now } })
        .run();
    else
      orm
        .update(loginAttempts)
        .set({ count: sql`${loginAttempts.count} + 1` })
        .where(eq(loginAttempts.subject, subject))
        .run();
  }).immediate();
}
const totp = (secret: string, username: string) =>
  new OTPAuth.TOTP({
    issuer: "OCI Dash",
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
function verifyFactor(row: UserRow, code: string, db = getDatabase()): boolean {
  const orm = ormFor(db);
  if (!row.mfaSecret) return false;
  if (/^\d{6}$/.test(code)) {
    const delta = totp(decryptSecret(row.mfaSecret), row.username).validate({
      token: code,
      window: 1,
    });
    if (delta === null) return false;
    const step = Math.floor(Date.now() / 30000) + delta;
    return (
      orm
        .update(users)
        .set({ lastOtpStep: step })
        .where(and(eq(users.id, row.id), lt(users.lastOtpStep, step)))
        .run().changes === 1
    );
  }
  const normalized = code.replaceAll("-", "").toLowerCase();
  if (!/^[a-f0-9]{20}$/.test(normalized)) return false;
  const key = hashToken(normalized);
  return db.transaction(() => {
    const fresh = userRow(row.id, db),
      codes = JSON.parse(fresh.recoveryCodes) as string[];
    if (!codes.includes(key)) return false;
    orm
      .update(users)
      .set({ recoveryCodes: JSON.stringify(codes.filter((x) => x !== key)) })
      .where(eq(users.id, row.id))
      .run();
    return true;
  })();
}
export function administratorSetupStatus(): { setupRequired: boolean } {
  return { setupRequired: initialAdminState(getDatabase()) === "required" };
}

export async function setupAdministrator(
  username: string,
  password: string,
): Promise<{ user: SessionUser; token: string }> {
  const db = getDatabase();
  assertInitialAdminSetupAvailable(db);
  // A separate subject bounds setup attempts without calling login after creating the user.
  limitLogin(hashToken("initial-admin-setup"));
  const result = await createInitialAdminSession(db, username, password, SESSION_SECONDS);
  if (!clearInitialAdminPassword(db.name))
    console.warn("Initial administrator password file cleanup failed.");
  return result;
}

export async function login(
  username: string,
  password: string,
  code?: string,
): Promise<{ user: SessionUser; token: string }> {
  const subject = hashToken(username.toLowerCase());
  limitLogin(subject);
  const db = getDatabase(),
    orm = ormFor(db),
    row = orm.select().from(users).where(eq(users.username, username)).get();
  if (!(await verifyPassword(password, row?.passwordHash ?? dummyPassword)) || !row)
    throw new AppError("账号或密码不正确", 401, "INVALID_CREDENTIALS");
  const result = db
    .transaction(() => {
      const current = orm.select().from(users).where(eq(users.id, row.id)).get();
      if (!current || current.username !== username || current.passwordHash !== row.passwordHash)
        throw new AppError("账号或密码不正确", 401, "INVALID_CREDENTIALS");
      if (current.mfaSecret && !code)
        throw new AppError("请输入动态验证码或恢复码", 401, "MFA_REQUIRED");
      if (current.mfaSecret && !verifyFactor(current, code!, db))
        throw new AppError("验证码无效或已使用", 401, "INVALID_MFA");
      const token = randomBytes(32).toString("base64url"),
        now = new Date();
      orm.delete(loginAttempts).where(eq(loginAttempts.subject, subject)).run();
      orm.delete(sessions).where(lte(sessions.expiresAt, now.toISOString())).run();
      orm
        .insert(sessions)
        .values({
          tokenHash: hashToken(token),
          userId: current.id,
          expiresAt: new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString(),
          createdAt: now.toISOString(),
        })
        .run();
      return {
        token,
        user: { id: current.id, username: current.username, mfaEnabled: !!current.mfaSecret },
      };
    })
    .immediate();
  audit(result.user.username, "auth.login", "session", "登录成功");
  return result;
}
export function logout(request: Request): void {
  const token = cookieToken(request);
  if (token)
    getOrm()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashToken(token)))
      .run();
}
export async function changePassword(
  user: SessionUser,
  current: string,
  replacement: string,
): Promise<void> {
  const db = getDatabase(),
    orm = ormFor(db),
    row = userRow(user.id, db);
  if (!(await verifyPassword(current, row.passwordHash))) throw new AppError("当前密码不正确", 403);
  if (replacement.length < 12 || replacement.length > 256)
    throw new AppError("新密码需为 12–256 个字符");
  const hashed = await hashPassword(replacement);
  db.transaction(() => {
    const fresh = userRow(user.id, db);
    if (fresh.passwordHash !== row.passwordHash || fresh.mfaSecret !== row.mfaSecret)
      throw new AppError("账号凭据已变更，请重试", 409, "CREDENTIALS_CHANGED");
    orm.update(users).set({ passwordHash: hashed }).where(eq(users.id, user.id)).run();
    orm.delete(sessions).where(eq(sessions.userId, user.id)).run();
  }).immediate();
  if (!clearInitialAdminPassword(db.name))
    console.warn("Initial administrator password file cleanup failed.");
  audit(user.username, "auth.password-change", "account", "密码已更新，全部会话已退出");
}
export async function beginMfa(user: SessionUser, password: string) {
  const db = getDatabase(),
    orm = ormFor(db),
    row = userRow(user.id, db);
  if (!(await verifyPassword(password, row.passwordHash))) throw new AppError("密码不正确", 403);
  if (row.mfaSecret) throw new AppError("MFA 已启用", 409);
  const secret = new OTPAuth.Secret({ size: 20 }).base32,
    uri = totp(secret, user.username).toString(),
    qrDataUrl = await QRCode.toDataURL(uri, { width: 240, margin: 2 });
  db.transaction(() => {
    const fresh = userRow(user.id, db);
    if (
      fresh.passwordHash !== row.passwordHash ||
      fresh.mfaSecret !== row.mfaSecret ||
      fresh.mfaPending !== row.mfaPending ||
      fresh.mfaPendingExpires !== row.mfaPendingExpires
    )
      throw new AppError("账号凭据已变更，请重试", 409, "CREDENTIALS_CHANGED");
    orm
      .update(users)
      .set({
        mfaPending: encryptSecret(secret),
        mfaPendingExpires: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .where(eq(users.id, user.id))
      .run();
  }).immediate();
  return { secret, uri, qrDataUrl };
}
export function confirmMfa(user: SessionUser, code: string, keepSessionHash?: string): string[] {
  const row = userRow(user.id);
  if (!row.mfaPending || !row.mfaPendingExpires || row.mfaPendingExpires < new Date().toISOString())
    throw new AppError("绑定请求已过期，请重新开始");
  if (
    totp(decryptSecret(row.mfaPending), user.username).validate({ token: code, window: 1 }) === null
  )
    throw new AppError("验证码不正确");
  const recoveryCodes = Array.from({ length: 10 }, () =>
    randomBytes(10).toString("hex").match(/.{4}/g)!.join("-"),
  );
  const orm = getOrm();
  getDatabase().transaction(() => {
    orm
      .update(users)
      .set({
        mfaSecret: users.mfaPending,
        mfaPending: null,
        mfaPendingExpires: null,
        recoveryCodes: JSON.stringify(recoveryCodes.map((c) => hashToken(c.replaceAll("-", "")))),
        lastOtpStep: -1,
      })
      .where(eq(users.id, user.id))
      .run();
    if (keepSessionHash)
      orm
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, keepSessionHash)))
        .run();
    else orm.delete(sessions).where(eq(sessions.userId, user.id)).run();
  })();
  audit(user.username, "auth.mfa-enable", "account", "MFA 绑定已验证并启用");
  return recoveryCodes;
}
export async function disableMfa(
  user: SessionUser,
  password: string,
  code: string,
  keepSessionHash?: string,
): Promise<void> {
  const db = getDatabase(),
    orm = ormFor(db),
    row = userRow(user.id, db);
  if (!(await verifyPassword(password, row.passwordHash)))
    throw new AppError("密码或验证码不正确", 403);
  db.transaction(() => {
    const current = userRow(user.id, db);
    if (
      current.passwordHash !== row.passwordHash ||
      current.mfaSecret !== row.mfaSecret ||
      !verifyFactor(current, code, db)
    )
      throw new AppError("密码或验证码无效或已使用", 403);
    orm
      .update(users)
      .set({
        mfaSecret: null,
        mfaPending: null,
        mfaPendingExpires: null,
        recoveryCodes: "[]",
        lastOtpStep: -1,
      })
      .where(eq(users.id, user.id))
      .run();
    if (keepSessionHash)
      orm
        .delete(sessions)
        .where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, keepSessionHash)))
        .run();
    else orm.delete(sessions).where(eq(sessions.userId, user.id)).run();
  }).immediate();
  audit(user.username, "auth.mfa-disable", "account", "MFA 已关闭");
}
