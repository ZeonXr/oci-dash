"use client";
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
            variant="primary"
            loading={action.pending}
            disabled={!acknowledged || !ready}
          >
            创建实例
          </Button>
        </>
      }
    >
      <form id="create-instance-form" onSubmit={submit} className="stack">
        <div className="form-grid">
          <Field label="OCI 账号" required>
            <Select value={accountId} onChange={(e) => changeAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="区域" required>
            <Select
              value={region}
              onChange={(e) => {
                setRegion(e.target.value);
                setCompartment("");
                resetChoices();
              }}
            >
              {Array.from(new Set([account?.homeRegion, ...(account?.regions || [])]))
                .filter(Boolean)
                .map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        {options.error && <ErrorState message={options.error} retry={options.reload} />}
        {options.loading && !data ? (
          <LoadingState label="正在读取可用规格、镜像与网络…" />
        ) : (
          data && (
            <>
              <div className="form-grid">
                <Field label="实例名称" required>
                  <input
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
                    onChange={(e) => {
                      setCompartment(e.target.value);
                      resetChoices();
                    }}
                  >
                    {data.compartments.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="可用域" required>
                  <Select
                    value={form.availabilityDomain}
                    disabled={updating || !options.data}
                    onChange={(e) => {
                      const availabilityDomain = e.target.value;
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
                  >
                    {!data.availabilityDomains.length && <option value="">该区域暂无可用域</option>}
                    {data.availabilityDomains.map((ad) => (
                      <option key={ad}>{ad}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="实例规格" required>
                  <Select
                    value={form.shape}
                    disabled={updating || !options.data}
                    onChange={(e) => {
                      const shape = e.target.value;
                      setSelection({ availabilityDomain: form.availabilityDomain, shape });
                      setAcknowledged(false);
                      setForm((current) => ({ ...current, shape, imageId: "" }));
                    }}
                  >
                    {!data.shapes.length && <option value="">该可用域暂无可用规格</option>}
                    {data.shapes.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {shape?.flexible && (
                  <>
                    <Field label="OCPU" required>
                      <input
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
                      <input
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
                <Field label="系统镜像" required className="span-2">
                  <Select
                    value={form.imageId}
                    disabled={updating || !options.data}
                    onChange={(e) => setForm({ ...form, imageId: e.target.value })}
                  >
                    {!data.images.length && <option value="">该规格暂无兼容镜像</option>}
                    {data.images.map((image) => (
                      <option key={image.id} value={image.id}>
                        {image.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="子网" required>
                  <Select
                    value={form.subnetId}
                    disabled={updating || !options.data}
                    onChange={(e) => setForm({ ...form, subnetId: e.target.value })}
                  >
                    {!data.subnets.length && <option value="">该可用域暂无可用子网</option>}
                    {data.subnets.map((subnet) => (
                      <option key={subnet.id} value={subnet.id}>
                        {subnet.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="启动卷容量 (GiB)" required>
                  <input
                    required
                    type="number"
                    min={50}
                    max={32768}
                    value={form.bootVolumeSizeGb}
                    onChange={(e) => setForm({ ...form, bootVolumeSizeGb: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={form.assignPublicIp}
                  onChange={(e) => setForm({ ...form, assignPublicIp: e.target.checked })}
                />
                为主网卡分配公网 IPv4
              </label>
              <Field
                label="SSH 公钥"
                required
                hint="只填写公钥，例如 ssh-ed25519 AAAA…，不要上传私钥。"
              >
                <textarea
                  required
                  className="mono"
                  value={form.sshPublicKey}
                  onChange={(e) => setForm({ ...form, sshPublicKey: e.target.value })}
                  placeholder="ssh-ed25519 AAAA…"
                />
              </Field>
              <div className="file-upload">
                <Upload size={16} />
                <input
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
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
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
