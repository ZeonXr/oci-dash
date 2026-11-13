"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState, type SubmitEvent } from "react";
import { Upload } from "lucide-react";
import type { CreateOptions, CreateOptionsSelection, JobSummary } from "@/lib/contracts";
import { useApp } from "./app-provider";
import { send, useAction, useResource } from "./api";
import { taskHref } from "./format";
import { Alert, Button, ErrorState, Field, LoadingState, Modal, Select } from "./ui";
export function CreateInstanceDialog({ onClose }: { onClose: () => void }) {
  const { accounts, notify } = useApp();
  const action = useAction();
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const account = accounts.find((a) => a.id === accountId);
  const [region, setRegion] = useState(account?.homeRegion || "");
  const [compartment, setCompartment] = useState("");
  const [selection, setSelection] = useState<CreateOptionsSelection>({});
  const [lastOptions, setLastOptions] = useState<CreateOptions>();
  const [form, setForm] = useState({
    displayName: "",
    availabilityDomain: "",
    shape: "",
    ocpus: 1,
    memoryGb: 1,
    imageId: "",
    subnetId: "",
    assignPublicIp: true,
    sshPublicKey: "",
    bootVolumeSizeGb: 50,
  });
  const [acknowledged, setAcknowledged] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const query = new URLSearchParams({ region });
  if (compartment) query.set("compartmentId", compartment);
  if (selection.availabilityDomain) query.set("availabilityDomain", selection.availabilityDomain);
  if (selection.shape) query.set("shape", selection.shape);
  const url =
    accountId && region
      ? `/api/accounts/${encodeURIComponent(accountId)}/create-options?${query}`
      : null;
  const options = useResource<CreateOptions>(url);
  const data = options.data ?? lastOptions;
  const updating = options.loading || options.refreshing;
  const shape = data?.shapes.find((s) => s.name === form.shape);
  const ready = Boolean(
    options.data &&
    !updating &&
    !options.error &&
    form.availabilityDomain &&
    form.availabilityDomain === options.data.selection.availabilityDomain &&
    form.shape &&
    form.shape === options.data.selection.shape &&
    options.data.images.some((image) => image.id === form.imageId) &&
    options.data.subnets.some((subnet) => subnet.id === form.subnetId),
  );
  useEffect(() => {
    const data = options.data;
    if (!data) return;
    setLastOptions(data);
    setForm((current) => ({
      ...current,
      availabilityDomain: data.selection.availabilityDomain,
      shape: data.selection.shape,
      imageId: data.images.some((i) => i.id === current.imageId)
        ? current.imageId
        : data.images[0]?.id || "",
      subnetId: data.subnets.some((i) => i.id === current.subnetId)
        ? current.subnetId
        : data.subnets[0]?.id || "",
    }));
  }, [options.data]);
  useEffect(() => {
    if (shape) setForm((current) => ({ ...current, ocpus: shape.ocpus, memoryGb: shape.memoryGb }));
  }, [shape?.name]);
  const resetChoices = () => {
    setSelection({});
    setAcknowledged(false);
    setForm((current) => ({
      ...current,
      availabilityDomain: "",
      shape: "",
      imageId: "",
      subnetId: "",
    }));
  };
  const changeAccount = (id: string) => {
    setAccountId(id);
    setRegion(accounts.find((a) => a.id === id)?.homeRegion || "");
    setCompartment("");
    resetChoices();
  };
  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!acknowledged || !ready || !options.data) return;
    const response = await action.run(() =>
      send<{ job: JobSummary }>("/api/operations", {
        kind: "instance-create",
        accountId,
        region,
        payload: {
          ...form,
          compartmentId: options.data!.selection.compartmentId,
          ocpus: shape?.flexible ? form.ocpus : undefined,
          memoryGb: shape?.flexible ? form.memoryGb : undefined,
        },
        idempotencyKey,
      }),
    );
    if (response) {
      notify("实例创建任务已提交。", taskHref(response.job.id));
      onClose();
    }
  };
  return (
    <Modal
      open
      title="创建实例"
      description="选择 OCI 账号及区域，并使用当前可用的规格和镜像。"
      wide
      onClose={onClose}
      busy={action.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={action.pending}>
            取消
          </Button>
          <Button
            type="submit"
            form="create-instance-form"
            variant="default"
            loading={action.pending}
            disabled={!acknowledged || !ready}
          >
            创建实例
          </Button>
        </>
      }
    >
      <form id="create-instance-form" onSubmit={submit} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="OCI 账号" required>
            <Select
              value={accountId}
              onValueChange={changeAccount}
              options={accounts.map((account) => ({ value: account.id, label: account.name }))}
            />
          </Field>
          <Field label="区域" required>
            <Select
              value={region}
              onValueChange={(value) => {
                setRegion(value);
                setCompartment("");
                resetChoices();
              }}
              options={Array.from(new Set([account?.homeRegion, ...(account?.regions || [])]))
                .filter((value): value is string => Boolean(value))
                .map((value) => ({ value, label: value }))}
            />
          </Field>
        </div>
        {options.error && <ErrorState message={options.error} retry={options.reload} />}
        {options.loading && !data ? (
          <LoadingState label="正在读取可用规格、镜像与网络…" />
        ) : (
          data && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="实例名称" required>
                  <Input
                    required
                    maxLength={255}
                    value={form.displayName}
                    onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                    placeholder="例如 production-sg-01"
                  />
                </Field>
                <Field label="区间 (Compartment)" required>
                  <Select
                    value={compartment || data.selection.compartmentId}
                    disabled={updating || !options.data}
                    onValueChange={(value) => {
                      setCompartment(value);
                      resetChoices();
                    }}
                    options={data.compartments.map((compartment) => ({
                      value: compartment.id,
                      label: compartment.name,
                    }))}
                  />
                </Field>
                <Field label="可用域" required>
                  <Select
                    value={form.availabilityDomain}
                    disabled={updating || !options.data}
                    onValueChange={(value) => {
                      const availabilityDomain = value;
                      setSelection({ availabilityDomain });
                      setAcknowledged(false);
                      setForm((current) => ({
                        ...current,
                        availabilityDomain,
                        shape: "",
                        imageId: "",
                        subnetId: "",
                      }));
                    }}
                    options={
                      data.availabilityDomains.length
                        ? data.availabilityDomains.map((value) => ({ value, label: value }))
                        : [{ value: "", label: "该区域暂无可用域" }]
                    }
                  />
                </Field>
                <Field label="实例规格" required>
                  <Select
                    value={form.shape}
                    disabled={updating || !options.data}
                    onValueChange={(value) => {
                      const shape = value;
                      setSelection({ availabilityDomain: form.availabilityDomain, shape });
                      setAcknowledged(false);
                      setForm((current) => ({ ...current, shape, imageId: "" }));
                    }}
                    options={
                      data.shapes.length
                        ? data.shapes.map((shape) => ({ value: shape.name, label: shape.name }))
                        : [{ value: "", label: "该可用域暂无可用规格" }]
                    }
                  />
                </Field>
                {shape?.flexible && (
                  <>
                    <Field label="OCPU" required>
                      <Input
                        type="number"
                        required
                        min={shape.minOcpus || 1}
                        max={shape.maxOcpus}
                        step="1"
                        value={form.ocpus}
                        onChange={(e) => setForm({ ...form, ocpus: Number(e.target.value) })}
                      />
                    </Field>
                    <Field label="内存 (GiB)" required>
                      <Input
                        type="number"
                        required
                        min={shape.minMemoryGb || 1}
                        max={shape.maxMemoryGb}
                        value={form.memoryGb}
                        onChange={(e) => setForm({ ...form, memoryGb: Number(e.target.value) })}
                      />
                    </Field>
                  </>
                )}
                <Field label="系统镜像" required className="sm:col-span-2">
                  <Select
                    value={form.imageId}
                    disabled={updating || !options.data}
                    onValueChange={(value) => setForm({ ...form, imageId: value })}
                    options={
                      data.images.length
                        ? data.images.map((image) => ({ value: image.id, label: image.name }))
                        : [{ value: "", label: "该规格暂无兼容镜像" }]
                    }
                  />
                </Field>
                <Field label="子网" required>
                  <Select
                    value={form.subnetId}
                    disabled={updating || !options.data}
                    onValueChange={(value) => setForm({ ...form, subnetId: value })}
                    options={
                      data.subnets.length
                        ? data.subnets.map((subnet) => ({ value: subnet.id, label: subnet.name }))
                        : [{ value: "", label: "该可用域暂无可用子网" }]
                    }
                  />
                </Field>
                <Field label="启动卷容量 (GiB)" required>
                  <Input
                    required
                    type="number"
                    min={50}
                    max={32768}
                    value={form.bootVolumeSizeGb}
                    onChange={(e) => setForm({ ...form, bootVolumeSizeGb: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.assignPublicIp}
                  onCheckedChange={(checked) =>
                    setForm({ ...form, assignPublicIp: checked === true })
                  }
                />
                为主网卡分配公网 IPv4
              </label>
              <Field
                label="SSH 公钥"
                required
                hint="只填写公钥，例如 ssh-ed25519 AAAA…，不要上传私钥。"
              >
                <Textarea
                  required
                  className="font-mono tabular-nums"
                  value={form.sshPublicKey}
                  onChange={(e) => setForm({ ...form, sshPublicKey: e.target.value })}
                  placeholder="ssh-ed25519 AAAA…"
                />
              </Field>
              <div className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-dashed p-3 text-xs">
                <Upload size={16} />
                <Input
                  className="min-w-0 max-w-full flex-1"
                  type="file"
                  accept=".pub,.txt"
                  aria-label="从文件读取 SSH 公钥"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (file.size > 65536) {
                      setFileError("公钥文件不能超过 64 KiB。");
                      return;
                    }
                    const text = (await file.text()).trim();
                    if (!/^(ssh-|ecdsa-)/.test(text)) {
                      setFileError("该文件不是支持的 SSH 公钥。");
                      return;
                    }
                    setFileError(null);
                    setForm((current) => ({ ...current, sshPublicKey: text }));
                  }}
                />
              </div>
              {fileError && <ErrorState message={fileError} />}
              <Alert tone="info">资源是否收费取决于账号额度与所选规格，请以 OCI 账单为准。</Alert>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                确认使用上述配置创建实例
              </label>
            </>
          )
        )}
        {action.error && <ErrorState message={action.error} />}
      </form>
    </Modal>
  );
}
