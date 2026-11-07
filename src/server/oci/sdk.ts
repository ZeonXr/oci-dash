import { CloudError, type OciCredentials, type ExecutionContext } from "./types";

/** The SDK boundary is deliberately replaceable. No credentials or raw SDK errors leave it. */
// OCI service models contain service-specific, optional fields, including extension tags.
export type CloudDocument = Record<string, any>;
export interface ClientPort {
  call(operation: string, request: CloudDocument): Promise<CloudDocument>;
  close(): void | Promise<void>;
}
export interface OciClients { identity: ClientPort; compute: ClientPort; network: ClientPort; storage: ClientPort; monitoring: ClientPort; }
export type OciClientFactory = (credentials: OciCredentials, region: string) => Promise<OciClients> | OciClients;

export const sdkClientFactory: OciClientFactory = async (credentials, region) => {
  const [common, core, identity, monitoring] = await Promise.all([
    import("oci-common"), import("oci-core"), import("oci-identity"), import("oci-monitoring"),
  ]);
  const selectedRegion = common.Region.fromRegionId(region);
  const provider = new common.SimpleAuthenticationDetailsProvider(
    credentials.tenancyId, credentials.userId, credentials.fingerprint, credentials.privateKey, null, selectedRegion,
  );
  const configuration = () => ({
    retryConfiguration: common.NoRetryConfigurationDetails,
    // OCI's fetch transport spreads httpOptions for every request, so each RPC gets its own deadline.
    httpOptions: { get signal() { return AbortSignal.timeout(30_000); } },
  });
  const wrap = (client: any): ClientPort => {
    // These clients and provider are exclusive to one invocation/region, never shared or mutated later.
    client.region = selectedRegion;
    return {
      async call(operation, request) {
        if (typeof client[operation] !== "function") throw new CloudError("不支持的 OCI SDK 操作", "SDK_OPERATION_UNAVAILABLE");
        // Durable jobs own retries. In particular, NSG add has no OCI idempotency token.
        return client[operation]({ ...request, retryConfiguration: common.NoRetryConfigurationDetails });
      },
      close() { client.close(); },
    };
  };
  return {
    identity: wrap(new identity.IdentityClient({ authenticationDetailsProvider: provider }, configuration())),
    compute: wrap(new core.ComputeClient({ authenticationDetailsProvider: provider }, configuration())),
    network: wrap(new core.VirtualNetworkClient({ authenticationDetailsProvider: provider }, configuration())),
    storage: wrap(new core.BlockstorageClient({ authenticationDetailsProvider: provider }, configuration())),
    monitoring: wrap(new monitoring.MonitoringClient({ authenticationDetailsProvider: provider }, configuration())),
  };
};

export function checkCancelled(context?: ExecutionContext): void {
  if (context?.signal.aborted) throw new CloudError("操作已取消", "CANCELLED");
}
export function errorStatus(error: unknown): number | undefined {
  const e = error as { statusCode?: unknown; status?: unknown };
  const status = e?.statusCode ?? e?.status;
  return typeof status === "number" && Number.isFinite(status) ? status : undefined;
}
export function cloudError(error: unknown, action = "OCI 请求失败"): CloudError {
  if (error instanceof CloudError) return error;
  const e = error as { code?: string; serviceCode?: string; statusCode?: unknown; name?: string; message?: unknown; opcRequestId?: string; requestId?: string };
  // The official SDK retrier flattens non-service exceptions and drops their name/cause.
  // Inspect only known transport phrases for classification; never return their raw message/URL.
  const message = typeof e?.message === "string" ? e.message : "";
  const timedOut = e?.name === "TimeoutError" || e?.name === "AbortError" || /^The operation was aborted(?: due to timeout)?[.]?$/.test(message);
  const networkFailure = message === "fetch failed" || message === "Failed to fetch";
  const code = [e?.serviceCode, e?.code, e?.statusCode].find(s => typeof s === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(s)) as string | undefined
    ?? (timedOut ? "OCI_TIMEOUT" : networkFailure ? "OCI_NETWORK_ERROR" : "OCI_ERROR");
  const status = errorStatus(error);
  const retryable = timedOut || networkFailure || status === 429 || (status !== undefined && status >= 500) || ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "ECONNREFUSED", "EOPENBREAKER"].includes(code);
  const requestId = e?.opcRequestId ?? e?.requestId;
  // Never include error.message, request objects, signing data, or raw response bodies.
  return new CloudError(`${action}（${code}${status ? ` / HTTP ${status}` : ""}）`, code, retryable,
    typeof requestId === "string" && /^[A-Za-z0-9/_-]{1,256}$/.test(requestId) ? requestId : undefined);
}
export async function invoke(client: ClientPort, operation: string, request: CloudDocument, context?: ExecutionContext): Promise<CloudDocument> {
  checkCancelled(context);
  try { return await client.call(operation, request); }
  catch (error) { throw cloudError(error); }
}
export async function optionalGet(client: ClientPort, operation: string, request: CloudDocument, context?: ExecutionContext): Promise<CloudDocument | null> {
  checkCancelled(context);
  try { return await client.call(operation, request); }
  catch (error) {
    // OCI uses 404 both for unavailable and unauthorized resources. This is only an observation;
    // mutation callers must also prove ownership from an attached/accessible parent resource.
    if (errorStatus(error) === 404) return null;
    throw cloudError(error);
  }
}
export async function allPages(client: ClientPort, operation: string, request: CloudDocument, context?: ExecutionContext): Promise<CloudDocument[]> {
  const result: CloudDocument[] = [];
  const seen = new Set<string>();
  let page: string | undefined;
  do {
    const response = await invoke(client, operation, { ...request, ...(page ? { page } : {}) }, context);
    if (!Array.isArray(response.items)) throw new CloudError("OCI 分页响应格式不正确", "INVALID_CLOUD_RESPONSE");
    result.push(...response.items);
    page = response.opcNextPage || undefined;
    if (page) {
      if (seen.has(page) || seen.size >= 10000) throw new CloudError("OCI 分页游标重复或超过限制", "PAGINATION_LOOP");
      seen.add(page);
    }
  } while (page);
  return result;
}
export async function closeClients(clients: OciClients): Promise<void> {
  await Promise.allSettled([...new Set(Object.values(clients))].map(client => Promise.resolve().then(() => client.close())));
}
