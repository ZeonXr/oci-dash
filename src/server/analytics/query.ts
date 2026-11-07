import type { AnalyticsRange } from "@/lib/analytics-contracts";
import { AppError } from "../errors";

export interface TrafficQuery {
  accountId?: string;
  region?: string;
  instanceId?: string;
  vnicId?: string;
  range: AnalyticsRange;
}
export interface CostQuery {
  accountId?: string;
  region?: string;
  service?: string;
  range: AnalyticsRange;
}

const DAY_MS = 86_400_000;
const commonLimits = { accountId: 200, region: 128, startDate: 10, endDate: 10, granularity: 16 };
function fail(message: string): never {
  throw new AppError(message, 400, "INVALID_ANALYTICS_QUERY");
}

function fields(
  input: unknown,
  limits: Record<string, number>,
): Record<string, string | undefined> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    return fail("分析查询参数必须是文本字段对象");
  const result: Record<string, string | undefined> = Object.create(null);
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !Object.hasOwn(limits, key)) fail("分析查询包含不支持的参数");
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== "string") fail("分析查询参数必须是文本");
    if (value.length > limits[key] || /[\p{Cc}\p{Cf}]/u.test(value))
      fail("分析查询参数过长或包含控制字符");
    const trimmed = value.trim();
    // Empty URL fields mean no filter; nonempty calendar fields retain exact syntax validation.
    result[key] = trimmed
      ? key === "startDate" || key === "endDate"
        ? value
        : trimmed
      : undefined;
  }
  return result;
}
const dayString = (time: number) => new Date(time).toISOString().slice(0, 10);
function parseDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail("日期必须使用 YYYY-MM-DD 格式");
  const time = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(time) || dayString(time) !== value) return fail("日期不是有效的日历日期");
  return time;
}
function calendar(now: number) {
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime()))
    return fail("查询时钟无效");
  const today = parseDay(dayString(now));
  const first = new Date(today);
  first.setUTCDate(1);
  return { today, monthStart: first.getTime() };
}
function wireRange(
  start: number,
  end: number,
  granularity: AnalyticsRange["granularity"],
): AnalyticsRange {
  return {
    startDate: dayString(start),
    endDate: dayString(end),
    startTime: new Date(start).toISOString(),
    endTime: new Date(end + DAY_MS).toISOString(),
    granularity,
    timeZone: "UTC",
  };
}
function dates(
  values: Record<string, string | undefined>,
  defaults: { start: number; end: number },
) {
  const start = values.startDate ? parseDay(values.startDate) : defaults.start;
  const end = values.endDate ? parseDay(values.endDate) : defaults.end;
  if (start > end) fail("开始日期不能晚于结束日期");
  return { start, end };
}

export function parseTrafficQuery(input: unknown, now = Date.now()): TrafficQuery {
  const value = fields(input, { ...commonLimits, instanceId: 2048, vnicId: 2048 });
  const granularity = value.granularity ?? "daily";
  if (granularity !== "hourly" && granularity !== "daily") fail("流量粒度仅支持 hourly 或 daily");
  const { today, monthStart } = calendar(now);
  const { start, end } = dates(value, { start: monthStart, end: today });
  if (end > today) fail("流量结束日期不能晚于 UTC 今天");
  if (start < today - 89 * DAY_MS || (end - start) / DAY_MS + 1 > 90)
    fail("流量查询必须位于最近 90 个 UTC 日内");
  return {
    ...(value.accountId ? { accountId: value.accountId } : {}),
    ...(value.region ? { region: value.region } : {}),
    ...(value.instanceId ? { instanceId: value.instanceId } : {}),
    ...(value.vnicId ? { vnicId: value.vnicId } : {}),
    range: wireRange(start, end, granularity),
  };
}

export function parseCostQuery(input: unknown, now = Date.now()): CostQuery {
  const value = fields(input, { ...commonLimits, service: 256 });
  const granularity = value.granularity ?? "daily";
  if (granularity !== "daily" && granularity !== "monthly") fail("费用粒度仅支持 daily 或 monthly");
  const { today, monthStart } = calendar(now);
  const firstDefaultMonth = new Date(monthStart);
  firstDefaultMonth.setUTCMonth(firstDefaultMonth.getUTCMonth() - 12);
  const { start, end } = dates(
    value,
    granularity === "monthly"
      ? { start: firstDefaultMonth.getTime(), end: monthStart - DAY_MS }
      : { start: monthStart, end: today },
  );
  if (granularity === "monthly") {
    const startDate = new Date(start),
      endDate = new Date(end),
      exclusive = new Date(end + DAY_MS);
    if (startDate.getUTCDate() !== 1 || exclusive.getUTCDate() !== 1)
      fail("按月费用查询必须从月初开始并在月末结束");
    if (end >= monthStart) fail("按月费用查询仅支持已结束的完整月份；当前月请使用 daily");
    const months =
      (endDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
      endDate.getUTCMonth() -
      startDate.getUTCMonth() +
      1;
    if (months > 12) fail("按月费用查询最多包含 12 个完整月份");
  } else {
    if (end > today) fail("费用结束日期不能晚于 UTC 今天");
    if ((end - start) / DAY_MS + 1 > 90) fail("按日费用查询最多包含 90 个 UTC 日");
  }
  return {
    ...(value.accountId ? { accountId: value.accountId } : {}),
    ...(value.region ? { region: value.region } : {}),
    ...(value.service ? { service: value.service } : {}),
    range: wireRange(start, end, granularity),
  };
}
