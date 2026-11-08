import type Database from "better-sqlite3";
import {
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const bindingName = "encryption.master-key.sha256";
const initialized = new Map<string, string>();

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
function keyPath(databasePath: string): string {
  return join(dirname(resolve(/* turbopackIgnore: true */ databasePath)), ".master-key");
}
function fingerprint(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}
function environmentKey(): Buffer | undefined {
  const configured = process.env.MASTER_KEY;
  if (configured === undefined || configured === "") return;
  const encoded = configured.trim();
  const key = Buffer.from(encoded, "base64");
  if (
    !/^[A-Za-z0-9+/]{43}=?$/.test(encoded) ||
    key.length !== 32 ||
    key.toString("base64").replace(/=$/, "") !== encoded.replace(/=$/, "")
  )
    throw new Error("MASTER_KEY must be a base64 encoded 32-byte key");
  return key;
}
function storedKey(path: string): Buffer | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== 32)
      throw new Error("Invalid stored encryption key; restore the original .master-key file");
    const key = readFileSync(path);
    if (key.length !== 32)
      throw new Error("Invalid stored encryption key; restore the original .master-key file");
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if (process.platform !== "win32") throw error;
      // Windows access is controlled by the host ACL rather than POSIX mode bits.
    }
    return key;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return;
    throw error;
  }
}
function assertKeyIdentity(
  key: Buffer,
  configured: Buffer | undefined,
  binding: string | undefined,
): void {
  if (configured && !timingSafeEqual(key, configured))
    throw new Error("MASTER_KEY does not match the stored encryption key; keep the original key");
  if (binding !== undefined && binding !== fingerprint(key))
    throw new Error("Encryption key does not match this database; restore its original key");
}
function verifyEncryptedData(values: Iterable<unknown>, key: Buffer): void {
  for (const row of values) {
    try {
      if (!row || typeof row !== "object" || !("value" in row) || typeof row.value !== "string")
        throw new Error("Invalid secret row");
      const [version, iv, tag, ciphertext] = row.value.split(".");
      if (version !== "v1" || !iv || !tag || !ciphertext)
        throw new Error("Invalid secret envelope");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      // Authentication is checked without retaining or returning the plaintext.
      decipher.update(Buffer.from(ciphertext, "base64url"));
      decipher.final();
    } catch {
      throw new Error(
        "The encryption key cannot decrypt existing credentials or MFA data; restore the original key",
      );
    }
  }
}
function syncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function publishKey(path: string, key: Buffer): Buffer {
  const folder = dirname(path);
  const temporary = join(folder, `.master-key.${process.pid}.${randomUUID()}.tmp`);
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, key);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      // A hard link publishes the complete, fsynced file without ever replacing
      // a key another process published first. Readers cannot observe a partial key.
      linkSync(temporary, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    rmSync(temporary, { force: true });
    syncDirectory(folder);
  }
  const published = storedKey(path);
  if (!published) throw new Error("Encryption key publication failed");
  return published;
}

/** Call after schema migration, before publishing the DB connection or creating an admin. */
export function initializeMasterKey(db: Database.Database, databasePath: string): void {
  const absolutePath = resolve(/* turbopackIgnore: true */ databasePath);
  const path = keyPath(absolutePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let resolvedFingerprint: string | undefined;
  db.transaction(() => {
    const configured = environmentKey();
    const stored = storedKey(path);
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(bindingName) as
      { value: string } | undefined;
    const binding = row?.value;
    if (binding !== undefined && !/^sha256:[a-f0-9]{64}$/.test(binding))
      throw new Error("Invalid database encryption key binding; restore a consistent backup");
    const secrets = db.prepare(
      "SELECT credential AS value FROM accounts UNION ALL SELECT mfa_secret AS value FROM users WHERE mfa_secret IS NOT NULL UNION ALL SELECT mfa_pending AS value FROM users WHERE mfa_pending IS NOT NULL",
    );
    const hasSecrets = secrets.get() !== undefined;
    if (!stored && !configured && (hasSecrets || binding !== undefined))
      throw new Error(
        "The original encryption key is missing; restore .master-key or provide the original MASTER_KEY",
      );
    let key = stored ?? configured ?? randomBytes(32);
    assertKeyIdentity(key, configured, binding);
    verifyEncryptedData(secrets.iterate(), key);
    if (!stored) {
      key = publishKey(path, key);
      // Also protects databases sharing a directory from a competing file publisher.
      assertKeyIdentity(key, configured, binding);
      verifyEncryptedData(secrets.iterate(), key);
    }
    resolvedFingerprint = fingerprint(key);
    db.prepare("INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)").run(
      bindingName,
      resolvedFingerprint,
    );
  }).immediate();
  if (!resolvedFingerprint) throw new Error("Encryption key initialization failed");
  initialized.set(absolutePath, resolvedFingerprint);
}

/** Never creates a key: only database initialization may establish a new identity. */
export function readMasterKey(
  databasePath = process.env.DATABASE_PATH ?? "data/oci-dash.db",
): Buffer {
  const absolutePath = resolve(/* turbopackIgnore: true */ databasePath);
  const configured = environmentKey();
  const stored = storedKey(keyPath(absolutePath));
  const binding = initialized.get(absolutePath);
  if (stored) {
    assertKeyIdentity(stored, configured, binding);
    return stored;
  }
  // Permit standalone encryption tests/tools with an explicit key; application
  // startup always initializes and binds it before accessing encrypted data.
  if (configured && binding === undefined) return configured;
  throw new Error(
    "The stored encryption key is missing; initialize the database with its original key",
  );
}
