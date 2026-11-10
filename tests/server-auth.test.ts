import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import * as OTPAuth from "otpauth";
import { DrizzleQueryError } from "drizzle-orm";
import type { InstanceSummary } from "@/lib/contracts";
import { closeDatabase, getDatabase } from "@/server/db";
import {
  assertSameOrigin,
  beginMfa,
  changePassword,
  confirmMfa,
  disableMfa,
  login,
  logout,
  requireUser,
  SESSION_COOKIE,
  sessionCookie,
} from "@/server/auth";
import { decryptSecret, encryptSecret, hashToken } from "@/server/crypto";
import {
  checkPrivateKey,
  createAccount,
  deleteAccount,
  getAccount,
  getCredentialSnapshot,
  getCredentials,
  listAccounts,
  setAccountStatus,
  updateAccount,
  type AccountInput,
} from "@/server/accounts";
import { readJson } from "@/server/http";
import { accountPatchSchema, validateOperation } from "@/server/validation";
import { getJobStore } from "@/server/jobs";
import { safeErrorMessage } from "@/server/jobs/store";
import { safeMessage } from "@/server/errors";
import { getInstance, listInstances, saveInventory } from "@/server/inventory";
import { handleApi } from "@/server/router";

const cloud = vi.hoisted(() => ({
  verify: vi.fn(),
  inventory: vi.fn(),
  metrics: vi.fn(),
  createOptions: vi.fn(),
  securityGroups: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("@/server/oci/adapter", () => ({ ociAdapter: cloud }));
const ORIGIN = "https://oci-dash.test";
const USERNAME = "test-admin";
const PASSWORD = "test-only-password-901";
const directories: { path: string; base: string }[] = [];
let privateKey: string, fingerprint: string;
const fakeOcid = (kind: string, suffix = "test") => `ocid1.${kind}.oc1..${suffix}`;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "der" },
  });
  privateKey = pair.privateKey;
  fingerprint = createHash("md5").update(pair.publicKey).digest("hex").match(/.{2}/g)!.join(":");
});
beforeEach(() => {
  closeDatabase();
  const base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "oci-dash-auth-test-"));
  directories.push({ path, base });
  vi.stubEnv("DATABASE_PATH", join(path, "auth.sqlite"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", USERNAME);
  vi.stubEnv("ADMIN_PASSWORD", PASSWORD);
  vi.stubEnv("APP_ORIGIN", ORIGIN);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T12:00:05Z"));
  for (const mock of Object.values(cloud)) mock.mockReset();
  getDatabase();
});
afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const { path, base } of directories.splice(0)) {
    const target = resolve(path);
    if (dirname(target) !== base || !basename(target).startsWith("oci-dash-auth-test-"))
      throw Error("Unsafe auth test cleanup path");
    rmSync(target, { recursive: true, force: true });
  }
});
function request(
  path: string,
  options: { method?: string; token?: string; body?: unknown; origin?: string | null } = {},
): Request {
  const method = options.method ?? "GET";
  return new Request(ORIGIN + "/api/" + path, {
    method,
    headers: {
      host: new URL(ORIGIN).host,
      ...(options.token ? { cookie: `${SESSION_COOKIE}=${options.token}` } : {}),
      ...(options.origin === null ? {} : { origin: options.origin ?? ORIGIN }),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}
const loggedIn = () => login(USERNAME, PASSWORD);
const otp = (secret: string) =>
  new OTPAuth.TOTP({
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate();
function accountInput(patch: Partial<AccountInput> = {}): AccountInput {
  return {
    name: "Test OCI",
    tenancyId: fakeOcid("tenancy"),
    userId: fakeOcid("user"),
    fingerprint,
    privateKey,
    homeRegion: "ap-singapore-1",
    regions: ["ap-singapore-1", "ap-tokyo-1"],
    ...patch,
  };
}
function instance(accountId: string, suffix: string, state = "RUNNING"): InstanceSummary {
  return {
    id: fakeOcid("instance", suffix),
    accountId,
    accountName: "Test OCI",
    displayName: suffix,
    region: "ap-singapore-1",
    availabilityDomain: "TEST:AD-1",
    compartmentId: fakeOcid("tenancy"),
    state,
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    createdAt: new Date().toISOString(),
    vnics: [],
    bootVolumes: [],
    tags: {},
    syncedAt: new Date().toISOString(),
  };
}

describe("session and request boundaries", () => {
  it.each([
    ["http://localhost:3000", "localhost:3000", false],
    ["http://127.0.0.1:8827", "127.0.0.1:8827", false],
    ["https://panel.example", "panel.example:443", true],
  ])(
    "logs in and removes cookies using validated Origin %s without APP_ORIGIN",
    async (origin, host, secure) => {
      vi.stubEnv("APP_ORIGIN", undefined);
      const make = (path: string, token?: string, body?: unknown) =>
        new Request(`http://127.0.0.1:49231/api/${path}`, {
          method: "POST",
          headers: {
            origin,
            host,
            "content-type": "application/json",
            "x-forwarded-host": "untrusted.example",
            "x-forwarded-proto": "http",
            ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const result = await handleApi(
        make("auth/login", undefined, { username: USERNAME, password: PASSWORD }),
        ["auth", "login"],
      );
      expect(result.status).toBe(200);
      const cookie = result.headers.get("set-cookie")!;
      expect(cookie.includes("; Secure")).toBe(secure);
      const token = cookie.match(/oci_dash_session=([^;]+)/)![1];
      const removed = await handleApi(make("auth/logout", token), ["auth", "logout"]);
      expect(removed.status).toBe(200);
      expect(removed.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(removed.headers.get("set-cookie")!.includes("; Secure")).toBe(secure);
      expect(() => requireUser(request("auth/me", { token }))).toThrow();
    },
  );

  it("rejects a forged forwarded host and never issues a cookie for an unvalidated origin", async () => {
    vi.stubEnv("APP_ORIGIN", undefined);
    const incoming = new Request("http://127.0.0.1:49231/api/auth/login", {
      method: "POST",
      headers: {
        host: "panel.example",
        origin: "https://other.example",
        "x-forwarded-host": "other.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    const result = await handleApi(incoming, ["auth", "login"]);
    expect(result.status).toBe(403);
    expect(result.headers.has("set-cookie")).toBe(false);
    expect(() => sessionCookie("not-issued", incoming)).toThrow();
    expect(getDatabase().prepare("SELECT count(*) FROM login_attempts").pluck().get()).toBe(0);
  });

  it("removes a legacy generated initial password only after a successful password change", () => {
    const db = getDatabase();
    const path = join(dirname(db.name), ".initial-admin-password");
    writeFileSync(path, PASSWORD + "\n", { mode: 0o600 });
    const current = login(USERNAME, PASSWORD);
    expect(() =>
      changePassword(current.user, "wrong-password", "replacement-password-901"),
    ).toThrow();
    expect(existsSync(path)).toBe(true);
    changePassword(current.user, PASSWORD, "replacement-password-901");
    expect(existsSync(path)).toBe(false);
    expect(() => requireUser(request("auth/me", { token: current.token }))).toThrow();
    expect(login(USERNAME, "replacement-password-901").user.id).toBe(current.user.id);
    closeDatabase();
    getDatabase();
    expect(existsSync(path)).toBe(false);
  });

  it("keeps a committed password change successful when initial-password cleanup fails", () => {
    const current = loggedIn();
    mkdirSync(join(dirname(getDatabase().name), ".initial-admin-password"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() =>
        changePassword(current.user, PASSWORD, "replacement-password-901"),
      ).not.toThrow();
      expect(login(USERNAME, "replacement-password-901").user.id).toBe(current.user.id);
      expect(warn.mock.calls).toEqual([["Initial administrator password file cleanup failed."]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns empty persisted resources on a fresh database without querying OCI", async () => {
    const { token } = loggedIn();
    for (const [path, expected] of [
      ["accounts", { accounts: [], syncJobs: [] }],
      ["instances", { instances: [] }],
      ["jobs", { jobs: [], total: 0, page: 1, pageSize: 100 }],
    ] as const) {
      const response = await handleApi(request(path, { token }), path.split("/"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    const dashboard = await handleApi(request("dashboard", { token }), ["dashboard"]);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      accounts: [],
      instances: [],
      jobs: [],
      totals: { accounts: 0, instances: 0, running: 0, stopped: 0, storageGb: 0, regions: 0 },
    });
    const refreshed = await handleApi(
      request("inventory/refresh", { method: "POST", token, body: { mode: "auto" } }),
      ["inventory", "refresh"],
    );
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toEqual({ jobs: [], accounts: [] });
    expect(getJobStore().listJobs()).toEqual([]);
    for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
  });

  it("returns recent terminal context separately from every active instance job", async () => {
    const { token } = loggedIn();
    const account = createAccount(accountInput(), USERNAME);
    const store = getJobStore();
    const operation = (resourceId: string) => ({
      kind: "public-ip-rotate" as const,
      accountId: account.id,
      region: account.homeRegion,
      resourceId,
      payload: {},
    });
    const failed = store.enqueueOperation(operation("failed-instance"), USERNAME);
    store.claimNext("fixture-worker");
    store.finish(failed.id, "fixture-worker", "failed", undefined, "fixture failure");
    const uncertain = store.enqueueOperation(operation("uncertain-instance"), USERNAME);
    store.claimNext("fixture-worker");
    store.finish(uncertain.id, "fixture-worker", "succeeded", {
      synchronization: {
        status: "completed-with-warnings",
        warnings: ["fixture inventory warning"],
      },
    });
    const active = store.enqueueOperation(operation("active-instance"), USERNAME);
    const response = await handleApi(request("jobs?active=true", { token }), ["jobs"]);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.jobs.map((job: { id: string }) => job.id)).toEqual([active.id]);
    expect(result.recentJobs.map((job: { id: string }) => job.id).sort()).toEqual(
      [failed.id, uncertain.id, active.id].sort(),
    );
    expect(
      result.recentJobs.find((job: { id: string }) => job.id === uncertain.id).result
        .synchronization.status,
    ).toBe("completed-with-warnings");
    for (const mock of Object.values(cloud)) expect(mock).not.toHaveBeenCalled();
  });

  it("bootstraps login, stores only a token hash, expires sessions and revokes logout", async () => {
    const response = await handleApi(
      request("auth/login", { method: "POST", body: { username: USERNAME, password: PASSWORD } }),
      ["auth", "login"],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      user: { username: USERNAME, mfaEnabled: false },
    });
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Secure");
    const token = setCookie.match(/oci_dash_session=([^;]+)/)![1];
    const row = getDatabase().prepare("SELECT token_hash FROM sessions").get() as {
      token_hash: string;
    };
    expect(row.token_hash).toBe(hashToken(token));
    expect(row.token_hash).not.toBe(token);
    expect(requireUser(request("auth/me", { token })).username).toBe(USERNAME);
    logout(request("auth/logout", { token }));
    expect(() => requireUser(request("auth/me", { token }))).toThrow();
    const second = loggedIn();
    vi.setSystemTime(new Date(Date.now() + 13 * 60 * 60 * 1000));
    expect(() => requireUser(request("auth/me", { token: second.token }))).toThrow();
  });
  it("rejects unauthenticated APIs and rejects missing/cross-site Origin before login processing", async () => {
    for (const path of ["accounts", "settings", "jobs", "instances"]) {
      const response = await handleApi(request(path), path.split("/"));
      expect(response.status).toBe(401);
    }
    for (const origin of [null, "https://other.test"]) {
      const response = await handleApi(
        request("auth/login", {
          method: "POST",
          origin,
          body: { username: USERNAME, password: PASSWORD },
        }),
        ["auth", "login"],
      );
      expect(response.status).toBe(403);
    }
    const count = getDatabase().prepare("SELECT count(*) AS total FROM login_attempts").get() as {
      total: number;
    };
    expect(count.total).toBe(0);
    expect(() =>
      assertSameOrigin(
        new Request(ORIGIN + "/api/accounts", {
          headers: { Origin: ORIGIN, "Sec-Fetch-Site": "cross-site" },
        }),
      ),
    ).toThrow();
  });
  it("bounds random-username login work and prunes old attempt records", () => {
    const db = getDatabase();
    db.prepare("INSERT INTO login_attempts(subject,count,window_start) VALUES('global',40,?)").run(
      Date.now(),
    );
    expect(() => login("unknown-random-name", "incorrect")).toThrow(
      expect.objectContaining({ code: "LOGIN_RATE_LIMIT" }),
    );
    expect(
      db
        .prepare("SELECT subject FROM login_attempts WHERE subject=?")
        .get(hashToken("unknown-random-name")),
    ).toBeUndefined();
    db.prepare("UPDATE login_attempts SET window_start=?").run(Date.now() - 20 * 60 * 1000);
    db.prepare(
      "INSERT INTO login_attempts(subject,count,window_start) VALUES('expired-other',1,?)",
    ).run(Date.now() - 20 * 60 * 1000);
    loggedIn();
    expect(
      db.prepare("SELECT subject FROM login_attempts WHERE subject='expired-other'").get(),
    ).toBeUndefined();
  });
  it("revokes every session after a password change and does not reset it on database reopen", () => {
    const a = loggedIn(),
      b = loggedIn();
    expect(() => changePassword(a.user, "wrong", "replacement-password-902")).toThrow();
    changePassword(a.user, PASSWORD, "replacement-password-902");
    for (const token of [a.token, b.token])
      expect(() => requireUser(request("auth/me", { token }))).toThrow();
    closeDatabase();
    expect(() => login(USERNAME, PASSWORD)).toThrow();
    expect(login(USERNAME, "replacement-password-902").user.username).toBe(USERNAME);
  });
});

describe("MFA activation, replay and recovery", () => {
  it("requires a verified pending setup and revokes other existing sessions when enabled", async () => {
    const current = loggedIn(),
      other = loggedIn();
    const setup = await beginMfa(current.user, PASSWORD);
    expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(false);
    expect(() => confirmMfa(current.user, "not-a-code", hashToken(current.token))).toThrow();
    expect(requireUser(request("auth/me", { token: other.token })).mfaEnabled).toBe(false);
    const codes = confirmMfa(current.user, otp(setup.secret), hashToken(current.token));
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(true);
    expect(() => requireUser(request("auth/me", { token: other.token }))).toThrow();
    const stored = getDatabase()
      .prepare("SELECT mfa_secret,mfa_pending,recovery_codes FROM users")
      .get() as { mfa_secret: string; mfa_pending: string | null; recovery_codes: string };
    expect(stored.mfa_secret).not.toContain(setup.secret);
    expect(stored.mfa_pending).toBeNull();
    for (const code of codes) expect(stored.recovery_codes).not.toContain(code.replaceAll("-", ""));
    expect(() => login(USERNAME, PASSWORD)).toThrow(
      expect.objectContaining({ code: "MFA_REQUIRED" }),
    );
  });
  it("rejects expired pending enrollment without locking out password login", async () => {
    const auth = loggedIn(),
      setup = await beginMfa(auth.user, PASSWORD);
    vi.setSystemTime(new Date(Date.now() + 11 * 60 * 1000));
    expect(() => confirmMfa(auth.user, otp(setup.secret))).toThrow();
    expect(loggedIn().user.mfaEnabled).toBe(false);
  });
  it("allows each recovery code once, removes its hash, and rejects TOTP replay", async () => {
    const auth = loggedIn(),
      setup = await beginMfa(auth.user, PASSWORD);
    const codes = confirmMfa(auth.user, otp(setup.secret), hashToken(auth.token));
    expect(login(USERNAME, PASSWORD, codes[0].toUpperCase()).user.mfaEnabled).toBe(true);
    expect(() => login(USERNAME, PASSWORD, codes[0])).toThrow(
      expect.objectContaining({ code: "INVALID_MFA" }),
    );
    const stored = getDatabase().prepare("SELECT recovery_codes FROM users").get() as {
      recovery_codes: string;
    };
    expect(JSON.parse(stored.recovery_codes)).toHaveLength(9);
    expect(JSON.parse(stored.recovery_codes)).not.toContain(
      hashToken(codes[0].replaceAll("-", "")),
    );
    const code = otp(setup.secret);
    expect(login(USERNAME, PASSWORD, code).user.mfaEnabled).toBe(true);
    expect(() => login(USERNAME, PASSWORD, code)).toThrow(
      expect.objectContaining({ code: "INVALID_MFA" }),
    );
    vi.setSystemTime(new Date(Date.now() + 30000));
    expect(login(USERNAME, PASSWORD, otp(setup.secret)).user.mfaEnabled).toBe(true);
  });
  it("requires a factor to disable MFA and revokes other sessions and all old recovery codes", async () => {
    const current = loggedIn(),
      setup = await beginMfa(current.user, PASSWORD);
    const codes = confirmMfa(current.user, otp(setup.secret), hashToken(current.token));
    const other = login(USERNAME, PASSWORD, codes[0]);
    expect(() => disableMfa(current.user, PASSWORD, "invalid", hashToken(current.token))).toThrow();
    disableMfa(current.user, PASSWORD, codes[1], hashToken(current.token));
    expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(false);
    expect(() => requireUser(request("auth/me", { token: other.token }))).toThrow();
    const row = getDatabase().prepare("SELECT mfa_secret,recovery_codes FROM users").get() as {
      mfa_secret: string | null;
      recovery_codes: string;
    };
    expect(row.mfa_secret).toBeNull();
    expect(JSON.parse(row.recovery_codes)).toEqual([]);
  });
  it("rejects a TOTP already consumed by login before disabling MFA", async () => {
    const current = loggedIn(),
      setup = await beginMfa(current.user, PASSWORD);
    confirmMfa(current.user, otp(setup.secret), hashToken(current.token));
    const usedCode = otp(setup.secret);
    login(USERNAME, PASSWORD, usedCode);
    expect(() => disableMfa(current.user, PASSWORD, usedCode, hashToken(current.token))).toThrow();
    expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(true);
    vi.setSystemTime(new Date(Date.now() + 30000));
    disableMfa(current.user, PASSWORD, otp(setup.secret), hashToken(current.token));
    expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(false);
  });
  it.each(["totp", "recovery"])(
    "rolls back %s consumption when MFA session revocation fails",
    async (factor) => {
      const current = loggedIn(),
        setup = await beginMfa(current.user, PASSWORD);
      const codes = confirmMfa(current.user, otp(setup.secret), hashToken(current.token));
      const db = getDatabase();
      const code = factor === "totp" ? otp(setup.secret) : codes[0];
      const before = db.prepare("SELECT mfa_secret,recovery_codes,last_otp_step FROM users").get();
      db.exec(`CREATE TRIGGER reject_session_revocation BEFORE DELETE ON sessions
        BEGIN SELECT RAISE(ABORT, 'synthetic revocation failure'); END`);
      expect(() => disableMfa(current.user, PASSWORD, code)).toThrow(
        "synthetic revocation failure",
      );
      expect(db.prepare("SELECT mfa_secret,recovery_codes,last_otp_step FROM users").get()).toEqual(
        before,
      );
      expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(true);
      db.exec("DROP TRIGGER reject_session_revocation");
      disableMfa(current.user, PASSWORD, code, hashToken(current.token));
      expect(requireUser(request("auth/me", { token: current.token })).mfaEnabled).toBe(false);
    },
  );
});

describe("credential storage, account revisions and jobs", () => {
  it("keeps failed ORM query parameters out of HTTP errors, logs and task messages", async () => {
    const { token } = loggedIn();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const input = accountInput({ name: "sensitive-account-label" });
    getDatabase().exec(`CREATE TRIGGER reject_orm_insert BEFORE INSERT ON accounts
      BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END`);
    try {
      const response = await handleApi(
        request("accounts", { method: "POST", token, body: input }),
        ["accounts"],
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "服务暂时不可用，请查看运行日志后重试",
        code: "INTERNAL_ERROR",
      });
      expect(log).toHaveBeenCalledWith("request failed:", "synthetic storage failure");
      let failed = false;
      try {
        createAccount(input, USERNAME);
      } catch (error) {
        failed = true;
        expect(safeErrorMessage(error)).toBe("synthetic storage failure");
      }
      expect(failed).toBe(true);
      expect(listAccounts()).toEqual([]);
      const wrapped = new DrizzleQueryError("INSERT INTO accounts VALUES (?)", [input.name]);
      expect(wrapped.message).toContain(input.name);
      expect(safeMessage(wrapped)).toBe("数据库操作失败，请稍后重试");
      expect(safeErrorMessage(wrapped)).toBe("数据库操作失败，请稍后重试");
    } finally {
      log.mockRestore();
    }
  });

  it("encrypts with fresh nonces and rejects tampered ciphertext or a wrong master key", () => {
    const secret = "unit-test-sensitive-data",
      encrypted = encryptSecret(secret),
      another = encryptSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(another).not.toBe(encrypted);
    expect(decryptSecret(encrypted)).toBe(secret);
    const parts = encrypted.split("."),
      bytes = Buffer.from(parts[3], "base64url");
    bytes[0] ^= 1;
    parts[3] = bytes.toString("base64url");
    expect(() => decryptSecret(parts.join("."))).toThrow();
    vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 8).toString("base64"));
    expect(() => decryptSecret(encrypted)).toThrow();
  });
  it("validates the actual RSA public-key fingerprint and never returns private credentials in account DTOs", async () => {
    expect(() => checkPrivateKey(privateKey, fingerprint.toUpperCase())).not.toThrow();
    expect(() => checkPrivateKey(privateKey, "00:".repeat(15) + "00")).toThrow(
      expect.objectContaining({ code: "KEY_FINGERPRINT_MISMATCH" }),
    );
    const auth = loggedIn(),
      account = createAccount(accountInput(), USERNAME);
    const row = getDatabase()
      .prepare("SELECT credential FROM accounts WHERE id=?")
      .get(account.id) as { credential: string };
    expect(row.credential).toMatch(/^v1\./);
    expect(row.credential).not.toContain("BEGIN PRIVATE KEY");
    expect(getCredentials(account.id).privateKey).toBe(privateKey.trim());
    const response = await handleApi(request("accounts", { token: auth.token }), ["accounts"]);
    const body = await response.text();
    expect(body).not.toContain("credential");
    expect(body).not.toContain("PRIVATE KEY");
    expect(body).not.toContain(row.credential);
    expect(getAccount(account.id)).not.toHaveProperty("revision");
  });
  it("a name-only HTTP PATCH preserves regions, encrypted credentials and revision", async () => {
    const auth = loggedIn(),
      account = createAccount(accountInput(), USERNAME),
      snapshot = getCredentialSnapshot(account.id);
    const cached = instance(account.id, "rename-cache");
    saveInventory(account.id, { instances: [cached], warnings: [], regions: account.regions });
    const before = getDatabase()
      .prepare("SELECT credential FROM accounts WHERE id=?")
      .get(account.id);
    expect(accountPatchSchema.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    const response = await handleApi(
      request(`accounts/${account.id}`, {
        method: "PATCH",
        token: auth.token,
        body: { name: "renamed" },
      }),
      ["accounts", account.id],
    );
    expect(response.status).toBe(200);
    expect(getAccount(account.id)?.name).toBe("renamed");
    expect(getAccount(account.id)?.regions).toEqual(account.regions);
    expect(getCredentialSnapshot(account.id).revision).toBe(snapshot.revision);
    expect(
      getDatabase().prepare("SELECT credential FROM accounts WHERE id=?").get(account.id),
    ).toEqual(before);
    expect(listInstances()[0].accountName).toBe("renamed");
    expect(getInstance(cached.id).accountName).toBe("renamed");
  });
  it("blocks identity/region changes and removal for every unfinished job state while allowing a rename", () => {
    const account = createAccount(accountInput(), USERNAME),
      store = getJobStore();
    const job = store.enqueueOperation(
      {
        kind: "instance-start",
        accountId: account.id,
        region: account.homeRegion,
        resourceId: fakeOcid("instance"),
        payload: {},
      },
      USERNAME,
    );
    for (const state of ["queued", "running", "retrying", "cancel_requested", "interrupted"]) {
      getDatabase().prepare("UPDATE jobs SET state=? WHERE id=?").run(state, job.id);
      expect(() => updateAccount(account.id, { privateKey }, USERNAME)).toThrow(
        expect.objectContaining({ code: "ACCOUNT_BUSY" }),
      );
      expect(() => updateAccount(account.id, { regions: [account.homeRegion] }, USERNAME)).toThrow(
        expect.objectContaining({ code: "ACCOUNT_BUSY" }),
      );
      expect(() => deleteAccount(account.id, USERNAME)).toThrow(
        expect.objectContaining({ code: "ACCOUNT_BUSY" }),
      );
    }
    expect(updateAccount(account.id, { name: "safe rename" }, USERNAME).name).toBe("safe rename");
    getDatabase().prepare("UPDATE jobs SET state='queued' WHERE id=?").run(job.id);
    store.cancelJob(job.id);
    expect(updateAccount(account.id, { regions: [account.homeRegion] }, USERNAME).regions).toEqual([
      account.homeRegion,
    ]);
  });
  it("rejects stale verification status callbacks after a credential/scope revision changes", async () => {
    const auth = loggedIn(),
      account = createAccount(accountInput(), USERNAME),
      snapshot = getCredentialSnapshot(account.id);
    let finish!: (value: { tenancyName: string; homeRegion: string; regions: string[] }) => void;
    cloud.verify.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const responsePromise = handleApi(
      request(`accounts/${account.id}/verify`, { method: "POST", token: auth.token }),
      ["accounts", account.id, "verify"],
    );
    expect(cloud.verify).toHaveBeenCalledTimes(1);
    updateAccount(account.id, { privateKey }, USERNAME);
    expect(getCredentialSnapshot(account.id).revision).toBe(snapshot.revision + 1);
    finish({
      tenancyName: "test",
      homeRegion: "ap-singapore-1",
      regions: ["ap-singapore-1", "eu-test-1"],
    });
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "ACCOUNT_CHANGED" });
    expect(getAccount(account.id)?.status).toBe("unchecked");
    expect(getAccount(account.id)?.regions).toEqual(account.regions);
    expect(setAccountStatus(account.id, "error", "old failure", snapshot.revision)).toBe(false);
    expect(getAccount(account.id)?.lastError).toBeNull();
  });
  it("explicit connection verification resolves automatic names and preserves custom names", async () => {
    const auth = loggedIn();
    for (const [index, name] of [undefined, "My OCI account"].entries()) {
      const account = createAccount(
        accountInput({ name, tenancyId: fakeOcid("tenancy", "named" + index) }),
        USERNAME,
      );
      cloud.verify.mockResolvedValueOnce({
        tenancyName: "Cloud tenant",
        homeRegion: account.homeRegion,
        regions: account.regions,
      });
      const response = await handleApi(
        request(`accounts/${account.id}/verify`, { method: "POST", token: auth.token }),
        ["accounts", account.id, "verify"],
      );
      expect(response.status).toBe(200);
      expect((await response.json()).account).toMatchObject({
        name: name ?? "Cloud tenant",
        nameSource: name ? "custom" : "tenancy",
      });
    }
    expect(cloud.verify).toHaveBeenCalledTimes(2);
  });
  it("connection verification reports discovered regions without expanding the configured scope", async () => {
    const auth = loggedIn(),
      account = createAccount(accountInput(), USERNAME);
    const before = getCredentialSnapshot(account.id).revision;
    cloud.verify.mockResolvedValue({
      tenancyName: "test",
      homeRegion: "ap-singapore-1",
      regions: ["ap-singapore-1", "ap-tokyo-1", "eu-frankfurt-1"],
    });
    const response = await handleApi(
      request(`accounts/${account.id}/verify`, { method: "POST", token: auth.token }),
      ["accounts", account.id, "verify"],
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      regions: ["ap-singapore-1", "ap-tokyo-1", "eu-frankfurt-1"],
    });
    expect(getAccount(account.id)?.regions).toEqual(account.regions);
    expect(getCredentialSnapshot(account.id).revision).toBe(before);
  });
});

describe("bounded JSON and incomplete inventory", () => {
  it("cancels a body without Content-Length as soon as it crosses the byte budget", async () => {
    let pulled = 0,
      cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(131072));
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const incoming = new Request(ORIGIN + "/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readJson(incoming)).rejects.toMatchObject({ status: 413 });
    expect(pulled).toBe(3);
    expect(cancelled).toBe(true);
  });
  it("reads valid JSON split across UTF-8 byte boundaries and rejects invalid types or JSON", async () => {
    const bytes = new TextEncoder().encode('{"name":"新加坡"}');
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1));
      },
    });
    expect(
      await readJson(
        new Request(ORIGIN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit),
      ),
    ).toEqual({ name: "新加坡" });
    await expect(
      readJson(new Request(ORIGIN, { method: "POST", body: "{}" })),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      readJson(
        new Request(ORIGIN, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("preserves prior instances on partial sync and removes missing ones only after a complete sync", () => {
    const account = createAccount(accountInput(), USERNAME),
      a = instance(account.id, "a"),
      b = instance(account.id, "b");
    saveInventory(account.id, { instances: [a, b], warnings: [], regions: account.regions });
    saveInventory(account.id, {
      instances: [{ ...a, state: "STOPPED" }],
      warnings: ["区域读取失败"],
      regions: account.regions,
    });
    expect(listInstances()).toHaveLength(2);
    expect(getInstance(a.id).state).toBe("STOPPED");
    expect(getInstance(b.id).state).toBe("RUNNING");
    expect(getAccount(account.id)?.status).toBe("error");
    saveInventory(account.id, { instances: [a], warnings: [], regions: account.regions });
    expect(listInstances()).toHaveLength(1);
    expect(getAccount(account.id)?.status).toBe("connected");
  });
  it("preserves explicit operation preconditions and rejects unimplemented force flags", () => {
    const base = {
      accountId: "11111111-1111-4111-8111-111111111111",
      region: "ap-singapore-1",
      resourceId: fakeOcid("instance"),
    };
    const payload = { displayName: "new", expectedState: "STOPPED", etag: "e1" };
    expect(validateOperation({ ...base, kind: "instance-rename", payload }).payload).toEqual(
      payload,
    );
    expect(() =>
      validateOperation({ ...base, kind: "instance-stop", payload: { force: true } }),
    ).toThrow();
    const ipv6 = { vnicId: fakeOcid("vnic"), ipv6SubnetCidr: "2001:db8::/64" };
    expect(validateOperation({ ...base, kind: "ipv6-assign", payload: ipv6 }).payload).toEqual(
      ipv6,
    );
  });
});
