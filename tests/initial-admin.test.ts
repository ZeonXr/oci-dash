import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INITIAL_ADMIN_SETUP_KEY,
  clearInitialAdminPassword,
  createInitialAdminSession,
  ensureInitialAdmin,
  initialAdminState,
} from "@/server/initial-admin";
import { hashPassword, hashToken, verifyPassword } from "@/server/crypto";
import { initializeTestDatabase } from "./fixtures/database";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
const handles: Database.Database[] = [];
const PASSWORD = "first-setup-test-password";
let directory: string, path: string, passwordFile: string, db: Database.Database;
interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}
function open(): Database.Database {
  const handle = new Database(path);
  handle.pragma("busy_timeout=10000");
  handle.pragma("foreign_keys=ON");
  handles.push(handle);
  return handle;
}
const user = () => db.prepare("SELECT * FROM users").get() as User | undefined;
const marker = () =>
  db.prepare("SELECT value FROM settings WHERE key=?").get(INITIAL_ADMIN_SETUP_KEY);
const register = async (name = "owner", password = PASSWORD) =>
  await createInitialAdminSession(db, name, password, 43_200);
beforeEach(() => {
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "initial-admin-test-"));
  path = join(directory, "test.db");
  passwordFile = join(directory, ".initial-admin-password");
  vi.stubEnv("ADMIN_PASSWORD", undefined);
  vi.stubEnv("ADMIN_USERNAME", undefined);
  db = open();
  initializeTestDatabase(db);
});
afterEach(() => {
  handles.splice(0).forEach((handle) => {
    if (handle.open) handle.close();
  });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (
    dirname(resolve(directory)) !== base ||
    !basename(directory).startsWith("initial-admin-test-")
  )
    throw new Error("Invalid initial-admin cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("administrator setup state", () => {
  it.each([undefined, ""])(
    "leaves a new database awaiting setup without an environment password (%s)",
    async (value) => {
      vi.stubEnv("ADMIN_PASSWORD", value);
      await ensureInitialAdmin(db);
      expect(initialAdminState(db)).toBe("required");
      expect(user()).toBeUndefined();
      expect(marker()).toBeUndefined();
      expect(existsSync(passwordFile)).toBe(false);
    },
  );
  it("keeps explicit environment initialization compatible and normalizes its username", async () => {
    vi.stubEnv("ADMIN_USERNAME", "  configured-admin  ");
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    await ensureInitialAdmin(db);
    expect(user()?.username).toBe("configured-admin");
    expect(await verifyPassword(PASSWORD, user()!.password_hash)).toBe(true);
    expect(marker()).toBeTruthy();
    expect(initialAdminState(db)).toBe("completed");
    expect(db.prepare("SELECT count(*) FROM sessions").pluck().get()).toBe(0);
    expect(existsSync(passwordFile)).toBe(false);
  });
  it.each(["short", "x".repeat(257)])(
    "rejects invalid configured passwords without partially initializing (%s)",
    async (value) => {
      vi.stubEnv("ADMIN_PASSWORD", value);
      await expect(ensureInitialAdmin(db)).rejects.toThrowError(
        expect.objectContaining({ code: "VALIDATION_ERROR" }),
      );
      expect(user()).toBeUndefined();
      expect(marker()).toBeUndefined();
    },
  );
  it("backfills the marker for old users without resetting credentials or applying invalid environment values", async () => {
    db.prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)").run(
      "existing",
      "old-owner",
      await hashPassword(PASSWORD),
      "2026-01-01",
    );
    const before = user();
    vi.stubEnv("ADMIN_PASSWORD", "short");
    vi.stubEnv("ADMIN_USERNAME", "new-name");
    await ensureInitialAdmin(db);
    expect(user()).toEqual(before);
    expect(marker()).toBeTruthy();
    await expect(register()).rejects.toThrowError(
      expect.objectContaining({ code: "SETUP_ALREADY_COMPLETED", status: 409 }),
    );
  });
  it("does not reopen setup or apply an environment password after the users table is emptied", async () => {
    await register();
    db.prepare("DELETE FROM users").run();
    db.close();
    db = open();
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    await ensureInitialAdmin(db);
    expect(user()).toBeUndefined();
    expect(initialAdminState(db)).toBe("completed");
    await expect(register()).rejects.toThrowError(
      expect.objectContaining({ code: "SETUP_ALREADY_COMPLETED" }),
    );
  });
  it("refuses to claim an old database containing cloud accounts but no administrator", async () => {
    db.prepare(
      "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,created_at) VALUES(?,'Fixture','tenancy','user','fingerprint','region','[]','fixture-only','2026-01-01')",
    ).run("synthetic-existing-account");
    vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
    await ensureInitialAdmin(db);
    expect(initialAdminState(db)).toBe("unavailable");
    expect(user()).toBeUndefined();
    await expect(register()).rejects.toThrowError(
      expect.objectContaining({ code: "SETUP_UNAVAILABLE", status: 409 }),
    );
  });
  it("treats any existing completion-marker value as closed rather than repairing it into an open setup", async () => {
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      INITIAL_ADMIN_SETUP_KEY,
      "invalid-old-marker",
    );
    await ensureInitialAdmin(db);
    expect(initialAdminState(db)).toBe("completed");
    expect(user()).toBeUndefined();
  });
});

describe("atomic administrator registration", () => {
  it("commits the normalized user, hashed session and marker together without logging or persisting plaintext", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await register("  owner  ");
    expect(result.user).toEqual({ id: user()!.id, username: "owner", mfaEnabled: false });
    expect(await verifyPassword(PASSWORD, user()!.password_hash)).toBe(true);
    const session = db.prepare("SELECT * FROM sessions").get() as {
      token_hash: string;
      user_id: string;
      expires_at: string;
    };
    expect(session.token_hash).toBe(hashToken(result.token));
    expect(session.user_id).toBe(result.user.id);
    expect(Date.parse(session.expires_at)).toBeGreaterThan(Date.now());
    expect(marker()).toBeTruthy();
    expect(JSON.stringify([user(), session, marker()])).not.toContain(PASSWORD);
    expect(JSON.stringify(session)).not.toContain(result.token);
    expect(log).not.toHaveBeenCalled();
    expect(existsSync(passwordFile)).toBe(false);
    const before = user();
    db.close();
    db = open();
    await ensureInitialAdmin(db);
    expect(user()).toEqual(before);
    expect(initialAdminState(db)).toBe("completed");
  });
  it.each([12, 256])("accepts passwords at the %i-character boundary", async (length) => {
    await register("owner", "x".repeat(length));
    expect(await verifyPassword("x".repeat(length), user()!.password_hash)).toBe(true);
  });
  it.each([
    ["   ", PASSWORD],
    ["x".repeat(81), PASSWORD],
    ["owner", "short"],
    ["owner", "x".repeat(257)],
  ])("rejects invalid setup input without writing state", async (name, password) => {
    await expect(register(name, password)).rejects.toThrowError(
      expect.objectContaining({ code: "VALIDATION_ERROR" }),
    );
    expect(user()).toBeUndefined();
    expect(marker()).toBeUndefined();
  });
  it.each(["sessions", "settings", "audit_events"])(
    "rolls back user, session and marker if %s insertion fails",
    async (table) => {
      db.exec(
        `CREATE TRIGGER fail_setup BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'simulated setup failure'); END;`,
      );
      await expect(register()).rejects.toThrow(/simulated setup failure/);
      expect(user()).toBeUndefined();
      expect(marker()).toBeUndefined();
      expect(db.prepare("SELECT count(*) FROM sessions").pluck().get()).toBe(0);
      expect(initialAdminState(db)).toBe("required");
      db.exec("DROP TRIGGER fail_setup");
      await register();
      expect(initialAdminState(db)).toBe("completed");
    },
  );
  it("allows only one registration across concurrent processes", async () => {
    const child = (name: string) =>
      new Promise<string>((accept, reject) => {
        execFile(
          process.execPath,
          [resolve("tests/fixtures/initial-admin-child.ts"), path, name],
          {
            env: { ...process.env, ADMIN_PASSWORD: "", ADMIN_USERNAME: "" },
            timeout: 10_000,
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(error) : accept(stdout)),
        );
      });
    const outcomes = await Promise.allSettled([child("first"), child("second"), child("third")]);
    const results = outcomes.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return JSON.parse(result.value) as { created: boolean; code?: string };
    });
    expect(results.filter((value) => value.created)).toHaveLength(1);
    expect(results.filter((value) => !value.created).map((value) => value.code)).toEqual([
      "SETUP_ALREADY_COMPLETED",
      "SETUP_ALREADY_COMPLETED",
    ]);
    expect(db.prepare("SELECT count(*) FROM users").pluck().get()).toBe(1);
    expect(db.prepare("SELECT count(*) FROM sessions").pluck().get()).toBe(1);
    expect(marker()).toBeTruthy();
    expect(existsSync(passwordFile)).toBe(false);
  });
});

describe("legacy initial-password cleanup", () => {
  it("ignores a legacy password file during initialization and removes it explicitly without changing credentials", async () => {
    writeFileSync(passwordFile, "old-unused-password\n");
    await ensureInitialAdmin(db);
    expect(initialAdminState(db)).toBe("required");
    expect(readFileSync(passwordFile, "utf8")).toBe("old-unused-password\n");
    await register();
    const before = user();
    expect(clearInitialAdminPassword(path)).toBe(true);
    expect(clearInitialAdminPassword(path)).toBe(true);
    expect(user()).toEqual(before);
    expect(existsSync(passwordFile)).toBe(false);
  });
  it("does not recursively remove a directory at the legacy password path", () => {
    mkdirSync(passwordFile);
    writeFileSync(join(passwordFile, "keep"), "unchanged");
    expect(clearInitialAdminPassword(path)).toBe(false);
    expect(readFileSync(join(passwordFile, "keep"), "utf8")).toBe("unchanged");
  });
  it.skipIf(process.platform === "win32")("does not follow a legacy password symlink", () => {
    const target = join(directory, "unrelated");
    writeFileSync(target, "unchanged");
    symlinkSync(target, passwordFile);
    expect(clearInitialAdminPassword(path)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });
});
