"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, LayoutGrid, List, Plus, Search, Server } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { useAccountFilter } from "@/components/account-filter";
import { useInventoryRefresh } from "@/components/inventory-refresh";
import { SortableHeader, TablePanel } from "@/components/table";
import {
  Button,
  RefreshButton,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Pagination,
  Select,
  Status,
} from "@/components/ui";
import { formatDate, instanceHref, number, primaryAddress, regionName } from "@/components/format";
import { CreateInstanceDialog } from "@/components/create-instance-dialog";
import { InstanceCard } from "@/components/instance-card";
import { InventoryFreshness } from "@/components/inventory-freshness";
import { RegionLabel } from "@/components/region-label";
import { UpdatedAt } from "@/components/updated-at";
import { OperationDialog, type OperationDialogProps } from "@/components/operation-dialog";
import { publicIpRotation, rotationNeedsRefresh } from "@/components/public-ip-rotation";
import { useInstanceJobs } from "@/components/use-instance-jobs";

type InstanceView = "table" | "cards";
const viewPreference = "oci-dash:instances:view";

function InstancesContent() {
  const { accounts, accountsLoading } = useApp();
  const params = useSearchParams();
  const resource = useResource<{ instances: InstanceSummary[] }>("/api/instances", 30000);
  const [query, setQuery] = useState(params.get("q") || "");
  const [region, setRegion] = useState(params.get("region") || "");
  const [account, setAccount] = useAccountFilter();
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<"ascending" | "descending">("ascending");
  const [view, setView] = useState<InstanceView>("cards");
  const [creating, setCreating] = useState(false);
  const [operation, setOperation] = useState<Omit<OperationDialogProps, "onClose"> | null>(null);
  const instanceJobs = useInstanceJobs(resource.reload);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(viewPreference);
      if (saved === "cards" || saved === "table") setView(saved);
    } catch {
      // Storage can be unavailable; switching still works for this visit.
    }
  }, []);
  const changeView = (next: InstanceView) => {
    setView(next);
    try {
      localStorage.setItem(viewPreference, next);
    } catch {
      // Persisting the preference is optional.
    }
  };
  const sync = useInventoryRefresh({
    accountIds: account ? [account] : undefined,
    onUpdated: resource.reload,
    enabled: !accountsLoading,
  });
  const requestedQuery = params.get("q") || "";
  const requestedRegion = params.get("region") || "";
  useEffect(() => {
    setQuery(requestedQuery);
    setRegion(requestedRegion);
  }, [requestedQuery, requestedRegion]);
  const instances = resource.data?.instances || [];
  const filtered = useMemo(
    () =>
      instances
        .filter(
          (i) =>
            (!account || i.accountId === account) &&
            (!region || i.region === region) &&
            (!state || i.state === state) &&
            [
              i.displayName,
              i.id,
              i.accountName,
              ...i.vnics.flatMap((v) =>
                v.privateIps.flatMap((b) => [b.privateIp, b.publicIp || ""]),
              ),
            ]
              .join(" ")
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) => {
          const order = a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id);
          return sort === "ascending" ? order : -order;
        }),
    [instances, query, account, region, state, sort],
  );
  useEffect(() => setPage(1), [query, account, region, state, pageSize, sort]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  useEffect(() => {
    if (!resource.loading && page !== safePage) setPage(safePage);
  }, [page, safePage, resource.loading]);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const toggleSort = () => setSort(sort === "ascending" ? "descending" : "ascending");
  const refreshing = resource.refreshing || sync.refreshing;
  const empty = (
    <EmptyState
      title={instances.length ? "没有匹配的实例" : "还没有实例资源"}
      description={
        instances.length
          ? "尝试调整搜索条件或清除筛选。"
          : "添加账号后会自动读取实例，也可以创建一个新实例。"
      }
      action={
        <Link href="/settings/accounts" className="button">
          管理账号
        </Link>
      }
    />
  );
  const pagination = (
    <Pagination
      page={safePage}
      pageSize={pageSize}
      total={filtered.length}
      onPage={setPage}
      onPageSize={setPageSize}
    />
  );
  return (
    <>
      <PageHeader title="实例" description="跨账号查看与管理计算资源。">
        <UpdatedAt
          value={
            filtered
              .map((instance) => instance.syncedAt)
              .filter((value) => Number.isFinite(Date.parse(value)))
              .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
          }
          title="当前筛选实例中最新的 OCI 资源快照时间"
        />
        <RefreshButton
          onClick={sync.refresh}
          loading={resource.refreshing || sync.refreshing}
          disabled={accountsLoading || !accounts.length}
        />
        <Button
          variant="primary"
          icon={<Plus size={16} />}
          disabled={!accounts.length}
          title={!accounts.length ? "请先添加 OCI 账号" : undefined}
          onClick={() => setCreating(true)}
        >
          创建实例
        </Button>
      </PageHeader>
      {(resource.error || sync.error) && (
        <div style={{ marginBottom: 18 }}>
          <ErrorState message={sync.error || resource.error!} retry={sync.refresh} />
        </div>
      )}
      {instanceJobs.error && (
        <div style={{ marginBottom: 18 }}>
          <ErrorState
            message={`任务状态读取失败：${instanceJobs.error}`}
            retry={instanceJobs.reload}
          />
        </div>
      )}
      <div className="filters instance-filters">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索实例名称、地址或 OCID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、IP 或 OCID"
          />
        </div>
        <Select
          aria-label="筛选账号"
          value={account}
          disabled={accountsLoading}
          onChange={(e) => setAccount(e.target.value)}
        >
          <option value="">全部账号</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select aria-label="筛选区域" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="">全部区域</option>
          {Array.from(new Set(instances.map((i) => i.region)))
            .sort()
            .map((r) => (
              <option key={r} value={r}>
                {regionName(r)}
              </option>
            ))}
        </Select>
        <Select aria-label="筛选状态" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">全部状态</option>
          <option value="RUNNING">运行中</option>
          <option value="STOPPED">已停止</option>
          <option value="PROVISIONING">创建中</option>
          <option value="STARTING">启动中</option>
          <option value="STOPPING">停止中</option>
        </Select>
        {(query || account || region || state) && (
          <Button
            variant="ghost"
            onClick={() => {
              setQuery("");
              setAccount("");
              setRegion("");
              setState("");
            }}
          >
            重置筛选
          </Button>
        )}
        <div className="instance-view-actions">
          {view === "cards" && (
            <Button
              variant="ghost"
              aria-label="按实例名称排序"
              title={sort === "ascending" ? "按实例名称降序排列" : "按实例名称升序排列"}
              onClick={toggleSort}
            >
              名称{sort === "ascending" ? <ArrowUp size={14} /> : <ArrowDown size={14} />}
            </Button>
          )}
          <div className="view-switch" role="group" aria-label="实例展示方式">
            <button
              type="button"
              aria-label="表格视图"
              title="表格视图"
              aria-pressed={view === "table"}
              onClick={() => changeView("table")}
            >
              <List size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="卡片视图"
              title="卡片视图"
              aria-pressed={view === "cards"}
              onClick={() => changeView("cards")}
            >
              <LayoutGrid size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      {view === "cards" ? (
        <section aria-label="实例卡片列表" aria-busy={resource.loading || refreshing}>
          {filtered.length ? (
            <>
              <div className="instance-cards">
                {visible.map((instance) => {
                  const rotation = instanceJobs.jobs.find(
                    (job) =>
                      job.kind === "public-ip-rotate" &&
                      job.accountId === instance.accountId &&
                      job.resourceId === instance.id,
                  );
                  const synchronization = rotation?.result?.synchronization as
                    { status?: string; jobId?: string } | undefined;
                  const syncJob =
                    rotation?.state === "succeeded" && synchronization?.status === "queued"
                      ? instanceJobs.jobs.find((job) => job.id === synchronization.jobId)
                      : undefined;
                  const needsRefresh = rotationNeedsRefresh(instance, rotation, syncJob);
                  return (
                    <InstanceCard
                      key={instance.id}
                      instance={instance}
                      rotationDisabled={
                        instanceJobs.loading ||
                        Boolean(resource.error) ||
                        needsRefresh ||
                        Boolean(instanceJobs.error) ||
                        instanceJobs.busyInstanceIds.has(instance.id)
                      }
                      rotationJob={syncJob || rotation}
                      rotationWarning={needsRefresh}
                      onRotate={(vnic, binding) => {
                        if (
                          resource.error ||
                          needsRefresh ||
                          instanceJobs.loading ||
                          instanceJobs.error ||
                          instanceJobs.busyInstanceIds.has(instance.id) ||
                          !["RUNNING", "STOPPED"].includes(instance.state)
                        )
                          return;
                        const next = publicIpRotation(instance, vnic, binding);
                        if (next) setOperation({ ...next, onSuccess: instanceJobs.track });
                      }}
                    />
                  );
                })}
              </div>
              <div className="instance-cards-pagination">{pagination}</div>
            </>
          ) : (
            <div className="card">{resource.loading ? <LoadingState /> : empty}</div>
          )}
        </section>
      ) : (
        <TablePanel
          label="实例列表"
          loading={resource.loading}
          refreshing={refreshing}
          hasRows={filtered.length > 0}
          empty={empty}
          footer={pagination}
        >
          <table className="resource-table">
            <thead>
              <tr>
                <SortableHeader label="实例名称" direction={sort} onSort={toggleSort} />
                <th scope="col">账号 / 区域</th>
                <th scope="col">状态</th>
                <th scope="col">规格</th>
                <th scope="col">主要地址</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="table-identity">
                      <span className="table-resource-icon">
                        <Server size={17} />
                      </span>
                      <div>
                        <Link href={instanceHref(i.id)} className="name-link">
                          {i.displayName}
                        </Link>
                        <span className="cell-secondary">{formatDate(i.createdAt)} 创建</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    {i.accountName}
                    <span className="cell-secondary">
                      <RegionLabel region={i.region} />
                    </span>
                  </td>
                  <td>
                    <div className="row row-wrap">
                      <Status value={i.state} />
                      <InventoryFreshness instance={i} />
                    </div>
                  </td>
                  <td>
                    {i.shape.replace("VM.Standard.", "")}
                    <span className="cell-secondary">
                      {number(i.ocpus, 1)} OCPU / {number(i.memoryGb, 1)} GB
                    </span>
                  </td>
                  <td>
                    <div className="table-address mono">
                      {primaryAddress(i)}
                      {primaryAddress(i) !== "—" && (
                        <CopyButton
                          value={primaryAddress(i)}
                          label={`复制 ${i.displayName} 地址`}
                        />
                      )}
                    </div>
                  </td>
                  <td>
                    <Link href={instanceHref(i.id)} className="text-link">
                      查看详情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TablePanel>
      )}
      {creating && <CreateInstanceDialog onClose={() => setCreating(false)} />}
      {operation && <OperationDialog {...operation} onClose={() => setOperation(null)} />}
    </>
  );
}
export default function InstancesPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <InstancesContent />
    </Suspense>
  );
}
