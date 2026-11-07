import type { InventoryResult } from "@/lib/contracts";
import { CloudError, type OciAdapter, type OciCredentials } from "./types";
import {
  checkCancelled,
  closeClients,
  cloudError,
  sdkClientFactory,
  type OciClientFactory,
  type OciClients,
} from "./sdk";
import { ocid, regionName } from "./helpers";
import {
  getCreateOptions,
  getMetrics,
  getSecurityGroups,
  inventoryRegion,
  verifyAccount,
} from "./read";
import { executeOperation } from "./operations";
import { createInventoryReader, mapInventory } from "./inventory-performance";

export interface OciAdapterOptions {
  clientFactory?: OciClientFactory;
  now?: () => number;
  pollIntervalMs?: number;
  pollAttempts?: number;
}
export function createOciAdapter(options: OciAdapterOptions = {}): OciAdapter {
  const factory = options.clientFactory ?? sdkClientFactory;
  const now = options.now ?? Date.now;
  const inventoryReader = createInventoryReader(factory, now);
  const scoped = async <T>(
    credentials: OciCredentials,
    region: string,
    work: (clients: OciClients) => Promise<T>,
  ): Promise<T> => {
    regionName(region);
    ocid(credentials.tenancyId, "tenancy");
    ocid(credentials.userId, "user");
    let clients: OciClients | undefined;
    try {
      clients = await factory({ ...credentials, region }, region);
      return await work(clients);
    } catch (error) {
      throw cloudError(error);
    } finally {
      if (clients) await closeClients(clients);
    }
  };
  return {
    verify: (credentials) =>
      scoped(credentials, credentials.region, (clients) => verifyAccount(clients, credentials)),
    async inventory(credentials, account, regions, context) {
      if (account.tenancyId !== credentials.tenancyId || account.userId !== credentials.userId)
        throw new CloudError("账号与解密后的 OCI 身份不一致", "RESOURCE_MISMATCH");
      const selected = [...new Set(regions)];
      if (!selected.length) throw new CloudError("请至少选择一个区域", "VALIDATION_ERROR");
      const result: InventoryResult = {
        instances: [],
        warnings: [],
        regions: selected,
        completedScopes: [],
        details: {},
      };
      const foundRegions = await mapInventory(
        selected,
        2,
        async (region) => {
          checkCancelled(context);
          try {
            regionName(region);
            ocid(credentials.tenancyId, "tenancy");
            ocid(credentials.userId, "user");
            const found = await inventoryReader.region(
              credentials,
              region,
              context,
              (clients, image) =>
                inventoryRegion(
                  clients,
                  { ...credentials, region },
                  account,
                  region,
                  context,
                  image,
                ),
            );
            return { found };
          } catch (error) {
            if (error instanceof CloudError && error.code === "CANCELLED") throw error;
            return { warning: `${region}：${cloudError(error).message}` };
          }
        },
        context?.signal,
      );
      let successfulLists = 0;
      for (const item of foundRegions) {
        if (item.found) {
          result.instances.push(...item.found.instances);
          result.warnings.push(...item.found.warnings);
          result.completedScopes!.push(...(item.found.completedScopes ?? []));
          Object.assign(result.details!, item.found.details);
          successfulLists += item.found.successfulLists;
        } else if (item.warning) {
          result.warnings.push(item.warning);
        }
      }
      if (!successfulLists)
        throw new CloudError(
          "所有区域的实例读取均失败，保留已有清单",
          "INVENTORY_UNAVAILABLE",
          true,
        );
      checkCancelled(context);
      return result;
    },
    metrics: (credentials, instance, range) =>
      scoped(credentials, instance.region, (clients) =>
        getMetrics(clients, credentials, instance, range, now()),
      ),
    createOptions: (credentials, compartmentId) =>
      scoped(credentials, credentials.region, (clients) =>
        getCreateOptions(clients, credentials, compartmentId),
      ),
    securityGroups: (credentials, instance) =>
      scoped(credentials, instance.region, (clients) =>
        getSecurityGroups(clients, credentials, instance),
      ),
    execute: (credentials, operation, context) =>
      scoped(credentials, operation.region, (clients) =>
        executeOperation(clients, credentials, operation, context, {
          now,
          pollIntervalMs: options.pollIntervalMs ?? 2500,
          pollAttempts: options.pollAttempts ?? 12,
        }),
      ),
  };
}
export const ociAdapter = createOciAdapter();
export type { OciClientFactory, OciClients, ClientPort } from "./sdk";
