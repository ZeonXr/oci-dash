import { createHash } from "node:crypto";
import { closeClients, type CloudDocument, type OciClientFactory, type OciClients } from "./sdk";
import { CloudError, type ExecutionContext, type OciCredentials } from "./types";

const IMAGE_TTL_MS = 60 * 60_000;
const IMAGE_CACHE_LIMIT = 256;

function checkSignal(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CloudError("操作已取消", "CANCELLED");
}

/** Cancel queued work, but keep a slot until an already dispatched operation actually settles. */
function limiter(limit: number) {
  let active = 0;
  const queue: { start(): void; cancel(): void; signal?: AbortSignal }[] = [];
  const advance = () => {
    while (active < limit && queue.length) {
      const entry = queue.shift()!;
      if (entry.signal?.aborted) entry.cancel();
      else entry.start();
    }
  };
  return async <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    await new Promise<void>((resolve, reject) => {
      const entry = {
        signal,
        start() {
          signal?.removeEventListener("abort", entry.cancel);
          active++;
          resolve();
        },
        cancel() {
          signal?.removeEventListener("abort", entry.cancel);
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          reject(new CloudError("操作已取消", "CANCELLED"));
        },
      };
      if (signal?.aborted) entry.cancel();
      else if (active < limit) entry.start();
      else {
        queue.push(entry);
        signal?.addEventListener("abort", entry.cancel, { once: true });
      }
    });
    try {
      checkSignal(signal);
      const value = await action();
      checkSignal(signal);
      return value;
    } finally {
      active--;
      advance();
    }
  };
}

/** Results retain input order; every started worker drains before an error escapes. */
export async function mapInventory<T, R>(
  items: readonly T[],
  concurrency: number,
  read: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    try {
      while (!failed && cursor < items.length) {
        checkSignal(signal);
        const index = cursor++;
        results[index] = await read(items[index], index);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  });
  const settled = await Promise.allSettled(workers);
  checkSignal(signal);
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
}

function imageOs(response: CloudDocument, imageId: string): string {
  const image = response.image;
  if (!image || image.id !== imageId)
    throw new CloudError("系统镜像读取结果不一致", "RESOURCE_MISMATCH");
  const text = (value: unknown) =>
    typeof value === "string" && value.length <= 512 ? value.trim() : "";
  const os =
    [text(image.operatingSystem), text(image.operatingSystemVersion)].filter(Boolean).join(" ") ||
    text(image.displayName);
  if (!os) throw new CloudError("系统镜像未返回系统信息", "INVALID_CLOUD_RESPONSE");
  return os;
}

export type InventoryImageReader = (imageId: string) => Promise<string>;

/** One adapter owns this quota/cache; mutation, console and create-option clients never enter it. */
export function createInventoryReader(factory: OciClientFactory, now: () => number = Date.now) {
  const rpc = limiter(4);
  const regions = limiter(2);
  // The key is an identity/credential digest and an image OCID. Values contain only an OS label.
  const images = new Map<string, { os: string; expires: number }>();
  return {
    region<T>(
      credentials: OciCredentials,
      region: string,
      context: ExecutionContext | undefined,
      read: (clients: OciClients, image: InventoryImageReader) => Promise<T>,
    ): Promise<T> {
      return regions(async () => {
        let raw: OciClients | undefined;
        const signal = context?.signal;
        try {
          checkSignal(signal);
          raw = await factory({ ...credentials, region }, region);
          checkSignal(signal);
          const clients = Object.fromEntries(
            Object.entries(raw).map(([service, client]) => [
              service,
              {
                call: (operation: string, request: CloudDocument) =>
                  rpc(() => client.call(operation, request), signal),
                close: () => {},
              },
            ]),
          ) as unknown as OciClients;
          const identity = createHash("sha256")
            .update(
              JSON.stringify([
                credentials.tenancyId,
                credentials.userId,
                credentials.fingerprint,
                credentials.privateKey,
                region,
              ]),
            )
            .digest("hex");
          // Only readers sharing this region lifecycle coalesce work. Other callers' cancellation
          // cannot cancel an image read owned by a different inventory request/client lifecycle.
          const pending = new Map<string, Promise<string>>();
          const image: InventoryImageReader = async (imageId) => {
            checkSignal(signal);
            const key = identity + "/" + imageId;
            const cached = images.get(key);
            if (cached && cached.expires > now()) {
              images.delete(key);
              images.set(key, cached);
              return cached.os;
            }
            if (cached) images.delete(key);
            const existing = pending.get(imageId);
            if (existing) return existing;
            const operation = clients.compute
              .call("getImage", { imageId })
              .then((response) => {
                checkSignal(signal);
                const os = imageOs(response, imageId);
                const time = now();
                for (const [oldKey, item] of images)
                  if (item.expires <= time) images.delete(oldKey);
                if (images.size >= IMAGE_CACHE_LIMIT) images.delete(images.keys().next().value!);
                images.set(key, { os, expires: time + IMAGE_TTL_MS });
                return os;
              })
              .finally(() => pending.delete(imageId));
            pending.set(imageId, operation);
            return operation;
          };
          return await read(clients, image);
        } finally {
          if (raw) await closeClients(raw);
        }
      }, context?.signal);
    },
  };
}
