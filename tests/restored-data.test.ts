import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
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
import { ormFor } from "@/server/database/client";
import { accounts, consoleSessions, jobs, settings, users } from "@/server/database/schema";
import { checkRestoredData } from "@/server/runtime/check-data";
import { initializeTestDatabase } from "./fixtures/database";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
const key = Buffer.alloc(32, 0x6e);
const secret = "synthetic-secret-never-print";
const bindingName = "encryption.master-key.sha256";
let directory: string;
let path: string;
let keyFile: string;

function envelope(encryptionKey = key): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(secret), cipher.final()]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}
function edit(change: (orm: ReturnType<typeof ormFor>) => void): void {
  const database = new Database(path);
  try {
    change(ormFor(database));
  } finally {
    database.close();
  }
}
function snapshot() {
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const file = join(directory, name);
      return {
        name,
        digest: createHash("sha256").update(readFileSync(file)).digest("hex"),
        mode: statSync(file).mode,
        modified: statSync(file).mtimeMs,
      };
    });
}

beforeEach(() => {
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "restored-data-"));
  path = join(directory, "restore.db");
  keyFile = join(directory, ".master-key");
  vi.stubEnv("MASTER_KEY", "");
  const database = new Database(path);
  try {
    initializeTestDatabase(database);
  } finally {
    database.close();
  }
  writeFileSync(keyFile, key, { mode: 0o640 });
  edit((orm) => {
    orm
      .insert(settings)
      .values({
        key: bindingName,
        value: `sha256:${createHash("sha256").update(key).digest("hex")}`,
      })
      .run();
    orm
      .insert(users)
      .values({
        id: "admin",
        username: "fixture-admin",
        passwordHash: "fixture-password-hash",
        mfaSecret: envelope(),
        mfaPending: envelope(),
        createdAt: "2026-01-01",
      })
      .run();
    orm
      .insert(accounts)
      .values({
        id: "account",
        name: "Fixture",
        tenancyId: "tenancy",
        userId: "user",
        fingerprint: "fingerprint",
        homeRegion: "region",
        regions: '["region"]',
        credential: envelope(),
        createdAt: "2026-01-01",
      })
      .run();
    for (const state of ["queued", "interrupted", "succeeded"] as const)
      orm
        .insert(jobs)
        .values({
          id: state,
          kind: "sync-account",
          accountId: "account",
          accountName: "Fixture",
          region: "region",
          resourceLock: state,
          state,
          createdAt: "2026-01-01",
          operationJson: "{}",
          requestedBy: "fixture-admin",
          payloadHash: "fixture",
        })
        .run();
    orm
      .insert(consoleSessions)
      .values({
        id: "console",
        instanceId: "instance",
        instanceName: "Fixture instance",
        accountId: "account",
        region: "region",
        ownerUserId: "admin",
        ownerUsername: "fixture-admin",
        ownerSessionHash: "fixture-session",
        state: "failed",
        createdAt: "2026-01-01",
        expiresAt: "2026-01-02",
        lastActivityAt: "2026-01-01",
        cleanupPending: 1,
        slot: 1,
      })
      .run();
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (dirname(resolve(directory)) !== base || !basename(directory).startsWith("restored-data-"))
    throw new Error("Invalid restored-data test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("offline restored-data verification", () => {
  it("authenticates every secret and counts work without changing data or key permissions", () => {
    const before = snapshot();
    expect(checkRestoredData(path)).toEqual({
      administrators: 1,
      accounts: 1,
      encryptedSecrets: 3,
      pendingTasks: 2,
      consoleSessions: 1,
    });
    expect(snapshot()).toEqual(before);
  });

  it("does not create a missing database or key", () => {
    const missing = join(directory, "missing.db");
    expect(() => checkRestoredData(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
    rmSync(keyFile);
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow();
    expect(snapshot()).toEqual(before);
    expect(existsSync(keyFile)).toBe(false);
  });

  it("rejects a valid-length key belonging to a different backup", () => {
    writeFileSync(keyFile, Buffer.alloc(32, 0x5a));
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow(/Encryption key does not match/);
    expect(snapshot()).toEqual(before);
  });

  it("rejects an inconsistent configured key without rewriting the stored key", () => {
    vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 0x5a).toString("base64"));
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow(/MASTER_KEY does not match/);
    expect(snapshot()).toEqual(before);
  });

  it("does not initialize a missing database binding", () => {
    edit((orm) => orm.delete(settings).where(eq(settings.key, bindingName)).run());
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow(/valid encryption key binding/);
    expect(snapshot()).toEqual(before);
  });

  it.each(["account", "mfa", "pending-mfa"])("rejects unauthenticatable %s data", (kind) => {
    const corrupted = envelope(Buffer.alloc(32, 0x5a));
    edit((orm) => {
      if (kind === "account") orm.update(accounts).set({ credential: corrupted }).run();
      else
        orm
          .update(users)
          .set(kind === "mfa" ? { mfaSecret: corrupted } : { mfaPending: corrupted })
          .run();
    });
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow(
      /cannot decrypt existing credentials or MFA data/,
    );
    expect(snapshot()).toEqual(before);
  });

  it("rejects a damaged database without replacing it", () => {
    writeFileSync(path, "not a SQLite database");
    const before = snapshot();
    expect(() => checkRestoredData(path)).toThrow();
    expect(snapshot()).toEqual(before);
  });

  it("prints counts and status without plaintext, keys, or administrator names", () => {
    const before = snapshot();
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/check-data.ts"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, DATABASE_PATH: path, MASTER_KEY: "" },
    });
    expect(JSON.parse(output.split("\n")[0])).toEqual({
      ok: true,
      administrators: 1,
      accounts: 1,
      encryptedSecrets: 3,
      pendingTasks: 2,
      consoleSessions: 1,
    });
    for (const sensitive of [
      secret,
      key.toString("base64"),
      "fixture-admin",
      "fixture-password-hash",
    ])
      expect(output).not.toContain(sensitive);
    expect(snapshot()).toEqual(before);
  });

  it("exits unsuccessfully without exposing secrets or initializing a missing key", () => {
    rmSync(keyFile);
    const before = snapshot();
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/check-data.ts"], {
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, DATABASE_PATH: path, MASTER_KEY: "" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Offline verification failed");
    for (const sensitive of [
      secret,
      key.toString("base64"),
      "fixture-admin",
      "fixture-password-hash",
    ])
      expect(result.stderr).not.toContain(sensitive);
    expect(snapshot()).toEqual(before);
  });
});
