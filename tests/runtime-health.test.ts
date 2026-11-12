import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { checkRuntimeHealth } from "@/server/runtime/health";

let server: Server;
let port: number;
let response: { status: number; body: string; hang?: boolean; location?: string };
let requests: { method: string; path: string }[];

beforeEach(async () => {
  requests = [];
  response = { status: 200, body: JSON.stringify({ ok: true, version: "health-fixture" }) };
  server = createServer((request, res) => {
    requests.push({ method: request.method ?? "", path: request.url ?? "" });
    if (response.hang) return;
    res.writeHead(response.status, {
      "Content-Type": "application/json",
      ...(response.location ? { Location: response.location } : {}),
    });
    res.end(response.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a local test port.");
  port = address.port;
});

afterEach(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("HTTP application health probe", () => {
  it("reads only the local readiness endpoint", async () => {
    expect(await checkRuntimeHealth({ port })).toBe(true);
    expect(requests).toEqual([{ method: "GET", path: "/api/health" }]);
  });

  it("uses the configured application port", async () => {
    vi.stubEnv("PORT", String(port));
    expect(await checkRuntimeHealth()).toBe(true);
  });

  it.each([
    { status: 503, body: JSON.stringify({ ok: false }) },
    { status: 401, body: JSON.stringify({ ok: true }) },
    { status: 200, body: JSON.stringify({ ok: false }) },
    { status: 200, body: JSON.stringify({ version: "health-fixture" }) },
    { status: 200, body: "not-json" },
    { status: 200, body: "null" },
  ])("rejects an unavailable or invalid health response: $status $body", async (result) => {
    response = result;
    expect(await checkRuntimeHealth({ port })).toBe(false);
  });

  it("does not follow a redirect instead of a readiness response", async () => {
    response = { status: 302, body: "", location: `http://127.0.0.1:${port}/elsewhere` };
    expect(await checkRuntimeHealth({ port })).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it("rejects invalid ports without making a request", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const invalid of [0, -1, 65536, 1.5, NaN])
      expect(await checkRuntimeHealth({ port: invalid })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports an unavailable listener", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await checkRuntimeHealth({ port })).toBe(false);
  });

  it("bounds a stalled HTTP probe to two seconds", async () => {
    response.hang = true;
    const startedAt = Date.now();
    expect(await checkRuntimeHealth({ port })).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(4500);
  });
});
