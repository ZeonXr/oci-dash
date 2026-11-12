import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { readMasterKey } from "./master-key.ts";
import { AppError } from "./errors.ts";

export function encryptSecret(value: string): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", readMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(value: string): string {
  const [version, iv, tag, ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext)
    throw new Error("Invalid encrypted credential");
  const decipher = createDecipheriv("aes-256-gcm", readMasterKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
let passwordComputations = 0;
async function passwordDigest(password: string, salt: string): Promise<Buffer> {
  if (passwordComputations >= 2)
    throw new AppError("密码处理请求较多，请稍后重试", 429, "PASSWORD_BUSY");
  passwordComputations++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(
        password,
        salt,
        64,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => {
          if (error) reject(error);
          else resolve(key);
        },
      );
    });
  } finally {
    passwordComputations--;
  }
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const hash = await passwordDigest(password, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, salt, digest] = stored.split("$");
  if (kind !== "scrypt" || !salt || !/^[a-f0-9]{128}$/.test(digest ?? "")) return false;
  const actual = await passwordDigest(password, salt);
  return timingSafeEqual(actual, Buffer.from(digest, "hex"));
}
