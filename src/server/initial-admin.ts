import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashPassword, hashToken } from "./crypto.ts";

export const INITIAL_ADMIN_SETUP_KEY = "auth.setup.completed";
export type InitialAdminState = "required" | "completed" | "unavailable";

class InitialAdminError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "InitialAdminError";
    this.status = status;
    this.code = code;
  }
}

/** Presence of the completion marker is authoritative, even after accidental user deletion. */
export function initialAdminState(db: Database.Database): InitialAdminState {
  if (db.prepare("SELECT id FROM users LIMIT 1").get()) return "completed";
  if (db.prepare("SELECT value FROM settings WHERE key=?").get(INITIAL_ADMIN_SETUP_KEY))
    return "completed";
  if (db.prepare("SELECT id FROM accounts LIMIT 1").get()) return "unavailable";
  return "required";
}

export function assertInitialAdminSetupAvailable(db: Database.Database): void {
  const state = initialAdminState(db);
  if (state === "completed")
    throw new InitialAdminError("管理员初始化已完成，请登录", 409, "SETUP_ALREADY_COMPLETED");
  if (state === "unavailable")
    throw new InitialAdminError(
      "已有云账号但缺少管理员，请恢复原数据库，不能重新初始化",
      409,
      "SETUP_UNAVAILABLE",
    );
}

function markComplete(db: Database.Database, timestamp: string): void {
  db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").run(
    INITIAL_ADMIN_SETUP_KEY,
    timestamp,
  );
}

function normalizedUsername(username: string, password: string): string {
  const name = username.trim();
  if (name.length < 1 || name.length > 80)
    throw new InitialAdminError("用户名需为 1–80 个字符", 400, "VALIDATION_ERROR");
  if (password.length < 12 || password.length > 256)
    throw new InitialAdminError("密码需为 12–256 个字符", 400, "VALIDATION_ERROR");
  return name;
}

/** Preserve existing users; only an explicitly configured password initializes an empty database. */
export function ensureInitialAdmin(db: Database.Database): void {
  db.transaction(() => {
    if (db.prepare("SELECT id FROM users LIMIT 1").get()) {
      markComplete(db, new Date().toISOString());
      return;
    }
    if (initialAdminState(db) !== "required") return;
    const password = process.env.ADMIN_PASSWORD;
    if (!password) return;
    const username = normalizedUsername(process.env.ADMIN_USERNAME || "admin", password);
    const timestamp = new Date().toISOString();
    db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(
      randomUUID(),
      username,
      hashPassword(password),
      timestamp,
    );
    markComplete(db, timestamp);
  }).immediate();
}

/** The user, session and completion marker commit together under one cross-process write lock. */
export function createInitialAdminSession(
  db: Database.Database,
  username: string,
  password: string,
  sessionSeconds: number,
): { user: { id: string; username: string; mfaEnabled: false }; token: string } {
  const name = normalizedUsername(username, password);
  if (!Number.isSafeInteger(sessionSeconds) || sessionSeconds <= 0)
    throw new Error("Invalid initial administrator session lifetime");
  return db
    .transaction(() => {
      assertInitialAdminSetupAvailable(db);
      const id = randomUUID(),
        token = randomBytes(32).toString("base64url"),
        now = new Date();
      const timestamp = now.toISOString();
      db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(
        id,
        name,
        hashPassword(password),
        timestamp,
      );
      db.prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)",
      ).run(
        hashToken(token),
        id,
        new Date(now.getTime() + sessionSeconds * 1000).toISOString(),
        timestamp,
      );
      markComplete(db, timestamp);
      db.prepare(
        "INSERT INTO audit_events(actor,action,resource,result,created_at) VALUES(?,?,?,?,?)",
      ).run(name, "auth.setup", "account", "管理员初始化完成", timestamp);
      return { user: { id, username: name, mfaEnabled: false as const }, token };
    })
    .immediate();
}

/** Best-effort removal of the legacy generated password after a committed setup/password change. */
export function clearInitialAdminPassword(databasePath: string): boolean {
  const path = join(
    dirname(resolve(/* turbopackIgnore: true */ databasePath)),
    ".initial-admin-password",
  );
  try {
    if (!lstatSync(path).isFile()) return false;
    unlinkSync(path);
    if (process.platform !== "win32") {
      const descriptor = openSync(dirname(path), "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    }
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }
}
