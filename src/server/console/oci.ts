import { compartments, ocid, regionName, requireCompartment } from "../oci/helpers";
import { allPages, errorStatus, invoke, type CloudDocument, type OciClients } from "../oci/sdk";
import { CloudError, type ExecutionContext } from "../oci/types";
import type { ConsoleTarget } from "./types";

export const CONSOLE_TAGS = {
  purpose: "oci-dash-console",
  session: "oci-dash-session",
  account: "oci-dash-account",
} as const;

export function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new CloudError("控制台操作已取消", "CANCELLED");
}

export function validateConsoleIdentity(target: ConsoleTarget, sessionId: string): void {
  ocid(target.instanceId, "instance");
  ocid(target.credentials.tenancyId, "tenancy");
  regionName(target.region);
  if (
    target.credentials.region !== target.region ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(target.accountId) ||
    !/^[A-Za-z0-9-]{1,64}$/.test(sessionId)
  )
    throw new CloudError("控制台目标或会话不正确", "CONSOLE_TARGET_MISMATCH");
}

export function consoleTags(target: ConsoleTarget, sessionId: string): Record<string, string> {
  return {
    [CONSOLE_TAGS.purpose]: "vnc",
    [CONSOLE_TAGS.session]: sessionId,
    [CONSOLE_TAGS.account]: target.accountId,
  };
}

function context(signal: AbortSignal): ExecutionContext {
  return {
    jobId: "console",
    signal,
    checkpoints: {},
    progress: async () => {},
    checkpoint: async () => {},
  };
}

export function ownsConsole(
  connection: CloudDocument,
  target: ConsoleTarget,
  sessionId: string,
): boolean {
  const expected = consoleTags(target, sessionId);
  return (
    connection.instanceId === target.instanceId &&
    Object.entries(expected).every(([key, value]) => connection.freeformTags?.[key] === value)
  );
}

export function requireOwnedConsole(
  connection: CloudDocument,
  target: ConsoleTarget,
  sessionId: string,
): void {
  ocid(connection.id, "instanceconsoleconnection");
  if (!ownsConsole(connection, target, sessionId))
    throw new CloudError("控制台连接不属于此应用会话，已拒绝操作", "CONSOLE_OWNERSHIP_MISMATCH");
}

export async function consoleCompartments(
  clients: OciClients,
  target: ConsoleTarget,
  signal: AbortSignal,
) {
  return compartments(clients, target.credentials, context(signal));
}

export async function verifyConsoleTarget(
  clients: OciClients,
  target: ConsoleTarget,
  signal: AbortSignal,
): Promise<string> {
  const result = await invoke(
    clients.compute,
    "getInstance",
    { instanceId: target.instanceId },
    context(signal),
  );
  cancelled(signal);
  const instance = result.instance;
  if (!instance || instance.id !== target.instanceId)
    throw new CloudError("OCI 返回的实例与控制台目标不一致", "CONSOLE_TARGET_MISMATCH");
  const available = await consoleCompartments(clients, target, signal);
  requireCompartment(instance.compartmentId, available);
  if (["TERMINATED", "TERMINATING"].includes(instance.lifecycleState))
    throw new CloudError("实例已终止，不能创建控制台连接", "INSTANCE_TERMINATED");
  return instance.compartmentId;
}

export async function listConsoles(
  clients: OciClients,
  target: ConsoleTarget,
  compartmentId: string,
  signal: AbortSignal,
): Promise<CloudDocument[]> {
  const records = await allPages(
    clients.compute,
    "listInstanceConsoleConnections",
    { compartmentId, instanceId: target.instanceId },
    context(signal),
  );
  cancelled(signal);
  // Do not trust a provider ignoring a list filter, even when only observing contention.
  return records.filter((connection) => connection.instanceId === target.instanceId);
}

export async function getConsole(
  clients: OciClients,
  id: string,
  signal: AbortSignal,
): Promise<CloudDocument | null> {
  cancelled(signal);
  try {
    const response = await clients.compute.call("getInstanceConsoleConnection", {
      instanceConsoleConnectionId: ocid(id, "instanceconsoleconnection"),
    });
    cancelled(signal);
    const connection = response.instanceConsoleConnection;
    if (!connection || connection.id !== id)
      throw new CloudError("OCI 控制台响应格式不正确", "INVALID_CONSOLE_RESPONSE");
    return { ...connection, _consoleEtag: response.etag };
  } catch (error) {
    if (errorStatus(error) === 404) return null;
    // SDK responses may include private request material; sanitize at the public boundary.
    throw error;
  }
}

export async function consoleDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  cancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      reject(new CloudError("控制台操作已取消", "CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
  });
}
