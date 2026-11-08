import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRequestOrigin, configuredOrigin, gatewayRequestUrl } from "@/server/request-origin";

function request(origin: string | undefined, host: string, extra: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:49231/api/auth/login", {
    method: "POST",
    headers: { host, ...(origin === undefined ? {} : { origin }), ...extra },
  });
}

beforeEach(() => vi.stubEnv("APP_ORIGIN", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("request Host and Origin boundary", () => {
  it.each([
    ["http://localhost:3000", "localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:8827", "127.0.0.1:8827", "http://127.0.0.1:8827"],
    ["https://Panel.Example:443", "PANEL.EXAMPLE", "https://panel.example"],
    ["http://panel.example", "panel.example:80", "http://panel.example"],
    ["https://[::1]:8443", "[::1]:8443", "https://[::1]:8443"],
  ])("accepts %s using Host %s instead of an internal upstream URL", (origin, host, expected) => {
    expect(assertRequestOrigin(request(origin, host)).origin).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "null",
    "https://other.example",
    "https://panel.example:8443",
    "file://panel.example",
    "https://user@panel.example",
    "https://panel.example/path",
    "https://panel.example?query=1",
    "https://panel.example#fragment",
    "https://panel.example, https://other.example",
  ])("rejects missing, foreign and malformed Origin %s", (origin) => {
    expect(() => assertRequestOrigin(request(origin, "panel.example"))).toThrow(
      expect.objectContaining({ code: "ORIGIN_MISMATCH" }),
    );
  });

  it.each([
    "",
    "panel.example:",
    "user@panel.example",
    "panel.example/path",
    "panel.example,other.example",
  ])("rejects malformed Host %s", (host) =>
    expect(() => assertRequestOrigin(request("https://panel.example", host))).toThrow(),
  );

  it("does not trust forwarded authority or protocol and rejects cross-site metadata", () => {
    expect(() =>
      assertRequestOrigin(
        request("https://attacker.example", "panel.example", {
          "x-forwarded-host": "attacker.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toThrow();
    expect(() =>
      assertRequestOrigin(
        request("https://panel.example", "panel.example", {
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toThrow();
  });

  it("keeps explicit configuration pinned to its normalized HTTP(S) origin", () => {
    vi.stubEnv("APP_ORIGIN", "https://PANEL.EXAMPLE:443/");
    expect(configuredOrigin()).toBe("https://panel.example");
    expect(assertRequestOrigin(request("https://panel.example", "panel.example")).origin).toBe(
      "https://panel.example",
    );
    expect(() => assertRequestOrigin(request("http://panel.example", "panel.example"))).toThrow();
    expect(() => assertRequestOrigin(request("https://other.example", "other.example"))).toThrow();
    vi.stubEnv("APP_ORIGIN", "ftp://panel.example");
    expect(() => configuredOrigin()).toThrow();
  });
});

describe("gateway raw request targets", () => {
  it("accepts origin-form and matching absolute targets without using an internal port", () => {
    expect(
      gatewayRequestUrl("/api/auth/login?next=1", "panel.example", "https://panel.example")
        .pathname,
    ).toBe("/api/auth/login");
    expect(
      gatewayRequestUrl(
        "https://panel.example/api/auth/login",
        "panel.example",
        "https://panel.example",
      ).origin,
    ).toBe("https://panel.example");
  });

  it.each([
    "https://other.example/api/auth/login",
    "http://panel.example/api/auth/login",
    "//other.example/api/auth/login",
    "/\\other.example/api/auth/login",
    "https://user@panel.example/api/auth/login",
    "file://panel.example/api/auth/login",
    "/api/auth/login#ignored",
  ])("rejects an ambiguous or foreign target %s", (target) => {
    expect(() => gatewayRequestUrl(target, "panel.example", "https://panel.example")).toThrow();
  });
});
