"use client";

import { useEffect, useState } from "react";
import { Button, Select } from "./ui";

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
    <div className="analytics-range">
      <Select
        aria-label="时间范围"
        title={`${value.startDate} 至 ${value.endDate}（UTC，包含首尾日期）`}
        value={editing ? "custom" : value.preset}
        onChange={(event) => {
          const preset = event.target.value as AnalyticsPreset;
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
          <input
            type="date"
            aria-label="开始日期（UTC）"
            value={start}
            max={end || latestDate}
            onChange={(event) => setStart(event.target.value)}
          />
          <span className="muted small">至</span>
          <input
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
          {fullMonths && <span className="muted small">请选择完整日历月，不含本月。</span>}
        </>
      )}
    </div>
  );
}
