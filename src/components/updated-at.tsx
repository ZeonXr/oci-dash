"use client";

import { formatDate } from "./format";

export function UpdatedAt({
  value,
  label = "更新于",
  title = "数据更新时间",
}: {
  value?: string | null;
  label?: string;
  title?: string;
}) {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const date = new Date(value);
  const localTime = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  });
  const tooltip =
    title +
    "\n" +
    localTime.format(date) +
    "（" +
    localTime.resolvedOptions().timeZone +
    "，本地时间）";
  return (
    <span className="updated-at" title={tooltip}>
      <time dateTime={date.toISOString()}>
        {label} {formatDate(value)}
      </time>
    </span>
  );
}
