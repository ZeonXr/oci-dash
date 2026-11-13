"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Info,
  RotateCcw,
  Square,
} from "lucide-react";
import type { JobEvent, JobSummary } from "@/lib/contracts";
import { isJobPending, isJobCancellable, isJobRetryable } from "@/lib/job-state";
import { send, useAction, useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import {
  Alert,
  Button,
  RefreshButton,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  Status,
} from "@/components/ui";
import { formatDate, instanceHref, operationLabels, shortId, taskHref } from "@/components/format";
import { RegionTag } from "@/components/region-label";
export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { notify } = useApp();
  const [poll, setPoll] = useState(3000);
  const resource = useResource<{ job: JobSummary; events: JobEvent[] }>(
    `/api/jobs/${encodeURIComponent(id)}`,
    poll,
  );
  const [confirm, setConfirm] = useState<"cancel" | "retry" | null>(null);
  const action = useAction();
  const job = resource.data?.job;
  useEffect(() => setPoll(3000), [id]);
  useEffect(() => {
    if (job) setPoll(isJobPending(job) ? 3000 : 0);
  }, [job]);
  const execute = async () => {
    if (!confirm) return;
    const response = await action.run(() =>
      send<{ job?: JobSummary }>(`/api/jobs/${encodeURIComponent(id)}/${confirm}`),
    );
    if (response) {
      notify(confirm === "cancel" ? "取消请求已提交。" : "重试任务已提交。");
      setConfirm(null);
      setPoll(3000);
      if (response.job?.id && response.job.id !== id) router.push(taskHref(response.job.id));
      else resource.reload();
    }
  };
  if (resource.loading) return <LoadingState />;
  if (!job)
    return <ErrorState message={resource.error || "未找到任务。"} retry={resource.reload} />;
  const stages = ["已排队", "执行中", job.state === "interrupted" ? "等待处理" : "已结束"];
  const stage = job.state === "queued" ? 0 : isJobPending(job) ? 1 : 2;
  return (
    <>
      <PageHeader
        eyebrow={
          <>
            <Link href="/tasks">任务</Link>
            <ChevronRight size={12} />
            <span>{job.id.slice(0, 12)}</span>
          </>
        }
        title={
          <>
            {operationLabels[job.kind]}
            <Status value={job.state} />
          </>
        }
        description={
          <>
            {job.accountName} · <RegionTag region={job.region} /> ·{" "}
            {formatDate(job.createdAt, true)}
          </>
        }
      >
        <RefreshButton onClick={resource.reload} updatedAt={resource.updatedAt} />
        {isJobRetryable(job) && (
          <Button
            onClick={() => {
              action.clearError();
              setConfirm("retry");
            }}
          >
            <RotateCcw size={15} />
            重试
          </Button>
        )}
        {isJobCancellable(job) && (
          <Button
            onClick={() => {
              action.clearError();
              setConfirm("cancel");
            }}
          >
            <Square size={13} />
            取消任务
          </Button>
        )}
      </PageHeader>
      <div className="flex flex-col gap-5">
        {resource.error && <ErrorState message={resource.error} retry={resource.reload} />}
        {job.lastError && <Alert tone="error">{job.lastError}</Alert>}
        {job.waitingForCompletion && isJobPending(job) && (
          <Alert tone="info">OCI 仍在处理操作，系统会继续核对结果。</Alert>
        )}
        <Card>
          <div className="mb-5 flex flex-wrap items-center gap-2.5">
            {stages.map((label, index) => (
              <div
                className={`task-step flex items-center gap-2 text-xs ${index < stage ? "done text-success" : index === stage ? "current text-primary" : "text-muted-foreground"}`}
                key={label}
              >
                {index < stage ? <CheckCircle2 size={18} /> : <Clock3 size={18} />}
                <span>{label}</span>
                {index < 2 && <ChevronRight size={15} />}
              </div>
            ))}
          </div>
          <dl className="grid grid-cols-[105px_minmax(0,1fr)] gap-x-4 gap-y-4 text-sm [&_dt]:text-muted-foreground [&_dd]:m-0 [&_dd]:flex [&_dd]:min-w-0 [&_dd]:flex-wrap [&_dd]:items-center [&_dd]:gap-1.5 [&_dd]:wrap-anywhere max-[620px]:grid-cols-[85px_minmax(0,1fr)] max-[620px]:gap-3 max-[620px]:text-xs">
            <dt>任务 ID</dt>
            <dd className="font-mono tabular-nums">
              {job.id}
              <CopyButton value={job.id} />
            </dd>
            <dt>关联资源</dt>
            <dd>
              {job.resourceId ? (
                <Link
                  href={instanceHref(job.resourceId)}
                  className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4 font-mono tabular-nums"
                >
                  {shortId(job.resourceId)}
                </Link>
              ) : (
                "账号级操作"
              )}
            </dd>
            <dt>执行次数</dt>
            <dd>
              {job.attempt} / {job.maxAttempts}
            </dd>
            {job.completionDeadlineAt && isJobPending(job) && (
              <>
                <dt>本轮完成期限</dt>
                <dd>{formatDate(job.completionDeadlineAt, true)}</dd>
              </>
            )}
            <dt>开始时间</dt>
            <dd>{formatDate(job.startedAt, true)}</dd>
            <dt>结束时间</dt>
            <dd>{formatDate(job.finishedAt, true)}</dd>
            {job.nextRunAt && (
              <>
                <dt>下次执行</dt>
                <dd>{formatDate(job.nextRunAt, true)}</dd>
              </>
            )}
          </dl>
        </Card>
        {job.result && (
          <Card title="执行结果">
            <pre className="max-w-full overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/50 p-3 text-xs wrap-anywhere">
              {JSON.stringify(job.result, null, 2)}
            </pre>
          </Card>
        )}
        <Card
          title="执行日志"
          description={
            isJobPending(job)
              ? "任务执行期间自动更新"
              : job.state === "interrupted"
                ? "自动恢复已停止，可重试或取消任务"
                : "已保存的完整执行记录"
          }
        >
          {resource.data?.events.length ? (
            <div className="timeline flex flex-col">
              {resource.data.events.map((event) => (
                <div
                  className="timeline-item group grid grid-cols-[24px_minmax(0,1fr)] gap-3 pb-5"
                  key={event.id}
                >
                  <div
                    className={`timeline-marker relative flex justify-center pt-1 group-not-last:after:absolute group-not-last:after:top-6 group-not-last:after:-bottom-5 group-not-last:after:w-px group-not-last:after:bg-border ${event.level === "error" ? "danger-text text-destructive" : "text-muted-foreground"}`}
                  >
                    {event.level === "error" ? (
                      <AlertCircle size={17} />
                    ) : event.level === "warning" ? (
                      <AlertCircle size={17} />
                    ) : (
                      <Info size={17} />
                    )}
                  </div>
                  <div>
                    <div className="mb-1 flex items-baseline justify-between gap-3 [&_p]:text-sm [&_time]:whitespace-nowrap [&_time]:text-xs [&_time]:text-muted-foreground max-[620px]:flex-col max-[620px]:gap-1">
                      <p>{event.message}</p>
                      <time>{formatDate(event.createdAt, true)}</time>
                    </div>
                    {event.detail && (
                      <details className="mt-2 rounded-md bg-muted/50 px-3 py-2 [&_summary]:cursor-pointer [&_summary]:text-xs [&_summary]:text-muted-foreground [&_pre]:mt-2 [&_pre]:max-w-full [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:text-xs [&_pre]:wrap-anywhere">
                        <summary>查看事件详情</summary>
                        <pre>{JSON.stringify(event.detail, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="等待第一条执行记录"
              description="任务开始后，执行阶段与结果会显示在这里。"
            />
          )}
        </Card>
      </div>
      {confirm && (
        <Modal
          open
          title={confirm === "cancel" ? "取消任务" : "重试任务"}
          description={
            confirm === "cancel"
              ? "发送取消请求。已经完成的云端步骤不会自动撤销。"
              : "重新提交此任务；执行器会核对资源状态与已保存的执行记录。"
          }
          busy={action.pending}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)} disabled={action.pending}>
                返回
              </Button>
              <Button variant="primary" loading={action.pending} onClick={execute}>
                确认{confirm === "cancel" ? "取消" : "重试"}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p>
              {operationLabels[job.kind]} · {job.accountName}
            </p>
            {action.error && <ErrorState message={action.error} />}
          </div>
        </Modal>
      )}
    </>
  );
}
