import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { getDatabase, closeDatabase } from "@/server/db";
import { deleteAccount, getAccount, updateAccount } from "@/server/accounts";
import { createConsoleStore, type ConsoleSessionStore } from "@/server/console/store";

const base = resolve(".test-tmp");
let directory: string;
let previousPath: string | undefined;
let previousPassword: string | undefined;
let store: ConsoleSessionStore;

beforeEach(() => {
  closeDatabase();
  previousPath = process.env.DATABASE_PATH;
  previousPassword = process.env.ADMIN_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "console-account-lock-"));
  process.env.DATABASE_PATH = join(directory, "test.db");
  const db = getDatabase();
  db.prepare(
    "INSERT INTO accounts(id,name,tenancy_id,user_id,fingerprint,home_region,regions,credential,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "test-account",
    "Test account",
    "test-tenancy",
    "test-user",
    "test-fingerprint",
    "ap-tokyo-1",
    '["ap-tokyo-1"]',
    "synthetic-credential",
    "connected",
    new Date().toISOString(),
  );
  store = createConsoleStore(db);
  const now = new Date().toISOString();
  store.reserve({
    id: "test-console",
    instanceId: "test-instance",
    instanceName: "Test instance",
    accountId: "test-account",
    region: "ap-tokyo-1",
    ownerUserId: "test-user",
    ownerUsername: "tester",
    ownerSessionHash: "test-session",
    state: "connected",
    connectionId: "test-connection",
    compartmentId: null,
    credentialRecoveryReady: false,
    creationState: "created",
    createdAt: now,
    expiresAt: now,
    lastActivityAt: now,
    readyAt: now,
    lastError: null,
    cleanupPending: false,
    slot: 1,
  });
});

afterEach(() => {
  closeDatabase();
  if (previousPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousPath;
  if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = previousPassword;
  if (directory && resolve(directory).startsWith(base + sep))
    rmSync(directory, { recursive: true, force: true });
});

it("protects an account used by a console while the job queue is empty", () => {
  expect(getDatabase().prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
  expect(() => deleteAccount("test-account", "tester")).toThrow(/控制台会话/);
  expect(() =>
    updateAccount("test-account", { regions: ["ap-tokyo-1", "ap-singapore-1"] }, "tester"),
  ).toThrow(/控制台会话/);
  expect(getAccount("test-account")?.regions).toEqual(["ap-tokyo-1"]);
});

it("allows renaming but retains the account lock until failed cleanup succeeds", () => {
  expect(updateAccount("test-account", { name: "Renamed" }, "tester").name).toBe("Renamed");
  store.update("test-console", { state: "failed", cleanupPending: true });
  expect(() => deleteAccount("test-account", "tester")).toThrow(/控制台会话/);
  store.finish("test-console", "closed", null);
  deleteAccount("test-account", "tester");
  expect(getAccount("test-account")).toBeNull();
});
