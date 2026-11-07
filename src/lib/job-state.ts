import type { JobSummary } from "./contracts";

type JobProgress = Pick<
  JobSummary,
  "state" | "attempt" | "maxAttempts" | "nextRunAt" | "waitingForCompletion"
>;

/** Routine checks of an accepted OCI operation do not consume its error retry budget. */
export const canResumeJob = (
  job: Pick<JobProgress, "attempt" | "maxAttempts" | "waitingForCompletion">,
) => job.waitingForCompletion === true || job.attempt < job.maxAttempts;

export const isJobPending = (job: JobProgress): boolean =>
  ["queued", "running", "retrying", "cancel_requested"].includes(job.state) ||
  (job.state === "interrupted" && Boolean(job.nextRunAt) && canResumeJob(job));

/** Interrupted tasks remain cancellable even when automatic recovery has stopped. */
export const isJobCancellable = (job: Pick<JobSummary, "state">): boolean =>
  ["queued", "running", "retrying", "interrupted"].includes(job.state);

export const isJobRetryable = (job: Pick<JobSummary, "state">): boolean =>
  ["failed", "cancelled", "interrupted"].includes(job.state);
