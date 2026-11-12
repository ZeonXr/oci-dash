import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpHandler } from "@/server/runtime/http";
import { json, readJson } from "@/server/http";

const servers: Server[] = [];
async function fixture(
  api = async (request: Request, segments: string[]) =>
    json({
      segments,
      body: request.method === "POST" ? await readJson(request) : null,
    }),
) {
  let ready = true;
  const consoleRequest = vi.fn(async () => json({ console: true }));
  const handler = createHttpHandler({
    ready: () => ready,
    health: () => json({ ok: ready }, ready ? 200 : 503),
    api,
    console: () => ({ handleRequest: consoleRequest, upgrade: vi.fn(), close: vi.fn() }),
    page: async (request, response) => {
      response.setHeader("x-forwarded-host-seen", request.headers["x-forwarded-host"] ?? "absent");
      response.end("Next page");
    },
  });
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin,
    port,
    consoleRequest,
    setReady(value: boolean) {
      ready = value;
    },
  };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
  vi.unstubAllEnvs();
});

describe("single-process HTTP adapter", () => {
  it("preserves decoded API segments, JSON body and the original query", async () => {
    const f = await fixture(async (request, segments) =>
      json({ segments, query: new URL(request.url).search, body: await readJson(request) }),
    );
    const result = await fetch(`${f.origin}/api/accounts/one%20two?region=us-phoenix-1`, {
      method: "POST",
      headers: { Origin: f.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ test: 1 }),
    });
    expect(await result.json()).toEqual({
      segments: ["accounts", "one two"],
      query: "?region=us-phoenix-1",
      body: { test: 1 },
    });
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("retains separate Set-Cookie headers and response status", async () => {
    const f = await fixture(async () => {
      const result = json({ ok: true }, 201);
      result.headers.append("Set-Cookie", "first=one; Path=/; HttpOnly");
      result.headers.append("Set-Cookie", "second=two; Path=/; SameSite=Lax");
      return result;
    });
    const result = await fetch(`${f.origin}/api/example`);
    expect(result.status).toBe(201);
    expect(result.headers.getSetCookie()).toEqual([
      "first=one; Path=/; HttpOnly",
      "second=two; Path=/; SameSite=Lax",
    ]);
  });

  it("retains automatic API method responses without calling business handlers", async () => {
    const api = vi.fn(async () => json({ ok: true }));
    const f = await fixture(api);
    const unsupported = await fetch(f.origin + "/api/example", {
      method: "PUT",
      headers: { Origin: f.origin },
    });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toContain("POST");
    const options = await fetch(f.origin + "/api/example", {
      method: "OPTIONS",
      headers: { Origin: f.origin },
    });
    expect(options.status).toBe(204);
    expect(api).not.toHaveBeenCalled();
    const head = await fetch(f.origin + "/api/health", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("returns 413 for an oversized chunked body instead of resetting its socket", async () => {
    const f = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        `${f.origin}/api/example`,
        { method: "POST", headers: { Origin: f.origin, "Content-Type": "application/json" } },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode!));
        },
      );
      request.on("error", reject);
      request.write("x".repeat(200 * 1024));
      request.end("x".repeat(100 * 1024));
    });
    expect(status).toBe(413);
  });

  it("rejects a mismatched Origin and malformed paths before dispatch", async () => {
    const api = vi.fn(async () => json({ ok: true }));
    const f = await fixture(api);
    expect(
      (
        await fetch(`${f.origin}/api/example`, {
          method: "POST",
          headers: { Origin: "https://foreign.invalid" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${f.origin}/api/%zz`)).status).toBe(400);
    expect(api).not.toHaveBeenCalled();
  });

  it("gates business requests while allowing unhealthy startup probes", async () => {
    const api = vi.fn(async () => json({ ok: true }));
    const f = await fixture(api);
    f.setReady(false);
    for (const path of ["/api/health", "/api/%68ealth", "/api/health/"]) {
      const result = await fetch(f.origin + path);
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({ ok: false });
    }
    expect((await fetch(f.origin + "/api/example")).status).toBe(503);
    expect(api).not.toHaveBeenCalled();
  });

  it("dispatches console APIs before general APIs and applies its smaller body limit", async () => {
    const api = vi.fn(async () => json({ ok: true }));
    const f = await fixture(api);
    expect(await (await fetch(f.origin + "/api/console/session")).json()).toEqual({
      console: true,
    });
    const result = await fetch(f.origin + "/api/console/sessions", {
      method: "POST",
      headers: { Origin: f.origin, "Content-Type": "application/json" },
      body: "x".repeat(20_000),
    });
    expect(result.status).toBe(413);
    expect(api).not.toHaveBeenCalled();
    expect(f.consoleRequest).toHaveBeenCalledTimes(1);
  });

  it("does not cancel a normal POST when its request body ends", async () => {
    const f = await fixture(async (request) => {
      await readJson(request);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return json({ aborted: request.signal.aborted });
    });
    const result = await fetch(f.origin + "/api/example", {
      method: "POST",
      headers: { Origin: f.origin, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(await result.json()).toEqual({ aborted: false });
  });

  it("cancels a query after the client disconnects", async () => {
    let entered!: () => void, cancelled!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve;
    });
    const f = await fixture(async (request) => {
      entered();
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled();
            resolve();
          },
          { once: true },
        ),
      );
      return json({ ok: true });
    });
    const request = httpRequest(f.origin + "/api/slow");
    request.on("error", () => undefined);
    request.end();
    await waiting;
    request.destroy();
    await cancellation;
  });

  it("keeps Next requests streaming and removes untrusted forwarding headers", async () => {
    const f = await fixture();
    const response = await fetch(f.origin + "/overview", {
      headers: { "X-Forwarded-Host": "foreign.invalid" },
    });
    expect(await response.text()).toBe("Next page");
    expect(response.headers.get("x-forwarded-host-seen")).toBe("absent");
  });
});
