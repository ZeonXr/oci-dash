import { z } from "zod";
import type { InventoryRefreshResult } from "@/lib/contracts";
import { listAccounts } from "./accounts";
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
}

/** Page-triggered refresh only. This entry never contacts OCI or installs a scheduler. */
export function requestInventoryRefresh(
  input: unknown,
  requestedBy: string,
  dependencies?: RefreshDependencies,
): InventoryRefreshResult {
  const parsed = inputSchema.parse(input);
  const store = dependencies?.store ?? getJobStore();
  const accountIds =
    parsed.accountIds ?? dependencies?.accountIds() ?? listAccounts().map((account) => account.id);
  return store.refreshInventory(accountIds, parsed.mode, requestedBy);
}
