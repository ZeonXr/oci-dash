import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePassword } from "../src/lib/password-generator";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("administrator password generator", () => {
  it("generates 32-character passwords with all required character classes", () => {
    const passwords = Array.from({ length: 100 }, () => generatePassword());
    for (const password of passwords) {
      expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
    }
    expect(new Set(passwords).size).toBe(passwords.length);
    // Required characters must not occupy predictable fixed positions.
    expect(passwords.some((password) => !/^[A-Z][a-z][0-9]/.test(password))).toBe(true);
  });

  it("rejects biased byte values instead of reducing them modulo the alphabet size", () => {
    let offset = 0;
    const getRandomValues = vi.fn((buffer: Uint8Array) => {
      for (let index = 0; index < buffer.length; index++) {
        // 255 falls outside every accepted range while selecting characters.
        // After rejection, zero must select A, a, or 0, never V or 5.
        buffer[index] = offset++ % 2 === 0 ? 255 : 0;
      }
      return buffer;
    });
    vi.stubGlobal("crypto", { getRandomValues });
    const password = generatePassword();
    expect(password).toMatch(/^[Aa0]{32}$/);
    expect(password.split("A")).toHaveLength(31);
    expect(password).toContain("a");
    expect(password).toContain("0");
    expect(getRandomValues.mock.calls.length).toBeGreaterThan(1);
  });

  it.each([undefined, {}])("fails closed when Web Crypto is unavailable (%s)", (crypto) => {
    vi.stubGlobal("crypto", crypto);
    const random = vi.spyOn(Math, "random");
    expect(() => generatePassword()).toThrow("无法安全生成密码");
    expect(random).not.toHaveBeenCalled();
  });

  it("propagates secure source failure without falling back to Math.random", () => {
    const failure = new Error("secure source unavailable");
    vi.stubGlobal("crypto", {
      getRandomValues: () => {
        throw failure;
      },
    });
    const random = vi.spyOn(Math, "random");
    expect(() => generatePassword()).toThrow(failure);
    expect(random).not.toHaveBeenCalled();
  });
});
