"use client";

import type { AnalyticsMetadata, AnalyticsStatus } from "@/lib/analytics-contracts";
import { useState } from "react";
import { CircleAlert, Info } from "lucide-react";
import { Modal } from "./ui";
import { Button } from "./ui/button";

export function AnalyticsStatusNote({
  report,
}: {
  report: Pick<AnalyticsMetadata, "accounts"> & { status: AnalyticsStatus; warnings: string[] };
}) {
  const [open, setOpen] = useState(false);
  const incomplete =
    report.status === "partial" ||
    report.accounts.some((account) => account.status === "error" || account.status === "partial");
  const duplicate = report.accounts.some((account) => account.status === "duplicate");
  const queriedAccounts = report.accounts.filter((account) => account.status !== "duplicate");
  const failed =
    queriedAccounts.length > 0 && queriedAccounts.every((account) => account.status === "error");
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
  if (!incomplete && !duplicate && notes.length === 0) return null;
  const label = failed ? "读取失败" : incomplete ? "部分数据" : duplicate ? "已去重" : "统计说明";
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="analytics-status-trigger"
        onClick={() => setOpen(true)}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
      >
        {incomplete ? <CircleAlert size={14} /> : <Info size={14} />}
        {(incomplete || duplicate) && label}
      </Button>
      <Modal
        open={open}
        initialFocus="title"
        onClose={() => setOpen(false)}
        title={label}
        description={
          failed
            ? "所选账号均未能读取，请检查下方原因后重试。"
            : incomplete
              ? "当前仅显示已获取的数据，缺失值以“—”标记。"
              : duplicate
                ? "同一租户只统计一次。"
                : undefined
        }
      >
        {notes.length > 0 && (
          <ul className="analytics-note-list m-0 list-disc space-y-2 pl-5 text-sm leading-relaxed text-muted-foreground wrap-anywhere">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
