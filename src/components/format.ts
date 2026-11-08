import type { InstanceSummary } from "@/lib/contracts";
export { operationLabels } from "@/lib/operation-labels";
const regions: Record<string, string> = {
  "ap-singapore-1": "新加坡",
  "ap-singapore-2": "新加坡 2",
  "ap-tokyo-1": "东京",
  "ap-osaka-1": "大阪",
  "ap-seoul-1": "首尔",
  "ap-chuncheon-1": "春川",
  "us-phoenix-1": "凤凰城",
  "us-ashburn-1": "阿什本",
  "us-sanjose-1": "圣何塞",
  "uk-london-1": "伦敦",
  "uk-cardiff-1": "卡迪夫",
  "eu-frankfurt-1": "法兰克福",
  "eu-amsterdam-1": "阿姆斯特丹",
  "ca-toronto-1": "多伦多",
  "ap-sydney-1": "悉尼",
};
export const regionName = (value: string) => regions[value] || value;
export const formatDate = (value?: string | null, full = false) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        ...(full ? { year: "numeric" } : {}),
      }).format(new Date(value))
    : "—";
export const shortId = (value?: string | null) =>
  !value ? "—" : value.length > 34 ? `${value.slice(0, 20)}…${value.slice(-9)}` : value;
export const number = (value?: number | null, digits = 0) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("zh-CN", { maximumFractionDigits: digits });
export const percent = (value?: number | null) => (value == null ? "—" : `${number(value, 1)}%`);
export const publicBindings = (instance: InstanceSummary) =>
  instance.vnics.flatMap((vnic) => vnic.privateIps).filter((binding) => Boolean(binding.publicIp));
export const primaryAddress = (instance: InstanceSummary) => {
  const items = publicBindings(instance);
  return (
    items.find((b) => b.protected || b.lifetime === "RESERVED")?.publicIp ||
    items[0]?.publicIp ||
    instance.vnics[0]?.privateIps[0]?.privateIp ||
    "—"
  );
};
export const instanceHref = (id: string) => `/instances/${encodeURIComponent(id)}`;
export const taskHref = (id: string) => `/tasks/${encodeURIComponent(id)}`;
