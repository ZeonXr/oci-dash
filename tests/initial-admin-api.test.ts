import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/server/db";
import { handleApi } from "@/server/router";
import { login, requireUser, SESSION_COOKIE } from "@/server/auth";
import { encryptSecret, hashPassword, hashToken } from "@/server/crypto";
import { INITIAL_ADMIN_SETUP_KEY } from "@/server/initial-admin";

const origin = "https://setup.example.invalid";
const password = "web-setup-test-password";
const base = resolve(process.env.OCI_DASH_TEST_TMP || ".test-tmp");
let directory: string, path: string;
beforeEach(() => {
  closeDatabase();
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "initial-admin-api-"));
  path = join(directory, "test.db");
  vi.stubEnv("DATABASE_PATH", path);
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 91).toString("base64"));
  vi.stubEnv("ADMIN_PASSWORD", undefined);
  vi.stubEnv("ADMIN_USERNAME", undefined);
  vi.stubEnv("APP_ORIGIN", origin);
  getDatabase();
});
afterEach(() => {
  closeDatabase();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (dirname(resolve(directory)) !== base || !basename(directory).startsWith("initial-admin-api-"))
    throw new Error("Invalid setup API test cleanup path");
  rmSync(directory, { recursive: true, force: true });
});
function request(route: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(origin + "/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: new URL(origin).host, origin, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const status = () => handleApi(request("auth/status"), ["auth", "status"]);
const setup = (
  body: unknown = { username: "owner", password },
  headers: Record<string, string> = {},
) => handleApi(request("auth/setup", body, headers), ["auth", "setup"]);
const count = (table: "users" | "sessions") =>
  getDatabase().prepare(`SELECT count(*) FROM ${table}`).pluck().get();
const marker = () =>
  getDatabase().prepare("SELECT value FROM settings WHERE key=?").get(INITIAL_ADMIN_SETUP_KEY);

describe("first administrator HTTP setup", () => {
  it("reports an unauthenticated, uncached setup state without creating a user or password file", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ setupRequired: true });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
    expect(existsSync(join(directory, ".initial-admin-password"))).toBe(false);
  });

  it("creates the administrator and an immediately usable secure session, surviving reopen", async () => {
    const response = await setup({ username: "  owner  ", password });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({
      user: { id: expect.any(String), username: "owner", mfaEnabled: false },
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("; Secure");
    const token = cookie.match(/oci_dash_session=([^;]+)/)![1];
    expect(
      requireUser(request("auth/me", undefined, { cookie: `${SESSION_COOKIE}=${token}` })),
    ).toEqual(body.user);
    expect(count("users")).toBe(1);
    expect(count("sessions")).toBe(1);
    expect(marker()).toBeTruthy();
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    closeDatabase();
    vi.stubEnv("ADMIN_PASSWORD", "short");
    vi.stubEnv("ADMIN_USERNAME", "different");
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    expect(login("owner", password).user).toEqual(body.user);
    expect(existsSync(join(directory, ".initial-admin-password"))).toBe(false);
  });

  it("does not call rate-limited password login after creating the administrator", async () => {
    getDatabase()
      .prepare("INSERT INTO login_attempts VALUES(?,?,?)")
      .run(hashToken("owner"), 10, Date.now());
    const response = await setup();
    expect(response.status).toBe(201);
    expect(response.headers.has("set-cookie")).toBe(true);
    expect(() => login("owner", password)).toThrowError(
      expect.objectContaining({ code: "LOGIN_RATE_LIMIT" }),
    );
    expect(count("users")).toBe(1);
    expect(count("sessions")).toBe(1);
  });

  it("checks the shared rate limit before creating any administrator state", async () => {
    getDatabase().prepare("INSERT INTO login_attempts VALUES('global',?,?)").run(40, Date.now());
    const response = await setup();
    expect(response.status).toBe(429);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toMatchObject({ code: "LOGIN_RATE_LIMIT" });
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
    expect(marker()).toBeUndefined();
    getDatabase().prepare("DELETE FROM login_attempts").run();
    expect((await setup()).status).toBe(201);
  });

  it("allows only one of concurrent registration requests", async () => {
    const responses = await Promise.all([
      setup({ username: "one", password }),
      setup({ username: "two", password }),
    ]);
    expect(responses.map((value) => value.status).sort()).toEqual([201, 409]);
    expect(await responses.find((value) => value.status === 409)!.json()).toMatchObject({
      code: "SETUP_ALREADY_COMPLETED",
    });
    expect(count("users")).toBe(1);
    expect(count("sessions")).toBe(1);
  });

  it("returns the closed-setup response before parsing another setup payload", async () => {
    expect((await setup()).status).toBe(201);
    const response = await setup({ username: "", password: "short" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SETUP_ALREADY_COMPLETED" });
    expect(count("users")).toBe(1);
    expect(count("sessions")).toBe(1);
  });

  it("keeps setup closed after all users are deleted and the service restarts", async () => {
    await setup();
    getDatabase().prepare("DELETE FROM users").run();
    closeDatabase();
    vi.stubEnv("ADMIN_PASSWORD", password);
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    const response = await setup();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SETUP_ALREADY_COMPLETED" });
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
  });

  it("backfills legacy users without resetting their credentials", async () => {
    const hash = hashPassword(password);
    getDatabase()
      .prepare("INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)")
      .run("legacy-admin", "legacy", hash, new Date().toISOString());
    closeDatabase();
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    expect(marker()).toBeTruthy();
    expect(login("legacy", password).user.id).toBe("legacy-admin");
    expect((await setup()).status).toBe(409);
    expect(getDatabase().prepare("SELECT password_hash FROM users").pluck().get()).toBe(hash);
  });

  it("refuses web and environment takeover of an old cloud database lacking an administrator", async () => {
    getDatabase()
      .prepare(
        "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "fixture-account",
        "Existing fixture",
        "ocid1.tenancy.fixture",
        "ocid1.user.fixture",
        "fixture",
        "ap-tokyo-1",
        "[]",
        encryptSecret("synthetic-credential"),
        new Date().toISOString(),
      );
    closeDatabase();
    vi.stubEnv("ADMIN_PASSWORD", password);
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    const response = await setup();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SETUP_UNAVAILABLE" });
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
  });

  it.each([
    { username: "  ", password },
    { username: "x".repeat(81), password },
    { username: "owner", password: "short" },
    { username: "owner", password: "x".repeat(257) },
    { username: "owner", password, extra: true },
  ])("rejects invalid setup input without creating authentication state", async (body) => {
    const response = await setup(body);
    expect(response.status).toBe(400);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
    expect(marker()).toBeUndefined();
  });

  it.each<Record<string, string>>([
    { origin: "https://other.invalid" },
    { origin: "null" },
    { origin: "" },
    { "sec-fetch-site": "cross-site" },
    { host: "other.invalid", "x-forwarded-host": new URL(origin).host },
  ])("rejects cross-site or invalid-origin setup before rate limits or writes", async (headers) => {
    const response = await setup(undefined, headers);
    expect(response.status).toBe(403);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(await response.json()).toMatchObject({ code: "ORIGIN_MISMATCH" });
    expect(count("users")).toBe(0);
    expect(marker()).toBeUndefined();
    expect(getDatabase().prepare("SELECT count(*) FROM login_attempts").pluck().get()).toBe(0);
  });

  it("rolls back a failed session insert and allows a complete retry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    getDatabase().exec(
      "CREATE TRIGGER fail_setup BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'simulated session failure'); END;",
    );
    const response = await setup();
    expect(response.status).toBe(500);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(count("users")).toBe(0);
    expect(count("sessions")).toBe(0);
    expect(marker()).toBeUndefined();
    expect(JSON.stringify(error.mock.calls)).not.toContain(password);
    getDatabase().exec("DROP TRIGGER fail_setup");
    expect((await setup()).status).toBe(201);
  });

  it("cleans a legacy password file only after successful setup", async () => {
    const legacy = join(directory, ".initial-admin-password");
    writeFileSync(legacy, "unused-legacy-test-password\n", { mode: 0o600 });
    expect((await setup({ username: "owner", password: "short" })).status).toBe(400);
    expect(existsSync(legacy)).toBe(true);
    expect((await setup()).status).toBe(201);
    expect(existsSync(legacy)).toBe(false);
  });

  it("keeps successful setup and its session when legacy-file cleanup fails", async () => {
    mkdirSync(join(directory, ".initial-admin-password"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await setup();
    expect(response.status).toBe(201);
    expect(response.headers.has("set-cookie")).toBe(true);
    expect(count("users")).toBe(1);
    expect(count("sessions")).toBe(1);
    expect(warn.mock.calls).toEqual([["Initial administrator password file cleanup failed."]]);
  });

  it("continues to support an explicit environment-created administrator", async () => {
    closeDatabase();
    vi.stubEnv("ADMIN_PASSWORD", password);
    vi.stubEnv("ADMIN_USERNAME", "environment-owner");
    expect(await (await status()).json()).toEqual({ setupRequired: false });
    expect(login("environment-owner", password).user.username).toBe("environment-owner");
    expect((await setup()).status).toBe(409);
    expect(existsSync(join(directory, ".initial-admin-password"))).toBe(false);
  });
});
