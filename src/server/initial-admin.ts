import type Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashPassword } from "./crypto.ts";

const passwordFileName = ".initial-admin-password";

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function passwordPath(databasePath: string): string {
  return join(dirname(resolve(/* turbopackIgnore: true */ databasePath)), passwordFileName);
}

function syncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function storedPassword(path: string): string | undefined {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
  if (!metadata.isFile() || metadata.size !== 44)
    throw new Error("Invalid initial administrator password file; restore a complete file");
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.size !== 44 ||
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino
    )
      throw new Error("Initial administrator password file changed while opening it");
    if (process.platform !== "win32") fchmodSync(descriptor, 0o600);
    const content = readFileSync(descriptor, "utf8");
    if (!/^[A-Za-z0-9_-]{43}\n$/.test(content))
      throw new Error("Invalid initial administrator password file; restore a complete file");
    return content.slice(0, -1);
  } finally {
    closeSync(descriptor);
  }
}

function publishPassword(path: string): string {
  const directory = dirname(path);
  const temporary = join(directory, `${passwordFileName}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, randomBytes(32).toString("base64url") + "\n");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      // Publish the complete, durable file without replacing an existing password.
      // Even different databases sharing this directory must use the winning file.
      linkSync(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    if (created) unlinkSync(temporary);
    syncDirectory(directory);
  }
  const password = storedPassword(path);
  if (password === undefined) throw new Error("Initial administrator password publication failed");
  return password;
}

/** Call after creating the users table, before making the database available to requests. */
export function ensureInitialAdmin(db: Database.Database, databasePath: string): void {
  db.transaction(() => {
    // Existing users are authoritative, including when old initialization variables changed.
    if (db.prepare("SELECT id FROM users LIMIT 1").get()) return;
    const configured = process.env.ADMIN_PASSWORD || undefined;
    if (configured !== undefined && (configured.length < 12 || configured.length > 256))
      throw new Error("ADMIN_PASSWORD must contain 12–256 characters");
    const username = process.env.ADMIN_USERNAME || "admin";
    if (username.length > 80)
      throw new Error("ADMIN_USERNAME must contain no more than 80 characters");
    const path = passwordPath(databasePath);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const stored = storedPassword(path);
    if (stored !== undefined && configured !== undefined && stored !== configured)
      throw new Error("ADMIN_PASSWORD conflicts with the saved initial administrator password");
    // The published file survives a rolled-back insert, so the next process reuses it.
    const password = stored ?? configured ?? publishPassword(path);
    db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(
      randomUUID(),
      username,
      hashPassword(password),
      new Date().toISOString(),
    );
  }).immediate();
}

/** A cleanup failure must not turn a committed password change into an apparent failure. */
export function clearInitialAdminPassword(databasePath: string): boolean {
  const path = passwordPath(databasePath);
  try {
    if (!lstatSync(path).isFile()) return false;
    unlinkSync(path);
    syncDirectory(dirname(path));
    return true;
  } catch (error) {
    return hasCode(error, "ENOENT");
  }
}
