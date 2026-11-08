import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearInitialAdminPassword, ensureInitialAdmin } from "@/server/initial-admin";
import { hashPassword, verifyPassword } from "@/server/crypto";

const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
const handles: Database.Database[] = [];
let directory: string;
let path: string;
let passwordFile: string;
let db: Database.Database;
const schema = `CREATE TABLE users (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);`;
interface User {
  id: string;
  username: string;
  password_hash: string;
  created_at: string;
}
function open(): Database.Database {
  const handle = new Database(path);
  handle.pragma("busy_timeout=10000");
  handles.push(handle);
  return handle;
}
function user(): User {
  return db.prepare("SELECT * FROM users").get() as User;
}
function password(): string {
  return readFileSync(passwordFile, "utf8").trim();
}
function savedPassword(): string {
  const value = randomBytes(32).toString("base64url");
  writeFileSync(passwordFile, value + "\n", { mode: 0o600 });
  return value;
}
beforeEach(() => {
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "initial-admin-test-"));
  path = join(directory, "test.db");
  passwordFile = join(directory, ".initial-admin-password");
  vi.stubEnv("ADMIN_PASSWORD", undefined);
  vi.stubEnv("ADMIN_USERNAME", undefined);
  db = open();
  db.exec(schema);
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
    throw new Error("Invalid initial-admin test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});

describe("first administrator initialization", () => {
  it.each([undefined, ""])(
    "initializes an empty database without a configured password (%s)",
    (configured) => {
      vi.stubEnv("ADMIN_PASSWORD", configured);
      const logged = vi.spyOn(console, "log").mockImplementation(() => {});
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const errored = vi.spyOn(console, "error").mockImplementation(() => {});
      ensureInitialAdmin(db, path);
      expect(user().username).toBe("admin");
      expect(password()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(password(), "base64url")).toHaveLength(32);
      expect(verifyPassword(password(), user().password_hash)).toBe(true);
      expect(user().password_hash).not.toContain(password());
      expect(logged).not.toHaveBeenCalled();
      expect(warned).not.toHaveBeenCalled();
      expect(errored).not.toHaveBeenCalled();
      if (process.platform !== "win32") expect(statSync(passwordFile).mode & 0o777).toBe(0o600);
      expect(
        readdirSync(directory).filter((name) => name.startsWith(".initial-admin-password.")),
      ).toEqual([]);
    },
  );

  it("keeps the same user and password when a database is reopened", () => {
    ensureInitialAdmin(db, path);
    const before = user();
    const initial = password();
    db.close();
    db = open();
    ensureInitialAdmin(db, path);
    expect(user()).toEqual(before);
    expect(password()).toBe(initial);
    expect(db.prepare("SELECT COUNT(*) AS total FROM users").get()).toEqual({ total: 1 });
  });

  it("preserves explicit initialization credentials without creating a plaintext file", () => {
    vi.stubEnv("ADMIN_USERNAME", "configured-admin");
    vi.stubEnv("ADMIN_PASSWORD", "configured-test-password");
    ensureInitialAdmin(db, path);
    expect(user().username).toBe("configured-admin");
    expect(verifyPassword("configured-test-password", user().password_hash)).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it.each(["x", "x".repeat(11), "x".repeat(257)])(
    "rejects an invalid explicit password before creating a user or file (%s)",
    (value) => {
      vi.stubEnv("ADMIN_PASSWORD", value);
      expect(() => ensureInitialAdmin(db, path)).toThrow(/12–256/);
      expect(user()).toBeUndefined();
      expect(existsSync(passwordFile)).toBe(false);
    },
  );

  it.each([12, 256])("accepts the configured password boundary of %i characters", (length) => {
    vi.stubEnv("ADMIN_PASSWORD", "x".repeat(length));
    ensureInitialAdmin(db, path);
    expect(verifyPassword("x".repeat(length), user().password_hash)).toBe(true);
  });

  it("never resets an existing user or validates changed initialization variables", () => {
    const hash = hashPassword("already-existing-password");
    db.prepare("INSERT INTO users VALUES(?,?,?,?)").run("existing", "owner", hash, "2026-01-01");
    const before = user();
    vi.stubEnv("ADMIN_USERNAME", "renamed-admin");
    vi.stubEnv("ADMIN_PASSWORD", "short");
    ensureInitialAdmin(db, path);
    expect(user()).toEqual(before);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it("does not regenerate a missing initial password file after initialization", () => {
    ensureInitialAdmin(db, path);
    const before = user();
    rmSync(passwordFile);
    ensureInitialAdmin(db, path);
    expect(user()).toEqual(before);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it("recovers the published password when the administrator insert was rolled back", () => {
    db.exec(
      "CREATE TRIGGER fail_admin BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END;",
    );
    expect(() => ensureInitialAdmin(db, path)).toThrow(/simulated interruption/);
    expect(user()).toBeUndefined();
    const published = password();
    db.exec("DROP TRIGGER fail_admin");
    db.close();
    db = open();
    ensureInitialAdmin(db, path);
    expect(password()).toBe(published);
    expect(verifyPassword(published, user().password_hash)).toBe(true);
  });

  it("rejects a conflicting environment password after file publication without replacing it", () => {
    const published = savedPassword();
    vi.stubEnv("ADMIN_PASSWORD", "different-valid-test-password");
    expect(() => ensureInitialAdmin(db, path)).toThrow(/conflicts with the saved/);
    expect(user()).toBeUndefined();
    expect(password()).toBe(published);
    vi.stubEnv("ADMIN_PASSWORD", published);
    ensureInitialAdmin(db, path);
    expect(verifyPassword(published, user().password_hash)).toBe(true);
  });

  it.each(["", "truncated", "x".repeat(44), "x".repeat(42) + "!\n"])(
    "refuses an incomplete or invalid published file (%s)",
    (content) => {
      writeFileSync(passwordFile, content);
      expect(() => ensureInitialAdmin(db, path)).toThrow(
        /Invalid initial administrator password file/,
      );
      expect(user()).toBeUndefined();
      expect(readFileSync(passwordFile, "utf8")).toBe(content);
    },
  );

  it("never replaces a directory at the password location", () => {
    mkdirSync(passwordFile);
    writeFileSync(join(passwordFile, "keep"), "unrelated-file");
    expect(() => ensureInitialAdmin(db, path)).toThrow(
      /Invalid initial administrator password file/,
    );
    expect(clearInitialAdminPassword(path)).toBe(false);
    expect(readFileSync(join(passwordFile, "keep"), "utf8")).toBe("unrelated-file");
    expect(user()).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlinks without reading, changing or deleting their target",
    () => {
      const target = join(directory, "unrelated-secret");
      const content = randomBytes(32).toString("base64url") + "\n";
      writeFileSync(target, content);
      symlinkSync(target, passwordFile);
      expect(() => ensureInitialAdmin(db, path)).toThrow(
        /Invalid initial administrator password file/,
      );
      expect(clearInitialAdminPassword(path)).toBe(false);
      expect(readFileSync(target, "utf8")).toBe(content);
      expect(user()).toBeUndefined();
    },
  );

  it("removes the initial file after a password change, tolerates absence and never touches the database", () => {
    ensureInitialAdmin(db, path);
    db.prepare("UPDATE users SET password_hash=?").run(hashPassword("new-administrator-password"));
    const changed = user();
    expect(clearInitialAdminPassword(path)).toBe(true);
    expect(clearInitialAdminPassword(path)).toBe(true);
    ensureInitialAdmin(db, path);
    expect(user()).toEqual(changed);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it("serializes concurrent processes so one complete published password matches the single user", async () => {
    const child = () =>
      new Promise<string>((accept, reject) => {
        execFile(
          process.execPath,
          ["--import", "tsx", resolve("tests/fixtures/initial-admin-child.ts"), path],
          {
            env: { ...process.env, ADMIN_PASSWORD: "", ADMIN_USERNAME: "" },
            timeout: 10_000,
            windowsHide: true,
          },
          (error, stdout) => (error ? reject(error) : accept(stdout)),
        );
      });
    const samples: string[] = [];
    const monitor = setInterval(() => {
      if (existsSync(passwordFile)) samples.push(readFileSync(passwordFile, "utf8"));
    }, 1);
    let outcomes: PromiseSettledResult<string>[];
    try {
      outcomes = await Promise.allSettled([child(), child(), child()]);
    } finally {
      clearInterval(monitor);
    }
    const results = outcomes.map((outcome) => {
      if (outcome.status === "rejected") throw outcome.reason;
      return JSON.parse(outcome.value) as { id: string; digest: string; matches: boolean };
    });
    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    expect(results.every((result) => result.matches)).toBe(true);
    expect(new Set(results.map((result) => result.digest))).toEqual(
      new Set([createHash("sha256").update(password()).digest("hex")]),
    );
    expect(samples.length).toBeGreaterThan(0);
    expect(samples.every((content) => content === password() + "\n")).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS total FROM users").get()).toEqual({ total: 1 });
    expect(
      readdirSync(directory).filter((name) => name.startsWith(".initial-admin-password.")),
    ).toEqual([]);
  });
});
