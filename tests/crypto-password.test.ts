import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/server/crypto";

describe("asynchronous password computations", () => {
  it("accepts existing scrypt hashes and keeps the same storage format and parameters", async () => {
    const password = "synthetic-password-compatibility";
    const salt = "00112233445566778899aabbccddeeff";
    const digest = scryptSync(password, salt, 64, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    expect(await verifyPassword(password, `scrypt$${salt}$${digest.toString("hex")}`)).toBe(true);
    const stored = await hashPassword(password);
    expect(stored).toMatch(/^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword("a-different-password", stored)).toBe(false);
    expect(await verifyPassword(password, "scrypt$invalid$bad-digest")).toBe(false);
  });

  it("admits two computations, rejects excess work immediately and releases capacity after completion", async () => {
    const stored = await hashPassword("synthetic-capacity-test-password");
    const pending = [
      hashPassword("another-synthetic-password"),
      verifyPassword("synthetic-capacity-test-password", stored),
    ];
    try {
      await expect(hashPassword("over-capacity-password")).rejects.toMatchObject({
        status: 429,
        code: "PASSWORD_BUSY",
      });
      expect(await verifyPassword("unused", "malformed")).toBe(false);
    } finally {
      await Promise.all(pending);
    }
    expect(await verifyPassword("synthetic-capacity-test-password", stored)).toBe(true);
  });
});
