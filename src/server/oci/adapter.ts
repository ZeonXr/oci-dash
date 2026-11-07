import type { InventoryResult } from "@/lib/contracts";
import { CloudError, type OciAdapter, type OciCredentials } from "./types";
import { checkCancelled, closeClients, cloudError, sdkClientFactory, type OciClientFactory, type OciClients } from "./sdk";
import { ocid, regionName } from "./helpers";
import { getCreateOptions, getMetrics, getSecurityGroups, inventoryRegion, verifyAccount } from "./read";
import { executeOperation } from "./operations";

export interface OciAdapterOptions { clientFactory?: OciClientFactory; now?: () => number; pollIntervalMs?: number; pollAttempts?: number; }
export function createOciAdapter(options: OciAdapterOptions = {}): OciAdapter {
  const factory = options.clientFactory ?? sdkClientFactory;
  const now = options.now ?? Date.now;
  const scoped = async <T>(credentials: OciCredentials, region: string, work: (clients: OciClients) => Promise<T>): Promise<T> => {
    regionName(region); ocid(credentials.tenancyId, "tenancy"); ocid(credentials.userId, "user");
    let clients: OciClients | undefined;
    try { clients = await factory({ ...credentials, region }, region); return await work(clients); }
    catch (error) { throw cloudError(error); }
    finally { if (clients) await closeClients(clients); }
  };
  return {
    verify: credentials => scoped(credentials, credentials.region, clients => verifyAccount(clients, credentials)),
    async inventory(credentials, account, regions, context) {
      if (account.tenancyId !== credentials.tenancyId || account.userId !== credentials.userId) throw new CloudError("账号与解密后的 OCI 身份不一致", "RESOURCE_MISMATCH");
      const selected = [...new Set(regions)];
      if (!selected.length) throw new CloudError("请至少选择一个区域", "VALIDATION_ERROR");
      const result: InventoryResult = { instances: [], warnings: [], regions: selected };
      let successfulLists = 0;
      for (const region of selected) {
        checkCancelled(context);
        try {
          const found = await scoped(credentials, region, clients => inventoryRegion(clients, { ...credentials, region }, account, region, context));
          result.instances.push(...found.instances); result.warnings.push(...found.warnings); successfulLists += found.successfulLists;
        } catch (error) {
          if (error instanceof CloudError && error.code === "CANCELLED") throw error;
          result.warnings.push(`${region}：${cloudError(error).message}`);
        }
      }
      if (!successfulLists) throw new CloudError("所有区域的实例读取均失败，保留已有清单", "INVENTORY_UNAVAILABLE", true);
      checkCancelled(context);
      return result;
    },
    metrics: (credentials, instance, range) => scoped(credentials, instance.region, clients => getMetrics(clients, credentials, instance, range, now())),
    createOptions: (credentials, compartmentId) => scoped(credentials, credentials.region, clients => getCreateOptions(clients, credentials, compartmentId)),
    securityGroups: (credentials, instance) => scoped(credentials, instance.region, clients => getSecurityGroups(clients, credentials, instance)),
    execute: (credentials, operation, context) => scoped(credentials, operation.region, clients => executeOperation(clients, credentials, operation, context, {
      now, pollIntervalMs: options.pollIntervalMs ?? 2500, pollAttempts: options.pollAttempts ?? 12,
    })),
  };
}
export const ociAdapter = createOciAdapter();
export type { OciClientFactory, OciClients, ClientPort } from "./sdk";
