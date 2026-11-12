import { AlertCircle } from "lucide-react";
import type { InstanceSummary } from "@/lib/contracts";
import { Badge } from "./ui";

export function InventoryFreshness({ instance }: { instance: InstanceSummary }) {
  if (!instance.staleFields?.length) return null;
  const description = `${instance.staleFields.join("、")}未更新；已有数据保留上次读取结果`;
  return (
    <Badge tone="warning" title={description} aria-label={description}>
      <AlertCircle size={12} aria-hidden="true" />
      部分未更新
    </Badge>
  );
}
