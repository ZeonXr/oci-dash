import { z } from "zod";
import type { InventoryRefreshResult } from "@/lib/contracts";
import { listAccounts } from "./accounts";
import { isDemo } from "./db";
import { AppError } from "./errors";
import { getJobStore, type JobStore } from "./jobs";

const inputSchema = z
  .object({
    mode: z.enum(["auto", "manual"]),
    accountIds: z.array(z.string().min(1).max(200)).max(200).optional(),
  })
  .strict();

interface RefreshDependencies {
  store: Pick<JobStore, "refreshInventory">;
  accountIds(): string[];
  demo(): boolean;
}

/** Page-triggered refresh only. This entry never contacts OCI or installs a scheduler. */
export function requestInventoryRefresh(
  input: unknown,
  requestedBy: string,
  dependencies?: RefreshDependencies,
): InventoryRefreshResult {
  if ((dependencies?.demo ?? isDemo)())
    throw new AppError("演示模式不会刷新真实云资源", 403, "DEMO_READ_ONLY");
  const parsed = inputSchema.parse(input);
  const store = dependencies?.store ?? getJobStore();
  const accountIds =
    parsed.accountIds ?? dependencies?.accountIds() ?? listAccounts().map((account) => account.id);
  return { ...store.refreshInventory(accountIds, parsed.mode, requestedBy), demo: false };
}
