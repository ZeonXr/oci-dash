import type { InstanceJobContext, JobPage, JobSummary } from "../../src/lib/contracts";
import { operationLabels } from "../../src/lib/operation-labels";
import { isJobPending } from "../../src/lib/job-state";

export function jobContextFixture(
  rows: JobSummary[],
  details: JobSummary[] = rows,
): InstanceJobContext {
  const pending = new Map(details.filter(isJobPending).map((job) => [job.id, job]));
  return {
    jobs: rows.filter((job) => {
      if (isJobPending(job)) return true;
      const sync = job.result?.synchronization as { status?: string; jobId?: string } | undefined;
      const child = sync?.jobId ? pending.get(sync.jobId) : undefined;
      return (
        job.state === "succeeded" &&
        sync?.status === "queued" &&
        child?.kind === "sync-account" &&
        child.accountId === job.accountId
      );
    }),
    recentJobs: [...rows]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, 100),
  };
}

/** Synthetic HTTP fixture only; SQL query behavior is verified against SQLite separately. */
export function jobPageFixture(
  rows: JobSummary[],
  params: URLSearchParams,
): JobPage | InstanceJobContext {
  if (params.get("active") === "true") return jobContextFixture(rows);
  const query = (params.get("query") || "").toLowerCase();
  const selected = rows
    .filter(
      (job) =>
        (!params.get("accountId") || job.accountId === params.get("accountId")) &&
        (!params.get("resourceId") || job.resourceId === params.get("resourceId")) &&
        (!params.get("state") || job.state === params.get("state")) &&
        [job.id, operationLabels[job.kind], job.accountName, job.resourceId, job.lastError]
          .join(" ")
          .toLowerCase()
          .includes(query),
    )
    .sort((a, b) => {
      const order = a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
      return params.get("sort") === "ascending" ? order : -order;
    });
  const total = selected.length;
  const pageSize = Number(params.get("pageSize")) || 100;
  const page = Math.max(
    1,
    Math.min(Number(params.get("page")) || 1, Math.max(1, Math.ceil(total / pageSize))),
  );
  return { jobs: selected.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}
