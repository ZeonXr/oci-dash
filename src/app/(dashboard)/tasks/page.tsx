"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search } from "lucide-react";
import type { JobSummary } from "@/lib/contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { SortableHeader, TablePanel } from "@/components/table";
import {
  Button,
  EmptyState,
  ErrorState,
  PageHeader,
  Pagination,
  Select,
  Status,
} from "@/components/ui";
import { formatDate, operationLabels, shortId, taskHref } from "@/components/format";
import { RegionLabel } from "@/components/region-label";
export default function TasksPage() {
  const { accounts } = useApp();
  const resource = useResource<{ jobs: JobSummary[]; demo: boolean }>("/api/jobs", 5000);
  const [query, setQuery] = useState("");
  const [account, setAccount] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<"ascending" | "descending">("descending");
  const jobs = useMemo(
    () =>
      (resource.data?.jobs || [])
        .filter(
          (job) =>
            (!account || job.accountId === account) &&
            (!state || job.state === state) &&
            [job.id, operationLabels[job.kind], job.accountName, job.resourceId, job.lastError]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => {
          const order = a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
          return sort === "ascending" ? order : -order;
        }),
    [resource.data, query, account, state, sort],
  );
  useEffect(() => setPage(1), [query, account, state, pageSize, sort]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(jobs.length / pageSize)));
  useEffect(() => {
    if (!resource.loading && page !== safePage) setPage(safePage);
  }, [page, safePage, resource.loading]);
  return (
    <>
      <PageHeader title="任务" description="追踪云操作的执行进度、结果与重试记录。">
        <Button
          onClick={resource.reload}
          loading={resource.refreshing}
          title="页面可见时每 5 秒检查任务状态；点击立即刷新"
        >
          <RefreshCw size={15} />
          刷新
        </Button>
      </PageHeader>
      {resource.error && (
        <div style={{ marginBottom: 18 }}>
          <ErrorState message={resource.error} retry={resource.reload} />
        </div>
      )}
      <div className="filters">
        <div className="search-field">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="搜索任务"
            placeholder="搜索任务、资源或错误"
          />
        </div>
        <Select
          value={account}
          onChange={(e) => setAccount(e.target.value)}
          aria-label="按账号筛选任务"
        >
          <option value="">全部账号</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select
          value={state}
          onChange={(e) => setState(e.target.value)}
          aria-label="按状态筛选任务"
        >
          <option value="">全部状态</option>
          <option value="queued">等待执行</option>
          <option value="running">执行中</option>
          <option value="retrying">等待重试</option>
          <option value="succeeded">已完成</option>
          <option value="failed">失败</option>
          <option value="cancel_requested">正在取消</option>
          <option value="cancelled">已取消</option>
          <option value="interrupted">执行中断</option>
        </Select>
        {(query || account || state) && (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setAccount("");
              setState("");
            }}
          >
            重置筛选
          </Button>
        )}
      </div>
      <TablePanel
        label="任务列表"
        loading={resource.loading}
        refreshing={resource.refreshing}
        hasRows={jobs.length > 0}
        empty={
          <EmptyState
            title={query || account || state ? "没有匹配的任务" : "暂无任务"}
            description="添加账号、刷新资源或提交实例操作后，可以在这里查看执行记录。"
          />
        }
        footer={
          <Pagination
            page={safePage}
            pageSize={pageSize}
            total={jobs.length}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        }
      >
        <table className="task-table task-list-table">
          <thead>
            <tr>
              <th scope="col">任务</th>
              <th scope="col">账号 / 区域</th>
              <th scope="col">状态</th>
              <SortableHeader
                label="提交时间"
                direction={sort}
                onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
              />
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {jobs.slice((safePage - 1) * pageSize, safePage * pageSize).map((job) => (
              <tr key={job.id}>
                <td>
                  <Link href={taskHref(job.id)} className="name-link">
                    {operationLabels[job.kind]}
                  </Link>
                  <div className="task-id mono" title={job.resourceId || job.id}>
                    {shortId(job.resourceId || job.id)}
                  </div>
                  {job.lastError && (
                    <div className="cell-secondary danger-text" style={{ maxWidth: 300 }}>
                      {job.lastError}
                    </div>
                  )}
                </td>
                <td>
                  {job.accountName}
                  <span className="cell-secondary">
                    <RegionLabel region={job.region} />
                  </span>
                </td>
                <td>
                  <Status value={job.state} />
                </td>
                <td className="nowrap">
                  {formatDate(job.createdAt)}
                  {job.nextRunAt && (
                    <span className="cell-secondary">下次 {formatDate(job.nextRunAt)}</span>
                  )}
                </td>
                <td>
                  <Link href={taskHref(job.id)} className="text-link">
                    查看详情
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TablePanel>
    </>
  );
}
