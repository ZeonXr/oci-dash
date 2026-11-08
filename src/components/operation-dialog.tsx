"use client";
import { useState } from "react";
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
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            loading={action.pending}
            disabled={Boolean(requireName && confirmation !== requireName)}
            onClick={execute}
          >
            确认{title}
          </Button>
        </>
      }
    >
      <div className="stack-sm">
        {summary.length > 0 && (
          <div className="confirm-summary">
            {summary.map(([label, value]) => (
              <div key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        )}
        {requireName && (
          <Field label={`输入实例名称「${requireName}」以确认`} required>
            <input
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
