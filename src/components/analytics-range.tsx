"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Select } from "./ui";
import { Input } from "./ui/input";

export type AnalyticsPreset = "today" | "last7" | "month" | "lastMonth" | "last12Months" | "custom";
export interface AnalyticsDateRange {
  preset: AnalyticsPreset;
  startDate: string;
  endDate: string;
}
export const utcDate = (date = new Date()) => date.toISOString().slice(0, 10);

export function analyticsRange(
  preset: Exclude<AnalyticsPreset, "custom">,
  now = new Date(),
): AnalyticsDateRange {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end);
  if (preset === "last7") start.setUTCDate(start.getUTCDate() - 6);
  if (preset === "month") start.setUTCDate(1);
  if (preset === "lastMonth" || preset === "last12Months") {
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - (preset === "lastMonth" ? 1 : 12));
    end.setUTCDate(0);
  }
  return { preset, startDate: utcDate(start), endDate: utcDate(end) };
}

/** Relative presets follow UTC dates; an explicitly chosen range stays fixed. */
export function useAnalyticsRange(initial: Exclude<AnalyticsPreset, "custom"> = "month") {
  const [range, setRange] = useState(() => analyticsRange(initial));
  const refreshRange = useCallback(() => {
    if (range.preset === "custom") return false;
    const next = analyticsRange(range.preset);
    if (next.startDate === range.startDate && next.endDate === range.endDate) return false;
    setRange(next);
    return true;
  }, [range]);
  useEffect(() => {
    if (range.preset === "custom") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      setRange((current) => {
        if (current.preset === "custom") return current;
        const next = analyticsRange(current.preset);
        return next.startDate === current.startDate && next.endDate === current.endDate
          ? current
          : next;
      });
      timer = setTimeout(update, 86_400_000 - (Date.now() % 86_400_000) + 50);
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [range.preset]);
  return { range, setRange, refreshRange };
}

export function AnalyticsRange({
  value,
  onChange,
  allowYear = false,
  fullMonths = false,
}: {
  value: AnalyticsDateRange;
  onChange: (range: AnalyticsDateRange) => void;
  allowYear?: boolean;
  fullMonths?: boolean;
}) {
  const [editing, setEditing] = useState(value.preset === "custom");
  const [start, setStart] = useState(value.startDate);
  const [end, setEnd] = useState(value.endDate);
  useEffect(() => {
    setStart(value.startDate);
    setEnd(value.endDate);
    setEditing(value.preset === "custom");
  }, [value]);
  const latestDate = fullMonths ? analyticsRange("lastMonth").endDate : utcDate();
  const monthEnd = end ? new Date(`${end}T00:00:00Z`) : null;
  monthEnd?.setUTCDate(monthEnd.getUTCDate() + 1);
  const valid = Boolean(
    start &&
    end &&
    start <= end &&
    end <= latestDate &&
    (!fullMonths || (start.endsWith("-01") && monthEnd?.getUTCDate() === 1)),
  );
  return (
    <div className="analytics-range flex min-w-0 flex-wrap items-center gap-3 max-sm:flex-1 *:data-[slot=select-trigger]:w-auto *:data-[slot=select-trigger]:min-w-36 max-sm:*:data-[slot=select-trigger]:flex-1">
      <Select
        aria-label="时间范围"
        title={`${value.startDate} 至 ${value.endDate}（UTC，包含首尾日期）`}
        value={editing ? "custom" : value.preset}
        onValueChange={(next) => {
          const preset = next as AnalyticsPreset;
          if (preset === "custom") setEditing(true);
          else {
            setEditing(false);
            onChange(analyticsRange(preset));
          }
        }}
      >
        {!fullMonths && <option value="today">今天 · UTC</option>}
        {!fullMonths && <option value="last7">近 7 日 · UTC</option>}
        {!fullMonths && <option value="month">本月 · UTC</option>}
        <option value="lastMonth">上月 · UTC</option>
        {allowYear && <option value="last12Months">过去 12 个完整月 · UTC</option>}
        <option value="custom">自定义 · UTC</option>
      </Select>
      {editing && (
        <>
          <Input
            className="w-40 min-w-0 scheme-light dark:scheme-dark max-sm:w-36"
            type="date"
            aria-label="开始日期（UTC）"
            value={start}
            max={end || latestDate}
            onChange={(event) => setStart(event.target.value)}
          />
          <span className="muted small text-xs text-muted-foreground">至</span>
          <Input
            className="w-40 min-w-0 scheme-light dark:scheme-dark max-sm:w-36"
            type="date"
            aria-label="结束日期（UTC）"
            value={end}
            min={start}
            max={latestDate}
            onChange={(event) => setEnd(event.target.value)}
          />
          <Button
            disabled={!valid}
            onClick={() => onChange({ preset: "custom", startDate: start, endDate: end })}
          >
            应用日期
          </Button>
          {fullMonths && (
            <span className="muted small text-xs text-muted-foreground">
              请选择完整日历月，不含本月。
            </span>
          )}
        </>
      )}
    </div>
  );
}
