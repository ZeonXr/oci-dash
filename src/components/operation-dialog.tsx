"use client";
import { Input } from "@/components/ui/input";
import { useState, type RefObject } from "react";
import type { JobSummary, OperationRequest } from "@/lib/contracts";
import { useApp } from "./app-provider";
import { send, useAction } from "./api";
import { taskHref } from "./format";
import { Button, ErrorState, Field, Modal } from "./ui";
export interface OperationDialogProps {
  title: string;
  description: string;
  operation: OperationRequest;
  summary?: [string, string][];
  danger?: boolean;
  requireName?: string;
  onClose: () => void;
  onSuccess?: (job: JobSummary) => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}
export function OperationDialog({
  title,
  description,
  operation,
  summary = [],
  danger,
  requireName,
  onClose,
  onSuccess,
  returnFocusRef,
}: OperationDialogProps) {
  const { notify } = useApp();
  const action = useAction();
  const [confirmation, setConfirmation] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const execute = async () => {
    if (requireName && confirmation !== requireName) return;
    const response = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", {
        ...operation,
        confirmation: requireName ? confirmation : operation.confirmation,
        idempotencyKey,
      }),
    );
    if (response) {
      notify("操作已提交，执行进度可在任务中查看。", taskHref(response.job.id));
      onSuccess?.(response.job);
      onClose();
    }
  };
  return (
    <Modal
      open
      title={title}
      description={description}
      onClose={onClose}
      busy={action.pending}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button
            variant={danger ? "destructive" : "default"}
            loading={action.pending}
            disabled={Boolean(requireName && confirmation !== requireName)}
            onClick={execute}
          >
            确认{title}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {summary.length > 0 && (
          <div className="confirm-summary flex flex-col gap-3 rounded-lg bg-muted/50 px-4 py-3">
            {summary.map(([label, value]) => (
              <div
                key={label}
                className="flex min-w-0 items-baseline justify-between gap-3 text-sm"
              >
                <span className="shrink-0 text-muted-foreground">{label}</span>
                <strong className="min-w-0 text-right font-medium wrap-anywhere">{value}</strong>
              </div>
            ))}
          </div>
        )}
        {requireName && (
          <Field label={`输入实例名称「${requireName}」以确认`} required>
            <Input
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={requireName}
            />
          </Field>
        )}
        {action.error && <ErrorState message={action.error} />}
      </div>
    </Modal>
  );
}
