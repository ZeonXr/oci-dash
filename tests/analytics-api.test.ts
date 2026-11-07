import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { closeDatabase } from "@/server/db";
import { login, SESSION_COOKIE } from "@/server/auth";
import { handleApi } from "@/server/router";

const origin = "https://analytics-api.invalid";
let directory = "",
  base = "",
  token = "";
beforeEach(() => {
  closeDatabase();
  base = resolve(process.env.OCI_DASH_TEST_TMP || join(process.cwd(), ".test-tmp"));
  mkdirSync(base, { recursive: true });
  directory = mkdtempSync(join(base, "analytics-api-"));
  vi.stubEnv("DATABASE_PATH", join(directory, "test.db"));
  vi.stubEnv("MASTER_KEY", Buffer.alloc(32, 9).toString("base64"));
  vi.stubEnv("ADMIN_USERNAME", "analytics-test");
  vi.stubEnv("ADMIN_PASSWORD", "analytics-test-password");
  vi.stubEnv("APP_ORIGIN", origin);
  vi.stubEnv("DEMO_MODE", "true");
  token = login("analytics-test", "analytics-test-password").token;
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  if (dirname(directory) !== base || !basename(directory).startsWith("analytics-api-"))
    throw Error("Unexpected cleanup target");
  rmSync(directory, { recursive: true, force: true });
});
function request(path: string, method = "GET", signed = true, requestOrigin = origin) {
  const headers: Record<string, string> = {};
  if (signed) headers.Cookie = `${SESSION_COOKIE}=${token}`;
  if (method !== "GET") headers.Origin = requestOrigin;
  return handleApi(
    new Request(origin + "/api/" + path, { method, headers }),
    path.split("?")[0].split("/"),
  );
}
describe("analytics API boundaries", () => {
  it("requires login for all report types", async () => {
    for (const kind of ["traffic", "costs", "cpu"])
      expect((await request(`analytics/${kind}`, "GET", false)).status).toBe(401);
  });
  it("allows demo inspection and refresh without querying real accounts", async () => {
    for (const kind of ["traffic", "costs", "cpu"]) {
      for (const method of ["GET", "POST"]) {
        const response = await request(`analytics/${kind}`, method);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.source).toBe("demo");
        expect(body.range.timeZone).toBe("UTC");
        expect(body.rows.length).toBeGreaterThan(0);
      }
    }
  });
  it("rejects cross-origin manual cloud reads", async () => {
    expect((await request("analytics/costs", "POST", true, "https://other.invalid")).status).toBe(
      403,
    );
    expect((await request("analytics/cpu", "POST", true, "https://other.invalid")).status).toBe(
      403,
    );
  });
  it("rejects duplicate and invalid calendar parameters", async () => {
    expect((await request("analytics/traffic?accountId=a&accountId=b")).status).toBe(400);
    expect((await request("analytics/costs?startDate=2026-02-30&endDate=2026-03-02")).status).toBe(
      400,
    );
  });
  it("does not accept user supplied tenant identities or arbitrary monitoring queries", async () => {
    expect((await request("analytics/costs?tenantId=other")).status).toBe(400);
    expect((await request("analytics/traffic?query=CpuUtilization")).status).toBe(400);
    expect((await request("analytics/cpu?query=CpuUtilization")).status).toBe(400);
    expect((await request("analytics/cpu?__proto__=ignored")).status).toBe(400);
    expect((await request("analytics/cpu?accountId=a&accountId=b")).status).toBe(400);
    expect((await request("analytics/cpu?startDate=2026-11-01")).status).toBe(400);
  });
});
