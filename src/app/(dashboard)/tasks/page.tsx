"use client";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Suspense, useEffect } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import type { JobPage } from "@/lib/contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { SortableHeader, TablePanel } from "@/components/table";
import {
  Button,
  RefreshButton,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  Select,
  Status,
} from "@/components/ui";
import { formatDate, operationLabels, shortId, taskHref } from "@/components/format";
import { RegionTag } from "@/components/region-label";
export default function TasksPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <TasksContent />
    </Suspense>
  );
}

function positiveInteger(value: string | null, fallback: number): number {
  return value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1_000_000
    ? Number(value)
    : fallback;
}

function TasksContent() {
  const { accounts } = useApp();
  const params = useSearchParams();
  const query = params.get("query") || "";
  const account = params.get("accountId") || "";
  const state = params.get("state") || "";
  const page = positiveInteger(params.get("page"), 1);
  const requestedSize = positiveInteger(params.get("pageSize"), 10);
  const pageSize = [10, 20, 50].includes(requestedSize) ? requestedSize : 10;
  const sort = params.get("sort") === "ascending" ? "ascending" : "descending";
  const search = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sort });
  if (query) search.set("query", query);
  if (account) search.set("accountId", account);
  if (state) search.set("state", state);
  const resource = useResource<JobPage>(`/api/jobs?${search}`, 5000);
  const jobs = resource.data?.jobs || [];
  const safePage = resource.data?.page ?? page;
  const total = resource.data?.total ?? 0;
  const update = (changes: Record<string, string>, replace = false) => {
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(changes)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history[replace ? "replaceState" : "pushState"](
      null,
      "",
      url.pathname + url.search + url.hash,
    );
  };
  const filter = (key: string, value: string, replace = false) =>
    update({ [key]: value, page: "" }, replace);
  useEffect(() => {
    if (!resource.data || resource.data.page === page) return;
    const url = new URL(window.location.href);
    if (positiveInteger(url.searchParams.get("page"), 1) !== page) return;
    url.searchParams.set("page", String(resource.data.page));
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [page, resource.data]);
  return (
    <>
      <PageHeader title="任务" description="追踪云操作的执行进度、结果与重试记录。">
        <RefreshButton
          onClick={resource.reload}
          loading={resource.refreshing}
          title="页面可见时每 5 秒检查任务状态；点击立即刷新"
        />
      </PageHeader>
      {resource.error && (
        <div className="mb-4">
          <ErrorState message={resource.error} retry={resource.reload} />
        </div>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-2.5 *:data-[slot=select-trigger]:w-auto *:data-[slot=select-trigger]:min-w-36 *:data-[slot=select-trigger]:max-w-56 max-[620px]:gap-2 max-[620px]:*:data-[slot=select-trigger]:min-w-24 max-[620px]:*:data-[slot=select-trigger]:max-w-none max-[620px]:*:data-[slot=select-trigger]:flex-1">
        <div className="flex min-w-52 max-w-sm flex-1 items-center gap-2 rounded-lg border bg-card px-3 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/15 [&>svg]:text-muted-foreground [&_input]:border-0 [&_input]:bg-transparent [&_input]:pl-0 [&_input]:shadow-none [&_input]:focus-visible:ring-0 max-[620px]:w-full max-[620px]:max-w-none max-[620px]:basis-full">
          <Search size={16} />
          <Input
            value={query}
            onChange={(e) => filter("query", e.target.value, true)}
            maxLength={200}
            aria-label="搜索任务"
            placeholder="搜索任务、资源或错误"
          />
        </div>
        <Select
          value={account}
          onValueChange={(value) => filter("accountId", value)}
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
          onValueChange={(value) => filter("state", value)}
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
              update({ query: "", accountId: "", state: "", page: "" });
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
            total={total}
            onPage={(value) => update({ page: String(value) })}
            onPageSize={(value) => filter("pageSize", String(value))}
          />
        }
      >
        <Table className="task-table min-w-180">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">任务</TableHead>
              <TableHead scope="col">账号 / 区域</TableHead>
              <TableHead scope="col">状态</TableHead>
              <SortableHeader
                label="提交时间"
                direction={sort}
                onSort={() => filter("sort", sort === "ascending" ? "descending" : "ascending")}
              />
              <TableHead scope="col">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {jobs.map((job) => (
              <TableRow key={job.id}>
                <TableCell>
                  <Link
                    href={taskHref(job.id)}
                    className="name-link inline-flex items-center gap-2 font-medium text-foreground hover:text-primary"
                  >
                    {operationLabels[job.kind]}
                  </Link>
                  <div
                    className="mt-1 text-xs text-muted-foreground font-mono tabular-nums"
                    title={job.resourceId || job.id}
                  >
                    {shortId(job.resourceId || job.id)}
                  </div>
                  {job.lastError && (
                    <div className="mt-1 block text-xs text-destructive max-w-75">
                      {job.lastError}
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  {job.accountName}
                  <span className="mt-1 block text-xs text-muted-foreground">
                    <RegionTag region={job.region} />
                  </span>
                </TableCell>
                <TableCell>
                  <Status value={job.state} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {formatDate(job.createdAt)}
                  {job.nextRunAt && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      下次 {formatDate(job.nextRunAt)}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Link
                    href={taskHref(job.id)}
                    className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                  >
                    查看详情
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TablePanel>
    </>
  );
}
