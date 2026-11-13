"use client";
import { FilterBar, SearchField, filterSelectClassName } from "@/components/view-layout";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, LayoutGrid, List, Plus, Server } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import { useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { useAccountFilter } from "@/components/account-filter";
import { useInventoryRefresh } from "@/components/inventory-refresh";
import { SortableHeader, TablePanel } from "@/components/table";
import {
  Button,
  Panel,
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
import { formatDate, instanceHref, number } from "@/components/format";
import { CreateInstanceDialog } from "@/components/create-instance-dialog";
import { InstanceCard } from "@/components/instance-card";
import { InventoryFreshness } from "@/components/inventory-freshness";
import { RegionTag } from "@/components/region-label";
import { CodeTag } from "@/components/code-tag";
import { IpDetailsDialog } from "@/components/ip-details-dialog";
import { IpAddressButton, primaryIpTarget, type IpDetailsTarget } from "@/components/ip-address";
import { ipRotationContext } from "@/components/public-ip-rotation";
import { useInstanceJobs } from "@/components/use-instance-jobs";

type InstanceView = "table" | "cards";
const viewPreference = "oci-dash:instances:view";

function InstancesContent() {
  const { accounts, accountsReady, accountsError, reloadAccounts } = useApp();
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
  const [address, setAddress] = useState<{ instanceId: string; target: IpDetailsTarget } | null>(
    null,
  );
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
    enabled: accountsReady,
  });
  const requestedQuery = params.get("q") || "";
  const requestedRegion = params.get("region") || "";
  useEffect(() => {
    setQuery(requestedQuery);
    setRegion(requestedRegion);
  }, [requestedQuery, requestedRegion]);
  const instances = resource.data?.instances || [];
  const selectedInstance = instances.find((instance) => instance.id === address?.instanceId);
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
        <Button asChild>
          <Link href="/settings/accounts">管理账号</Link>
        </Button>
      }
    />
  );
  const pagination = (
    <Pagination
      className={view === "cards" ? "mt-4 border-t-0 px-0" : undefined}
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
        <RefreshButton
          onClick={sync.refresh}
          updatedAt={
            filtered
              .map((instance) => instance.syncedAt)
              .filter((value) => Number.isFinite(Date.parse(value)))
              .sort((left, right) => Date.parse(right) - Date.parse(left))[0]
          }
          disabled={!accountsReady || !accounts.length}
        />
        <Button
          variant="default"
          icon={<Plus size={16} />}
          disabled={!accountsReady || !accounts.length}
          title={accountsReady && !accounts.length ? "请先添加 OCI 账号" : undefined}
          onClick={() => setCreating(true)}
        >
          创建实例
        </Button>
      </PageHeader>
      {accountsError && (
        <ErrorState message={`账号读取失败：${accountsError}`} retry={reloadAccounts} />
      )}
      {(resource.error || sync.error) && (
        <div className="mb-4">
          <ErrorState message={sync.error || resource.error!} retry={sync.refresh} />
        </div>
      )}
      {instanceJobs.error && (
        <div className="mb-4">
          <ErrorState
            message={`任务状态读取失败：${instanceJobs.error}`}
            retry={instanceJobs.reload}
          />
        </div>
      )}
      <FilterBar className="instance-filters">
        <SearchField
          aria-label="搜索实例名称、地址或 OCID"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称、IP 或 OCID"
        />
        <Select
          className={filterSelectClassName}
          aria-label="筛选账号"
          value={account}
          disabled={!accountsReady}
          onValueChange={(value) => setAccount(value)}
          options={[
            { value: "", label: "全部账号" },
            ...accounts.map((a) => ({ value: a.id, label: a.name })),
          ]}
        />
        <Select
          className={filterSelectClassName}
          aria-label="筛选区域"
          value={region}
          onValueChange={(value) => setRegion(value)}
          options={[
            { value: "", label: "全部区域" },
            ...Array.from(new Set(instances.map((i) => i.region)))
              .sort()
              .map((r) => ({ value: r, label: r })),
          ]}
        />
        <Select
          className={filterSelectClassName}
          aria-label="筛选状态"
          value={state}
          onValueChange={(value) => setState(value)}
          options={[
            { value: "", label: "全部状态" },
            { value: "RUNNING", label: "运行中" },
            { value: "STOPPED", label: "已停止" },
            { value: "PROVISIONING", label: "创建中" },
            { value: "STARTING", label: "启动中" },
            { value: "STOPPING", label: "停止中" },
          ]}
        />
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
        <div className="ml-auto flex items-center gap-2">
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
          <div
            className="inline-flex gap-1 rounded-md border p-1"
            role="group"
            aria-label="实例展示方式"
          >
            <Button
              variant={view === "table" ? "outline" : "ghost"}
              size="icon"
              aria-label="表格视图"
              title="表格视图"
              aria-pressed={view === "table"}
              onClick={() => changeView("table")}
            >
              <List size={17} aria-hidden="true" />
            </Button>
            <Button
              variant={view === "cards" ? "outline" : "ghost"}
              size="icon"
              aria-label="卡片视图"
              title="卡片视图"
              aria-pressed={view === "cards"}
              onClick={() => changeView("cards")}
            >
              <LayoutGrid size={17} aria-hidden="true" />
            </Button>
          </div>
        </div>
      </FilterBar>
      {view === "cards" ? (
        <section aria-label="实例卡片列表" aria-busy={resource.loading || refreshing}>
          {filtered.length ? (
            <>
              <div className="instance-cards grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-4">
                {visible.map((instance) => {
                  const context = ipRotationContext(instance, instanceJobs, resource.error);
                  return (
                    <InstanceCard
                      key={instance.id}
                      instance={instance}
                      rotationDisabled={Boolean(context.blockedReason)}
                      rotationJob={context.job}
                      rotationWarning={context.warning}
                      onAddress={(target) => setAddress({ instanceId: instance.id, target })}
                    />
                  );
                })}
              </div>
              {pagination}
            </>
          ) : (
            <Panel>{resource.loading ? <LoadingState /> : empty}</Panel>
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
          <Table className="resource-table min-w-205">
            <TableHeader>
              <TableRow>
                <SortableHeader label="实例名称" direction={sort} onSort={toggleSort} />
                <TableHead scope="col">账号 / 区域</TableHead>
                <TableHead scope="col">状态</TableHead>
                <TableHead scope="col">规格</TableHead>
                <TableHead scope="col">主要地址</TableHead>
                <TableHead scope="col">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((i) => {
                const target = primaryIpTarget(i);
                return (
                  <TableRow key={i.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Server size={17} />
                        </span>
                        <div>
                          <Link
                            href={instanceHref(i.id)}
                            className="name-link inline-flex items-center gap-2 font-medium text-foreground hover:text-primary"
                          >
                            {i.displayName}
                          </Link>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {formatDate(i.createdAt)} 创建
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {i.accountName}
                      <span className="mt-1 block text-xs text-muted-foreground">
                        <RegionTag region={i.region} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="row flex items-center gap-2.5 flex-wrap">
                        <Status value={i.state} />
                        <InventoryFreshness instance={i} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <CodeTag title={i.shape}>{i.shape.replace("VM.Standard.", "")}</CodeTag>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {number(i.ocpus, 1)} OCPU / {number(i.memoryGb, 1)} GB
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1 whitespace-nowrap font-mono tabular-nums">
                        {target ? (
                          <IpAddressButton
                            target={target}
                            onClick={(target) => setAddress({ instanceId: i.id, target })}
                          />
                        ) : (
                          "—"
                        )}
                        {target && (
                          <CopyButton value={target.address} label={`复制 ${i.displayName} 地址`} />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={instanceHref(i.id)}
                        className="inline-flex items-center gap-1 text-sm text-primary hover:underline underline-offset-4"
                      >
                        查看详情
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TablePanel>
      )}
      {creating && <CreateInstanceDialog onClose={() => setCreating(false)} />}
      {address && (
        <IpDetailsDialog
          instance={selectedInstance}
          target={address.target}
          blockedReason={
            selectedInstance
              ? ipRotationContext(selectedInstance, instanceJobs, resource.error).blockedReason
              : undefined
          }
          onSuccess={instanceJobs.track}
          onClose={() => setAddress(null)}
        />
      )}
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
