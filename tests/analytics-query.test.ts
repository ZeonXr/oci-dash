import { describe, expect, it } from "vitest";
import { parseCostQuery, parseTrafficQuery } from "@/server/analytics/query";

const NOW = Date.parse("2026-11-07T16:30:00.000Z");
const invalid = { status: 400, code: "INVALID_ANALYTICS_QUERY" };

describe("analytics calendar and filter validation", () => {
  it("defaults both daily reports to UTC month-to-date with an exclusive next-day boundary", () => {
    const expected = {
      startDate: "2026-11-01",
      endDate: "2026-11-07",
      startTime: "2026-11-01T00:00:00.000Z",
      endTime: "2026-11-08T00:00:00.000Z",
      granularity: "daily",
      timeZone: "UTC",
    };
    expect(parseTrafficQuery({}, NOW)).toEqual({ range: expected });
    expect(parseCostQuery({}, NOW)).toEqual({ range: expected });
    // Local time in Hong Kong is already November 8, but the billing calendar remains UTC.
    expect(parseCostQuery({}, Date.parse("2026-11-08T00:30:00+08:00")).range).toEqual(expected);
  });

  it("treats empty fields as omitted and preserves selected traffic/resource filters", () => {
    expect(
      parseTrafficQuery(
        {
          accountId: " account-a ",
          region: "us-phoenix-1",
          instanceId: "instance-1",
          vnicId: "vnic-1",
          startDate: "",
          endDate: "",
          granularity: "hourly",
        },
        NOW,
      ),
    ).toMatchObject({
      accountId: "account-a",
      region: "us-phoenix-1",
      instanceId: "instance-1",
      vnicId: "vnic-1",
      range: { granularity: "hourly" },
    });
    expect(
      parseCostQuery({ accountId: "", region: " ", service: "COMPUTE", granularity: "" }, NOW),
    ).toEqual({ service: "COMPUTE", range: parseCostQuery({}, NOW).range });
  });

  it("accepts real leap days and rejects normalized impossible dates or imprecise syntax", () => {
    expect(
      parseCostQuery({ startDate: "2024-02-29", endDate: "2024-02-29" }, NOW).range.endTime,
    ).toBe("2024-03-01T00:00:00.000Z");
    for (const startDate of [
      "2025-02-29",
      "2024-02-30",
      "2026-04-31",
      "2026-00-01",
      "2026-13-01",
      "2026-2-01",
      "2026-02-1",
      "2026-02-01T00:00:00Z",
    ])
      expect(() => parseCostQuery({ startDate, endDate: "2026-11-07" }, NOW)).toThrow(
        expect.objectContaining(invalid),
      );
  });

  it("rejects reversed ranges and future dates", () => {
    for (const parse of [parseTrafficQuery, parseCostQuery]) {
      expect(() => parse({ startDate: "2026-11-07", endDate: "2026-11-06" }, NOW)).toThrow(
        expect.objectContaining(invalid),
      );
      expect(() => parse({ endDate: "2026-11-08" }, NOW)).toThrow(expect.objectContaining(invalid));
    }
  });

  it("permits exactly the newest 90 UTC traffic days and refuses older days even for a short range", () => {
    expect(
      parseTrafficQuery({ startDate: "2026-08-10", endDate: "2026-11-07" }, NOW).range.startDate,
    ).toBe("2026-08-10");
    expect(() =>
      parseTrafficQuery({ startDate: "2026-08-09", endDate: "2026-11-07" }, NOW),
    ).toThrow(expect.objectContaining(invalid));
    expect(() =>
      parseTrafficQuery({ startDate: "2026-08-09", endDate: "2026-08-09" }, NOW),
    ).toThrow(expect.objectContaining(invalid));
  });

  it("limits daily cost span to 90 days without imposing the traffic lookback window", () => {
    expect(
      parseCostQuery({ startDate: "2025-01-01", endDate: "2025-03-31" }, NOW).range.endTime,
    ).toBe("2025-04-01T00:00:00.000Z");
    expect(() => parseCostQuery({ startDate: "2024-01-01", endDate: "2024-03-31" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
  });

  it("defaults monthly costs to the previous twelve complete months across a year boundary", () => {
    expect(parseCostQuery({ granularity: "monthly" }, NOW).range).toEqual({
      startDate: "2025-11-01",
      endDate: "2026-10-31",
      startTime: "2025-11-01T00:00:00.000Z",
      endTime: "2026-11-01T00:00:00.000Z",
      granularity: "monthly",
      timeZone: "UTC",
    });
    expect(
      parseCostQuery({ granularity: "monthly" }, Date.parse("2026-01-01T00:01:00Z")).range,
    ).toMatchObject({ startDate: "2025-01-01", endDate: "2025-12-31" });
  });

  it("accepts a complete leap February and rejects partial/current or thirteen-month queries", () => {
    expect(
      parseCostQuery(
        { granularity: "monthly", startDate: "2024-02-01", endDate: "2024-02-29" },
        NOW,
      ).range.endTime,
    ).toBe("2024-03-01T00:00:00.000Z");
    for (const [startDate, endDate] of [
      ["2026-10-02", "2026-10-31"],
      ["2026-10-01", "2026-10-30"],
      ["2026-11-01", "2026-11-30"],
      ["2025-10-01", "2026-10-31"],
    ])
      expect(() => parseCostQuery({ granularity: "monthly", startDate, endDate }, NOW)).toThrow(
        expect.objectContaining(invalid),
      );
  });

  it("fills a single missing date without replacing the explicit date", () => {
    expect(parseCostQuery({ startDate: "2026-11-03" }, NOW).range).toMatchObject({
      startDate: "2026-11-03",
      endDate: "2026-11-07",
    });
    expect(
      parseCostQuery({ granularity: "monthly", startDate: "2026-01-01" }, NOW).range,
    ).toMatchObject({ startDate: "2026-01-01", endDate: "2026-10-31" });
    expect(
      parseCostQuery({ granularity: "monthly", endDate: "2026-06-30" }, NOW).range.startDate,
    ).toBe("2025-11-01");
  });

  it("enforces mode-specific granularities and allowed query keys", () => {
    expect(() => parseTrafficQuery({ granularity: "monthly" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseCostQuery({ granularity: "hourly" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseCostQuery({ granularity: "DAILY" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseTrafficQuery({ service: "COMPUTE" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseCostQuery({ instanceId: "instance" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseCostQuery({ arbitrary: "anything" }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
  });

  it("rejects non-text input, control characters and overlong filters", () => {
    for (const input of [
      null,
      [],
      "query",
      { accountId: 123 },
      { region: ["us-phoenix-1"] },
      { service: "COMPUTE\n" },
      { service: "abc\u202edef" },
      { service: "x".repeat(257) },
      { accountId: "x".repeat(201) },
    ])
      expect(() => parseCostQuery(input, NOW)).toThrow(expect.objectContaining(invalid));
    expect(() => parseTrafficQuery({ vnicId: "x".repeat(2049) }, NOW)).toThrow(
      expect.objectContaining(invalid),
    );
    expect(() => parseCostQuery(Object.fromEntries([["__proto__", "bad"]]), NOW)).toThrow(
      expect.objectContaining(invalid),
    );
  });
});
