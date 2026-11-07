"use client";

import type { AnalyticsMetadata, AnalyticsStatus } from "@/lib/analytics-contracts";
import { Alert } from "./ui";
import { utcTimestamp } from "./analytics-chart";

export function AnalyticsStatusNote({
  report,
}: {
  report: AnalyticsMetadata & { status: AnalyticsStatus; warnings: string[] };
}) {
  const notes = [
    ...new Set([
      ...report.warnings,
      ...report.accounts.flatMap((account) =>
        account.status === "error" || account.status === "duplicate" || account.status === "partial"
          ? [
              `${account.accountName}：${account.message || (account.status === "duplicate" ? "已跳过重复租户" : "数据未完整返回")}`,
            ]
          : [],
      ),
    ]),
  ];
  return (
    <div className="analytics-status">
      {report.status === "partial" && (
        <Alert tone="warning">部分数据未能完整取得。已返回的数据继续显示，缺失值以“—”标记。</Alert>
      )}
      {notes.length > 0 && (
        <details className="analytics-notes">
          <summary>数据说明 · {notes.length} 项</summary>
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="analytics-updated">
        {report.source === "demo" ? "演示数据 · " : ""}更新于 {utcTimestamp(report.generatedAt)} UTC
      </p>
    </div>
  );
}
