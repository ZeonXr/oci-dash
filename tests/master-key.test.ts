import Database from "better-sqlite3";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeMasterKey, readMasterKey } from "@/server/master-key";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { initializeTestDatabase } from "./fixtures/database";

const base = resolve(".test-tmp");
const bindingName = "encryption.master-key.sha256";
const handles: Database.Database[] = [];
let directory: string;
let path: string;
let keyFile: string;
let db: Database.Database;
const keyA = Buffer.alloc(32, 61);
const keyB = Buffer.alloc(32, 62);
const digest = (key: Buffer) => createHash("sha256").update(key).digest("hex");
function open(filename = path): Database.Database {
  const result = new Database(filename);
  result.pragma("busy_timeout=10000");
  handles.push(result);
  return result;
}
function envelope(key: Buffer, value = "synthetic-test-secret"): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".");
}
function insertCredential(value: string): void {
  db.prepare(
    "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,created_at) VALUES(?,'Fixture','tenancy','user','fingerprint','region','[]',?,'2026-01-01')",
  ).run(randomUUID(), value);
}
function insertMfa(secret: string | null, pending: string | null): void {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO users(id,username,password_hash,created_at,mfa_secret,mfa_pending) VALUES(?,?,'fixture-only','2026-01-01',?,?)",
  ).run(id, id, secret, pending);
}
function binding(): string | undefined {
  return (
    db.prepare("SELECT value FROM settings WHERE key=?").get(bindingName) as
      { value: string } | undefined
  )?.value;
}
function bind(key: Buffer): void {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(
    bindingName,
    `sha256:${digest(key)}`,
  );
}
beforeEach(() => {
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "master-key-test-"));
  path = join(directory, "test.db");
  keyFile = join(directory, ".master-key");
  vi.stubEnv("DATABASE_PATH", path);
  vi.stubEnv("MASTER_KEY", "");
  db = open();
  initializeTestDatabase(db);
});
afterEach(() => {
  handles.splice(0).forEach((handle) => {
    if (handle.open) handle.close();
  });
  vi.unstubAllEnvs();
  if (dirname(resolve(directory)) !== base || !basename(directory).startsWith("master-key-test-"))
    throw new Error("Invalid master-key test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("persistent master key initialization", () => {
  it("creates and binds one random key for an empty database, usable after reopening", () => {
    initializeMasterKey(db, path);
    const key = readFileSync(keyFile);
    expect(key.length).toBe(32);
    expect(binding()).toBe(`sha256:${digest(key)}`);
    if (process.platform !== "win32") expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    const encrypted = encryptSecret("new-install-secret");
    insertCredential(encrypted);
    db.close();
    db = open();
    initializeMasterKey(db, path);
    expect(readFileSync(keyFile).equals(key)).toBe(true);
    expect(decryptSecret(encrypted)).toBe("new-install-secret");
    expect(readdirSync(directory).filter((name) => name.startsWith(".master-key."))).toEqual([]);
  });

  it("persists a legacy environment key only after verifying credentials and both MFA columns", () => {
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    const encrypted = envelope(keyA);
    insertCredential(encrypted);
    insertMfa(encrypted, encrypted);
    initializeMasterKey(db, path);
    expect(readFileSync(keyFile).equals(keyA)).toBe(true);
    expect(binding()).toBe(`sha256:${digest(keyA)}`);
    vi.stubEnv("MASTER_KEY", "");
    initializeMasterKey(db, path);
    expect(decryptSecret(encrypted)).toBe("synthetic-test-secret");
  });

  it("binds an existing valid legacy key file without replacing it", () => {
    writeFileSync(keyFile, keyA);
    insertCredential(envelope(keyA));
    initializeMasterKey(db, path);
    expect(readFileSync(keyFile).equals(keyA)).toBe(true);
    expect(binding()).toBe(`sha256:${digest(keyA)}`);
  });

  it.each(["account", "mfa", "pending-mfa"])(
    "refuses to generate a replacement when %s data exists",
    (kind) => {
      if (kind === "account") insertCredential(envelope(keyA));
      else
        insertMfa(
          kind === "mfa" ? envelope(keyA) : null,
          kind === "pending-mfa" ? envelope(keyA) : null,
        );
      expect(() => initializeMasterKey(db, path)).toThrow(/original encryption key is missing/);
      expect(existsSync(keyFile)).toBe(false);
      expect(binding()).toBeUndefined();
    },
  );

  it.each(["account", "mfa", "pending-mfa"])(
    "refuses an environment key that cannot decrypt existing %s",
    (kind) => {
      vi.stubEnv("MASTER_KEY", keyB.toString("base64"));
      if (kind === "account") insertCredential(envelope(keyA));
      else
        insertMfa(
          kind === "mfa" ? envelope(keyA) : null,
          kind === "pending-mfa" ? envelope(keyA) : null,
        );
      expect(() => initializeMasterKey(db, path)).toThrow(/cannot decrypt existing/);
      expect(existsSync(keyFile)).toBe(false);
      expect(binding()).toBeUndefined();
    },
  );

  it("verifies every encrypted record before publishing a legacy key", () => {
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    insertCredential(envelope(keyA));
    insertCredential(envelope(keyB));
    expect(() => initializeMasterKey(db, path)).toThrow(/cannot decrypt existing/);
    expect(existsSync(keyFile)).toBe(false);
    expect(binding()).toBeUndefined();
  });

  it("rejects a conflicting environment even for an empty database with a key file", () => {
    writeFileSync(keyFile, keyA);
    vi.stubEnv("MASTER_KEY", keyB.toString("base64"));
    expect(() => initializeMasterKey(db, path)).toThrow(/does not match the stored/);
    expect(readFileSync(keyFile).equals(keyA)).toBe(true);
    expect(binding()).toBeUndefined();
  });

  it("rejects a wrong full-length key using the database binding even without remaining secrets", () => {
    bind(keyA);
    writeFileSync(keyFile, keyB);
    expect(() => initializeMasterKey(db, path)).toThrow(/does not match this database/);
    expect(readFileSync(keyFile).equals(keyB)).toBe(true);
    expect(binding()).toBe(`sha256:${digest(keyA)}`);
  });

  it("requires the original key for a bound database even if no encrypted rows remain", () => {
    bind(keyA);
    expect(() => initializeMasterKey(db, path)).toThrow(/original encryption key is missing/);
    expect(existsSync(keyFile)).toBe(false);
    vi.stubEnv("MASTER_KEY", keyB.toString("base64"));
    expect(() => initializeMasterKey(db, path)).toThrow(/does not match this database/);
    expect(existsSync(keyFile)).toBe(false);
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    initializeMasterKey(db, path);
    expect(readFileSync(keyFile).equals(keyA)).toBe(true);
  });

  it("does not overwrite a corrupted key file even when a valid environment key is available", () => {
    writeFileSync(keyFile, Buffer.alloc(4, 99));
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    insertCredential(envelope(keyA));
    expect(() => initializeMasterKey(db, path)).toThrow(/Invalid stored encryption key/);
    expect(readFileSync(keyFile).length).toBe(4);
    expect(binding()).toBeUndefined();
  });

  it.each(["invalid", Buffer.alloc(31).toString("base64"), keyA.toString("base64") + "!"])(
    "rejects malformed legacy key encoding without creating a file",
    (value) => {
      vi.stubEnv("MASTER_KEY", value);
      expect(() => initializeMasterKey(db, path)).toThrow(/base64 encoded 32-byte key/);
      expect(existsSync(keyFile)).toBe(false);
    },
  );

  it("keeps standalone explicit-environment crypto usable without creating an unbound key file", () => {
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    const value = encryptSecret("standalone-secret");
    expect(decryptSecret(value)).toBe("standalone-secret");
    expect(existsSync(keyFile)).toBe(false);
    expect(binding()).toBeUndefined();
    vi.stubEnv("MASTER_KEY", "");
    expect(() => encryptSecret("missing-key")).toThrow(/stored encryption key is missing/);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("rejects in-process environment changes and lost files after initialization", () => {
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    initializeMasterKey(db, path);
    const value = encryptSecret("bound-secret");
    vi.stubEnv("MASTER_KEY", keyB.toString("base64"));
    expect(() => decryptSecret(value)).toThrow(/does not match the stored/);
    vi.stubEnv("MASTER_KEY", keyA.toString("base64"));
    rmSync(keyFile);
    expect(() => encryptSecret("after-key-loss")).toThrow(/stored encryption key is missing/);
    expect(existsSync(keyFile)).toBe(false);
  });

  it.each([false, true])(
    "publishes a complete single key across concurrent processes (shared DB: %s)",
    async (sharedDb) => {
      const secondPath = sharedDb ? path : join(directory, "second.db");
      if (!sharedDb) initializeTestDatabase(open(secondPath));
      const child = (databasePath: string) =>
        new Promise<string>((accept, reject) => {
          execFile(
            process.execPath,
            [resolve("tests/fixtures/master-key-child.ts"), databasePath],
            {
              env: { ...process.env, DATABASE_PATH: databasePath, MASTER_KEY: "" },
              timeout: 10_000,
              windowsHide: true,
            },
            (error, stdout) => (error ? reject(error) : accept(stdout)),
          );
        });
      const observedSizes: number[] = [];
      const monitor = setInterval(() => {
        if (existsSync(keyFile)) observedSizes.push(readFileSync(keyFile).length);
      }, 1);
      let results: string[];
      try {
        const settled = await Promise.allSettled([child(path), child(secondPath), child(path)]);
        results = settled.map((result) => {
          if (result.status === "rejected") throw result.reason;
          return result.value;
        });
      } finally {
        clearInterval(monitor);
      }
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(digest(readFileSync(keyFile)));
      expect(observedSizes.length).toBeGreaterThan(0);
      expect(observedSizes.every((size) => size === 32)).toBe(true);
      expect(binding()).toBe(`sha256:${results[0]}`);
      expect(readdirSync(directory).filter((name) => name.startsWith(".master-key."))).toEqual([]);
    },
  );
});
