"use client";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Plus, RefreshCw, Search, Server } from "lucide-react";
import type { InstanceSummary, JobSummary } from "@/lib/contracts";
import { errorMessage, send, useAction, useResource } from "@/components/api";
import { useApp } from "@/components/app-provider";
import { useInventoryRefresh } from "@/components/inventory-refresh";
import { SortableHeader, TablePanel } from "@/components/table";
import {
  Alert,
  Button,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingState,
  Modal,
  PageHeader,
  Pagination,
  Select,
  Status,
} from "@/components/ui";
import { formatDate, instanceHref, number, primaryAddress, regionName } from "@/components/format";
import { CreateInstanceDialog } from "@/components/create-instance-dialog";
import { UpdatedAt } from "@/components/updated-at";

function InstancesContent() {
  const { demo, accounts, notify } = useApp();
  const params = useSearchParams();
  const resource = useResource<{ instances: InstanceSummary[]; demo: boolean }>(
    "/api/instances",
    30000,
  );
  const [query, setQuery] = useState(params.get("q") || "");
  const [region, setRegion] = useState(params.get("region") || "");
  const [account, setAccount] = useState("");
  const [state, setState] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [sort, setSort] = useState<"ascending" | "descending">("ascending");
  const [selected, setSelected] = useState<string[]>([]);
  const selectAll = useRef<HTMLInputElement>(null);
  const [creating, setCreating] = useState(false);
  const [bulk, setBulk] = useState<"instance-start" | "instance-stop" | null>(null);
  const action = useAction();
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const sync = useInventoryRefresh({
    accountIds: account ? [account] : undefined,
    onUpdated: resource.reload,
  });
  useEffect(() => {
    setQuery(params.get("q") || "");
    setRegion(params.get("region") || "");
  }, [params]);
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
  useEffect(() => setSelected([]), [query, account, region, state]);
  useEffect(() => {
    if (!resource.data) return;
    const selectable = new Set(
      resource.data.instances
        .filter((instance) => ["RUNNING", "STOPPED"].includes(instance.state))
        .map((instance) => instance.id),
    );
    setSelected((current) => {
      const retained = current.filter((id) => selectable.has(id));
      return retained.length === current.length ? current : retained;
    });
  }, [resource.data]);
  const safePage = Math.min(page, Math.max(1, Math.ceil(filtered.length / pageSize)));
  useEffect(() => {
    if (!resource.loading && page !== safePage) setPage(safePage);
  }, [page, safePage, resource.loading]);
  const visible = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const selectableVisible = visible.filter((instance) =>
    ["RUNNING", "STOPPED"].includes(instance.state),
  );
  const allSelected =
    selectableVisible.length > 0 &&
    selectableVisible.every((instance) => selected.includes(instance.id));
  const partiallySelected =
    !allSelected && selectableVisible.some((instance) => selected.includes(instance.id));
  useEffect(() => {
    if (selectAll.current) selectAll.current.indeterminate = partiallySelected;
  }, [partiallySelected]);
  const selectedInstances = instances.filter((i) => selected.includes(i.id));
  const candidates = selectedInstances.filter((i) =>
    bulk === "instance-start" ? i.state === "STOPPED" : i.state === "RUNNING",
  );
  const select = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((v) => v !== id) : [...current, id],
    );
  const executeBulk = async () => {
    if (demo || !bulk) return;
    setBulkErrors([]);
    await action.run(async () => {
      const results = await Promise.allSettled(
        candidates.map((i) =>
          send<{ job: JobSummary }>("/api/operations", {
            kind: bulk,
            accountId: i.accountId,
            region: i.region,
            resourceId: i.id,
            payload: {},
            idempotencyKey: crypto.randomUUID(),
          }),
        ),
      );
      const errors = results.flatMap((r, index) =>
        r.status === "rejected"
          ? [`${candidates[index].displayName}：${errorMessage(r.reason)}`]
          : [],
      );
      const success = results.length - errors.length;
      if (success) notify(`已提交 ${success} 个实例操作。`, "/tasks");
      setBulkErrors(errors);
      if (!errors.length) {
        setBulk(null);
        setSelected([]);
      } else
        setSelected(candidates.filter((_, i) => results[i].status === "rejected").map((i) => i.id));
      return true;
    });
  };
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
        <Button onClick={sync.refresh} loading={resource.refreshing || sync.refreshing}>
          <RefreshCw size={15} />
          刷新
        </Button>
        <Button
          variant="primary"
          disabled={demo || !accounts.length}
          title={demo ? "演示模式仅供查看" : !accounts.length ? "请先添加 OCI 账号" : undefined}
          onClick={() => setCreating(true)}
        >
          <Plus size={16} />
          创建实例
        </Button>
      </PageHeader>
      {(resource.error || sync.error) && (
        <div style={{ marginBottom: 18 }}>
          <ErrorState message={sync.error || resource.error!} retry={sync.refresh} />
        </div>
      )}
      <div className="filters">
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="搜索实例名称、地址或 OCID"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索名称、IP 或 OCID"
          />
        </div>
        <Select aria-label="筛选账号" value={account} onChange={(e) => setAccount(e.target.value)}>
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
      </div>
      <TablePanel
        label="实例列表"
        loading={resource.loading}
        refreshing={resource.refreshing || sync.refreshing}
        hasRows={filtered.length > 0}
        empty={
          <EmptyState
            title={instances.length ? "没有匹配的实例" : "还没有实例资源"}
            description={
              instances.length
                ? "尝试调整搜索条件或清除筛选。"
                : "添加账号后会自动读取实例，也可以创建一个新实例。"
            }
            action={
              <Link href="/accounts" className="button">
                管理账号
              </Link>
            }
          />
        }
        footer={
          <Pagination
            page={safePage}
            pageSize={pageSize}
            total={filtered.length}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        }
        toolbar={
          <div className="table-toolbar" hidden={!selected.length}>
            {selected.length ? (
              <div className="row row-wrap">
                <strong>已选择 {selected.length} 项</strong>
                <Button
                  className="button-sm"
                  disabled={demo || !selectedInstances.some((i) => i.state === "STOPPED")}
                  onClick={() => {
                    setBulk("instance-start");
                    setBulkErrors([]);
                  }}
                >
                  启动
                </Button>
                <Button
                  className="button-sm"
                  disabled={demo || !selectedInstances.some((i) => i.state === "RUNNING")}
                  onClick={() => {
                    setBulk("instance-stop");
                    setBulkErrors([]);
                  }}
                >
                  停止
                </Button>
                <Button variant="ghost" className="button-sm" onClick={() => setSelected([])}>
                  取消选择
                </Button>
              </div>
            ) : (
              <strong>{filtered.length} 个实例</strong>
            )}
          </div>
        }
      >
        <table className="resource-table">
          <thead>
            <tr>
              <th scope="col">
                <input
                  ref={selectAll}
                  type="checkbox"
                  aria-label="选择当前页全部实例"
                  checked={allSelected}
                  disabled={!selectableVisible.length}
                  onChange={(e) =>
                    setSelected((current) =>
                      e.target.checked
                        ? Array.from(new Set([...current, ...selectableVisible.map((i) => i.id)]))
                        : current.filter((id) => !visible.some((i) => i.id === id)),
                    )
                  }
                />
              </th>
              <SortableHeader
                label="实例名称"
                direction={sort}
                onSort={() => setSort(sort === "ascending" ? "descending" : "ascending")}
              />
              <th scope="col">账号 / 区域</th>
              <th scope="col">状态</th>
              <th scope="col">规格</th>
              <th scope="col">主要地址</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr key={i.id} className={selected.includes(i.id) ? "is-selected" : undefined}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${i.displayName}`}
                    checked={selected.includes(i.id)}
                    disabled={!["RUNNING", "STOPPED"].includes(i.state)}
                    onChange={() => select(i.id)}
                  />
                </td>
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
                  <span className="cell-secondary">{regionName(i.region)}</span>
                </td>
                <td>
                  <Status value={i.state} />
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
                      <CopyButton value={primaryAddress(i)} label={`复制 ${i.displayName} 地址`} />
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
      {creating && <CreateInstanceDialog onClose={() => setCreating(false)} />}
      {bulk && (
        <Modal
          open
          title={bulk === "instance-start" ? "启动所选实例" : "停止所选实例"}
          description={`将为 ${candidates.length} 个符合当前状态的实例创建独立任务。`}
          onClose={() => setBulk(null)}
          busy={action.pending}
          footer={
            <>
              <Button onClick={() => setBulk(null)} disabled={action.pending}>
                取消
              </Button>
              <Button
                variant="primary"
                loading={action.pending}
                disabled={demo || !candidates.length}
                onClick={executeBulk}
              >
                确认提交
              </Button>
            </>
          }
        >
          <div className="stack-sm">
            <div className="confirm-summary">
              {candidates.map((i) => (
                <div key={i.id}>
                  <span>{i.accountName}</span>
                  <strong>{i.displayName}</strong>
                </div>
              ))}
            </div>
            {bulk === "instance-stop" && <Alert>停止会中断实例上正在运行的服务。</Alert>}
            {bulkErrors.map((error) => (
              <ErrorState key={error} message={error} />
            ))}
            {action.error && <ErrorState message={action.error} />}
          </div>
        </Modal>
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
