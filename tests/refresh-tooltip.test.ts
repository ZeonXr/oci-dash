import { describe, expect, it } from "vitest";
import { refreshTooltip } from "@/components/format";

describe("refreshTooltip", () => {
  const now = new Date(2026, 10, 13, 16, 0);

  it.each([undefined, null, "", "invalid"])("uses a short fallback for %s", (value) => {
    expect(refreshTooltip(value, now)).toBe("刷新");
  });

  it("shows only hours and minutes for the local calendar day", () => {
    expect(refreshTooltip(new Date(2026, 10, 13, 13, 40, 59).toISOString(), now)).toBe(
      "上次更新：13:40",
    );
  });

  it("includes the date for a different day", () => {
    expect(refreshTooltip(new Date(2026, 10, 12, 9, 5).toISOString(), now)).toBe(
      "上次更新：11/12 09:05",
    );
  });

  it("includes the year for a different year", () => {
    expect(refreshTooltip(new Date(2025, 10, 13, 13, 40).toISOString(), now)).toBe(
      "上次更新：2025/11/13 13:40",
    );
  });

  it("changes to a dated label after local midnight", () => {
    const value = new Date(2026, 10, 13, 23, 59).toISOString();
    expect(refreshTooltip(value, new Date(2026, 10, 13, 23, 59))).toBe("上次更新：23:59");
    expect(refreshTooltip(value, new Date(2026, 10, 14, 0, 0))).toBe("上次更新：11/13 23:59");
  });
});
