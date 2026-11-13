import type { InstanceSummary } from "@/lib/contracts";
export { operationLabels } from "@/lib/operation-labels";
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
export function refreshTooltip(value?: string | null, now = new Date()): string {
  if (!value || Number.isNaN(Date.parse(value))) return "刷新";
  const date = new Date(value);
  const sameYear = date.getFullYear() === now.getFullYear();
  const sameDay =
    sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  const pad = (part: number) => String(part).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const day = `${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
  return `上次更新：${sameDay ? time : `${sameYear ? "" : `${date.getFullYear()}/`}${day} ${time}`}`;
}
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
