import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOciConfig } from "@/lib/oci-config";

const user = "ocid1.user.oc1..aaaaaaaaexampleuser";
const tenancy = "ocid1.tenancy.oc1..aaaaaaaaexampletenancy";
const fingerprint = "01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef";
const region = "ap-singapore-1";
const fields = { user, fingerprint, tenancy, region };
const body = (changes: Partial<typeof fields> = {}) =>
  Object.entries({ ...fields, ...changes })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
const expected = {
  tenancyId: tenancy,
  userId: user,
  fingerprint,
  homeRegion: region,
  profileName: "DEFAULT",
};

afterEach(() => vi.unstubAllGlobals());

describe("OCI configuration import", () => {
  it("parses the standard OCI console configuration and ignores the private-key path", () => {
    const input = `[DEFAULT]\n${body()}\nkey_file=<path to your private keyfile> # TODO`;
    expect(parseOciConfig(input)).toEqual(expected);
  });

  it("supports BOM, CRLF, whitespace, full-line comments and quoted values with inline comments", () => {
    const input = [
      "\uFEFF   # exported configuration",
      "; second comment",
      " [ DEFAULT ] ; preferred profile",
      `  USER = '${user}'  # comment`,
      ` fingerprint = \"${fingerprint.toUpperCase()}\" ; comment`,
      ` tenancy= \" ${tenancy} \"`,
      ` region = ${region}\t# comment`,
      "",
    ].join("\r\n");
    expect(parseOciConfig(input)).toEqual(expected);
  });

  it("accepts a single named profile and a complete configuration without a section", () => {
    expect(parseOciConfig(`[work-profile]\n${body()}`)).toEqual({
      ...expected,
      profileName: "work-profile",
    });
    expect(parseOciConfig(body())).toEqual(expected);
  });

  it("prefers the explicit DEFAULT profile without merging another profile's values", () => {
    const input = `[OTHER]\n${body({ region: "uk-london-1", user: "not-a-valid-user" })}\n[DEFAULT]\n${body()}\n[LAST]\nregion=us-phoenix-1`;
    expect(parseOciConfig(input)).toEqual(expected);
  });

  it("rejects multiple non-DEFAULT profiles, even when one is complete", () => {
    expect(() => parseOciConfig(`[FIRST]\n${body()}\n[SECOND]\nregion=us-phoenix-1`)).toThrow(
      /多个配置档/,
    );
  });

  it("does not fill an incomplete DEFAULT profile from another profile or an unsectioned preamble", () => {
    const missingUser = body()
      .split("\n")
      .filter((line) => !line.startsWith("user="))
      .join("\n");
    expect(() => parseOciConfig(`[DEFAULT]\n${missingUser}\n[OTHER]\nuser=${user}`)).toThrow(
      /缺少必填项/,
    );
    expect(() => parseOciConfig(`user=${user}\n[DEFAULT]\n${missingUser}`)).toThrow(/缺少必填项/);
    expect(() => parseOciConfig(`user=${user}\n[WORK]\n${missingUser}`)).toThrow(/多个配置档/);
  });

  it.each(Object.keys(fields) as (keyof typeof fields)[])(
    "rejects a missing required %s field",
    (key) => {
      const input = body()
        .split("\n")
        .filter((line) => !line.startsWith(`${key}=`))
        .join("\n");
      expect(() => parseOciConfig(input)).toThrow(/缺少必填项/);
    },
  );

  it.each([
    ["user", "ocid1.tenancy.oc1..wrongresource"],
    ["tenancy", "ocid1.user.oc1..wrongresource"],
    ["fingerprint", "01:23:45:67"],
    ["region", "https://example.invalid"],
    ["region", "US-PHOENIX-1"],
    ["user", "ocid1.user." + "a".repeat(513)],
  ] as const)("rejects an invalid %s value without echoing it", (key, value) => {
    try {
      parseOciConfig(body({ [key]: value }));
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/格式不正确/);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("rejects empty values and whitespace-only input", () => {
    expect(() => parseOciConfig(body({ region: "   # not a value" }))).toThrow(/不能为空/);
    expect(() => parseOciConfig(" \uFEFF\r\n\t")).toThrow(/请粘贴/);
  });

  it("rejects duplicate required keys even when their values are identical or key case differs", () => {
    expect(() => parseOciConfig(`${body()}\nuser=${user}`)).toThrow(/重复/);
    expect(() => parseOciConfig(`${body()}\nUSER=${user}`)).toThrow(/重复/);
    expect(() => parseOciConfig(`[DEFAULT]\n${body()}\n[DEFAULT]\n${body()}`)).toThrow(/重复/);
  });

  it("requires whitespace before inline comments and does not strip markers inside quoted values", () => {
    expect(() => parseOciConfig(body({ region: `${region}#suffix` }))).toThrow(/格式不正确/);
    expect(() => parseOciConfig(body({ region: `\"${region} # suffix\"` }))).toThrow(/格式不正确/);
    expect(() => parseOciConfig(body({ region: `\"${region}\";suffix` }))).toThrow(/引号后/);
    expect(parseOciConfig(body({ region: `\"${region}\" ; suffix` }))).toEqual(expected);
  });

  it("reports malformed syntax and quotes in Chinese without leaking the supplied value or profile name", () => {
    const sensitive = "PRIVATE_SENSITIVE_MARKER";
    for (const input of [
      `[${sensitive}] broken\n${body()}`,
      body({ region: `\"${sensitive}` }),
      `${body()}\n${sensitive}`,
      `[${sensitive}]\n${body()}\n[ANOTHER]\n${body()}`,
    ]) {
      try {
        parseOciConfig(input);
        throw new Error("expected parse failure");
      } catch (error) {
        expect((error as Error).message).toMatch(/[\u4e00-\u9fff]/);
        expect((error as Error).message).not.toContain(sensitive);
      }
    }
  });

  it("ignores key_file and other fields without loading files or URLs", () => {
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    const parsed = parseOciConfig(
      `${body()}\nkey_file=https://example.invalid/secret.pem\nkey_file=C:\\does-not-exist\\key.pem\npass_phrase=ignored-value\nextra_field=\"unfinished-ignored-value`,
    );
    expect(parsed).toEqual(expected);
    expect(parsed).not.toHaveProperty("key_file");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("enforces a 16 KiB UTF-8 byte limit, including non-ASCII comments", () => {
    const prefix = `${body()}\n#`;
    const exact = prefix + "a".repeat(16 * 1024 - new TextEncoder().encode(prefix).byteLength);
    expect(parseOciConfig(exact)).toEqual(expected);
    expect(() => parseOciConfig(exact + "a")).toThrow(/16 KiB/);
    const multiByte = `${body()}\n#${"密".repeat(6000)}`;
    expect(multiByte.length).toBeLessThan(16 * 1024);
    expect(() => parseOciConfig(multiByte)).toThrow(/16 KiB/);
  });
});
