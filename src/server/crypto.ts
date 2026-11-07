import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function masterKey(): Buffer {
  if (process.env.MASTER_KEY) {
    const key = Buffer.from(process.env.MASTER_KEY, "base64");
    if (key.length !== 32) throw new Error("MASTER_KEY must be a base64 encoded 32-byte key");
    return key;
  }
  const folder = dirname(resolve(/* turbopackIgnore: true */ process.env.DATABASE_PATH ?? "data/oci-dash.db"));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = resolve(folder, ".master-key");
  try { writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("Invalid stored encryption key");
  try { chmodSync(path, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  return key;
}

export function encryptSecret(value: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted credential");
  const decipher = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, digest] = stored.split("$");
  if (kind !== "scrypt" || !salt || !/^[a-f0-9]{128}$/.test(digest ?? "")) return false;
  const actual = scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}
