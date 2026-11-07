/** Browser/server-safe decimal text arithmetic. No binary floating-point addition is performed. */
const MAX_DIGITS = 512;
interface Parts {
  coefficient: bigint;
  scale: number;
}

function parts(value: unknown): Parts | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > MAX_DIGITS) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d{1,4}))?$/i.exec(text);
  if (!match) return null;
  const whole = match[2] ?? "0",
    fraction = match[3] ?? match[4] ?? "";
  let digits = (whole + fraction).replace(/^0+/, "") || "0";
  let scale = fraction.length - Number(match[5] ?? 0);
  if (Math.abs(scale) > MAX_DIGITS) return null;
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  if (digits.length > MAX_DIGITS) return null;
  return { coefficient: BigInt(digits) * (match[1] === "-" ? -1n : 1n), scale };
}
function format({ coefficient, scale }: Parts): string {
  if (coefficient === 0n) return "0";
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const decimal = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, "")
    : digits;
  return (negative ? "-" : "") + decimal;
}
/** Null means absent/invalid or a JS number whose magnitude already lost integer precision. */
export function normalizeDecimal(value: unknown): string | null {
  const parsed = parts(value);
  return parsed ? format(parsed) : null;
}
/** Unknown members make the sum unknown; an empty series is not a confirmed zero. */
export function sumDecimalAmounts(
  values: Iterable<string | number | null | undefined>,
): string | null {
  let count = 0;
  let total: Parts = { coefficient: 0n, scale: 0 };
  for (const value of values) {
    const parsed = parts(value);
    if (!parsed) return null;
    count++;
    const scale = Math.max(total.scale, parsed.scale);
    total = {
      coefficient:
        total.coefficient * 10n ** BigInt(scale - total.scale) +
        parsed.coefficient * 10n ** BigInt(scale - parsed.scale),
      scale,
    };
  }
  return count ? format(total) : null;
}
