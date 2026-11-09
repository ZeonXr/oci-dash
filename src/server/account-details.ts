import type { AccountCloudInfo, AccountDetails } from "@/lib/account-details-contracts";
import type { AccountSummary, InstanceSummary } from "@/lib/contracts";
import { getAccount, getCredentialSnapshot } from "./accounts";
import { getDatabase } from "./db";
import { AppError } from "./errors";
import { listInstances } from "./inventory";
import { createReadLimiter } from "./oci/inventory-performance";
import { iso, ocid, regionName } from "./oci/helpers";
import {
  allPages,
  closeClients,
  cloudError,
  invoke,
  sdkClientFactory,
  type OciClientFactory,
  type OciClients,
} from "./oci/sdk";
import { CloudError } from "./oci/types";

function inventorySummary(
  account: AccountSummary,
  instances: InstanceSummary[],
): AccountDetails["inventory"] {
  const volumes = new Map(
    instances.flatMap((instance) =>
      instance.bootVolumes.map((volume) => [volume.id, volume] as const),
    ),
  );
  const ips = new Set(
    instances.flatMap((instance) =>
      instance.vnics.flatMap((vnic) =>
        vnic.privateIps.flatMap((ip) => (ip.publicIp ? [ip.publicIp] : [])),
      ),
    ),
  );
  const knownSize = (value: number) => Number.isFinite(value) && value > 0;
  const total = (values: number[]) =>
    values.every(knownSize) ? values.reduce((sum, value) => sum + value, 0) : null;
  const ocpus = total(instances.map((instance) => instance.ocpus));
  const memoryGb = total(instances.map((instance) => instance.memoryGb));
  const bootVolumeGb = instances.some((instance) => !instance.bootVolumes.length)
    ? null
    : total([...volumes.values()].map((volume) => volume.sizeGb));
  return {
    instances: instances.length,
    running: instances.filter((instance) => instance.state === "RUNNING").length,
    stopped: instances.filter((instance) => instance.state === "STOPPED").length,
    ocpus,
    memoryGb,
    bootVolumeGb,
    publicIps: ips.size,
    lastSyncedAt: account.lastSyncAt,
    partial:
      account.status !== "connected" ||
      !account.lastSyncAt ||
      instances.some((instance) => instance.staleFields?.length) ||
      [ocpus, memoryGb, bootVolumeGb].some((value) => value === null),
  };
}

const optionalText = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.slice(0, 4096) : null;
const mismatch = () => new CloudError("OCI 返回的账号身份不一致", "RESOURCE_MISMATCH");

export function createAccountDetailsService(
  options: { factory?: OciClientFactory; timeoutMs?: number; now?: () => number } = {},
) {
  const factory = options.factory ?? sdkClientFactory;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const now = options.now ?? Date.now;
  const rpc = createReadLimiter(3);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Invalid account details deadline");
  return {
    async query(id: string, callerSignal?: AbortSignal): Promise<AccountDetails> {
      if (callerSignal?.aborted)
        throw new AppError("账号详情查询已取消", 499, "ACCOUNT_DETAILS_CANCELLED");
      const initial = getDatabase().transaction(() => {
        const account = getAccount(id);
        if (!account) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
        return {
          account,
          access: getCredentialSnapshot(id),
          instances: listInstances().filter(
            (instance) => instance.accountId === id && account.regions.includes(instance.region),
          ),
        };
      })();
      const { account, access } = initial;
      const cloud: AccountCloudInfo = {
        tenancy: null,
        user: null,
        regions: null,
        errors: [],
        checkedAt: new Date(now()).toISOString(),
      };
      const sections = ["tenancy", "user", "regions"] as const;
      const errors = new Map<AccountCloudInfo["errors"][number]["section"], string>();
      const controller = new AbortController();
      const signal = callerSignal
        ? AbortSignal.any([controller.signal, callerSignal])
        : controller.signal;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref();
      const work = (async () => {
        let clients: OciClients | undefined;
        try {
          clients = await factory(access.credentials, access.credentials.region, signal);
          signal.throwIfAborted();
          const identity = clients.identity;
          const read = async (section: (typeof sections)[number], action: () => Promise<void>) => {
            try {
              await action();
            } catch (error) {
              errors.set(
                section,
                signal.aborted ? "OCI 信息读取超时，请重试" : cloudError(error).message,
              );
            }
          };
          await Promise.all([
            read("tenancy", async () => {
              const { tenancy } = await rpc(
                () =>
                  invoke(identity, "getTenancy", {
                    tenancyId: ocid(access.credentials.tenancyId, "tenancy"),
                  }),
                signal,
              );
              if (!tenancy || tenancy.id !== access.credentials.tenancyId) throw mismatch();
              cloud.tenancy = {
                id: tenancy.id,
                name: optionalText(tenancy.name) ?? tenancy.id,
                description: optionalText(tenancy.description),
                homeRegionKey: optionalText(tenancy.homeRegionKey),
              };
            }),
            read("user", async () => {
              const { user } = await rpc(
                () =>
                  invoke(identity, "getUser", { userId: ocid(access.credentials.userId, "user") }),
                signal,
              );
              if (
                !user ||
                user.id !== access.credentials.userId ||
                user.compartmentId !== access.credentials.tenancyId
              )
                throw mismatch();
              cloud.user = {
                id: user.id,
                name: optionalText(user.name) ?? user.id,
                description: optionalText(user.description),
                email: optionalText(user.email),
                state: optionalText(user.lifecycleState),
                createdAt: iso(user.timeCreated) || null,
                mfaActivated: typeof user.isMfaActivated === "boolean" ? user.isMfaActivated : null,
              };
            }),
            read("regions", async () => {
              const items = await allPages(
                {
                  call: (operation, request) =>
                    rpc(() => identity.call(operation, request), signal),
                  close() {},
                },
                "listRegionSubscriptions",
                { tenancyId: ocid(access.credentials.tenancyId, "tenancy") },
              );
              cloud.regions = items.map((region) => {
                if (typeof region.isHomeRegion !== "boolean" || !optionalText(region.status))
                  throw new CloudError("OCI 区域订阅响应格式不正确", "INVALID_CLOUD_RESPONSE");
                return {
                  name: regionName(region.regionName),
                  key: optionalText(region.regionKey),
                  status: region.status as string,
                  home: region.isHomeRegion,
                };
              });
            }),
          ]);
        } catch (error) {
          for (const section of sections)
            if (!cloud[section] && !errors.has(section))
              errors.set(
                section,
                signal.aborted ? "OCI 信息读取超时，请重试" : cloudError(error).message,
              );
        } finally {
          // The HTTP deadline may finish earlier; clients stay open until actual RPCs settle.
          if (clients) await closeClients(clients);
        }
      })();
      try {
        await new Promise<void>((resolve) => {
          const done = () => {
            signal.removeEventListener("abort", done);
            resolve();
          };
          if (!signal.aborted) signal.addEventListener("abort", done, { once: true });
          void work.then(done, done);
          if (signal.aborted) done();
        });
        if (callerSignal?.aborted)
          throw new AppError("账号详情查询已取消", 499, "ACCOUNT_DETAILS_CANCELLED");
        if (controller.signal.aborted)
          for (const section of sections)
            if (!cloud[section]) errors.set(section, "OCI 信息读取超时，请重试");
        const current = getCredentialSnapshot(id);
        if (current.revision !== access.revision)
          throw new AppError("账号配置已变更，请重新读取详情", 409, "ACCOUNT_CHANGED");
        const freshAccount = getAccount(id);
        if (!freshAccount) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
        return {
          account: freshAccount,
          inventory: inventorySummary(account, initial.instances),
          cloud: structuredClone({
            ...cloud,
            errors: sections.flatMap((section) =>
              errors.has(section) ? [{ section, message: errors.get(section)! }] : [],
            ),
          }),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const accountDetailsService = createAccountDetailsService();
