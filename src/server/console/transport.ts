import { requireCompartment } from "../oci/helpers";
import {
  closeClients,
  cloudError,
  errorStatus,
  invoke,
  sdkClientFactory,
  type CloudDocument,
  type OciClientFactory,
  type OciClients,
} from "../oci/sdk";
import { CloudError } from "../oci/types";
import {
  cancelled,
  consoleCompartments,
  consoleDelay,
  consoleTags,
  getConsole,
  listConsoles,
  ownsConsole,
  requireOwnedConsole,
  validateConsoleIdentity,
  verifyConsoleTarget,
} from "./oci";
import {
  createOpenSshFactory,
  parseVncConnectionString,
  type ConsoleSshFactory,
  type ConsoleSshSession,
} from "./ssh";
import type { ConsoleCreationState, ConsoleTarget, ConsoleTransport, ConsoleTunnel } from "./types";

export interface ConsoleTransportOptions {
  clientFactory?: OciClientFactory;
  ssh?: ConsoleSshFactory;
  pollIntervalMs?: number;
  maxPolls?: number;
}

/**
 * Each operation owns its SDK clients. Session metadata is persisted before polling or
 * opening SSH; remote cleanup always proves account + instance + session ownership.
 */
export function createConsoleTransport(options: ConsoleTransportOptions = {}): ConsoleTransport {
  const clientFactory = options.clientFactory ?? sdkClientFactory;
  const sshFactory = options.ssh ?? createOpenSshFactory();
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxPolls = options.maxPolls ?? 40;
  if (
    !Number.isFinite(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    !Number.isInteger(maxPolls) ||
    maxPolls < 1
  )
    throw new Error("Invalid console transport polling options");

  async function waitActive(
    clients: OciClients,
    id: string,
    target: ConsoleTarget,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<CloudDocument> {
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const connection = await getConsole(clients, id, signal);
      if (!connection) throw new CloudError("OCI 控制台连接不存在", "CONSOLE_CONNECTION_MISSING");
      requireOwnedConsole(connection, target, sessionId);
      if (connection.lifecycleState === "ACTIVE") return connection;
      if (connection.lifecycleState !== "CREATING")
        throw new CloudError("OCI 控制台连接未能进入可用状态", "CONSOLE_CONNECTION_FAILED");
      if (attempt + 1 < maxPolls) await consoleDelay(pollIntervalMs, signal);
    }
    throw new CloudError("等待 OCI 控制台连接超时", "CONSOLE_CONNECTION_TIMEOUT");
  }

  async function removeOwned(
    clients: OciClients,
    connection: CloudDocument,
    target: ConsoleTarget,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<void> {
    requireOwnedConsole(connection, target, sessionId);
    if (connection.lifecycleState === "DELETED") return;
    if (connection.lifecycleState !== "DELETING") {
      cancelled(signal);
      // GetInstanceConsoleConnection does not promise an ETag. Preserve it when
      // available, but the freshly verified immutable ID and ownership tags authorize deletion.
      await invoke(clients.compute, "deleteInstanceConsoleConnection", {
        instanceConsoleConnectionId: connection.id,
        ...(typeof connection._consoleEtag === "string" && connection._consoleEtag
          ? { ifMatch: connection._consoleEtag }
          : {}),
      });
    }
    for (let attempt = 0; attempt < maxPolls; attempt++) {
      const current = await getConsole(clients, connection.id, signal);
      if (!current) return;
      requireOwnedConsole(current, target, sessionId);
      if (current.lifecycleState === "DELETED") return;
      if (attempt + 1 < maxPolls) await consoleDelay(pollIntervalMs, signal);
    }
    throw new CloudError("OCI 控制台仍在清理，稍后将继续重试", "CONSOLE_CLEANUP_PENDING", true);
  }

  async function cleanup({
    target,
    sessionId,
    connectionId,
    creationState,
    onCreationResolved,
    signal,
  }: Parameters<ConsoleTransport["cleanup"]>[0]) {
    validateConsoleIdentity(target, sessionId);
    cancelled(signal);
    // Persisted preflight failures and an explicit rejected create cannot own a cloud connection.
    // In particular, do not turn a definitive 401/403 into a permanently blocked cleanup scan.
    if (!connectionId && (creationState === "not_attempted" || creationState === "rejected"))
      return;
    let clients: OciClients | undefined;
    try {
      clients = await clientFactory(target.credentials, target.region);
      if (connectionId) {
        // The exact ID was persisted from this create. Re-fetch and verify session,
        // account and instance immediately before delete; no tenancy-wide scan is needed.
        const connection = await getConsole(clients, connectionId, signal);
        if (connection) await removeOwned(clients, connection, target, sessionId, signal);
        if (creationState === "uncertain") onCreationResolved?.();
        return;
      }
      const available = await consoleCompartments(clients, target, signal);
      const matches = new Map<string, CloudDocument>();
      // Reconcile a lost create response or restart before the ID was persisted.
      // Tags are scoped to this application account and exact recorded session.
      for (const compartment of available) {
        const listed = await listConsoles(clients, target, compartment.id, signal);
        for (const connection of listed) {
          if (!ownsConsole(connection, target, sessionId)) continue;
          requireCompartment(connection.compartmentId, available);
          requireOwnedConsole(connection, target, sessionId);
          matches.set(connection.id, connection);
        }
      }
      for (const connection of matches.values()) {
        // Refresh immediately before deletion: a stale list item is not deletion authority.
        const current = await getConsole(clients, connection.id, signal);
        if (!current) continue;
        requireCompartment(current.compartmentId, available);
        await removeOwned(clients, current, target, sessionId, signal);
      }
      if (creationState === "uncertain") {
        // Empty eventually-consistent lists do not prove that a timed-out create was rejected.
        // Keep its durable slot until a connection is observed and all owned matches are removed.
        if (!matches.size)
          throw new CloudError(
            "OCI 创建结果仍不明确，将继续核对控制台连接",
            "CONSOLE_CREATE_UNCERTAIN",
            true,
          );
        onCreationResolved?.();
      }
    } catch (error) {
      throw cloudError(error, "OCI 控制台清理失败");
    } finally {
      if (clients) await closeClients(clients);
    }
  }

  async function start({
    target,
    sessionId,
    signal,
    onCreationState,
    onConnectionCreated,
  }: Parameters<ConsoleTransport["start"]>[0]): Promise<ConsoleTunnel> {
    validateConsoleIdentity(target, sessionId);
    cancelled(signal);
    let clients: OciClients | undefined;
    let ssh: ConsoleSshSession | undefined;
    let connectionId: string | null = null;
    let creationAttempted = false;
    let creationState: ConsoleCreationState = "not_attempted";
    try {
      clients = await clientFactory(target.credentials, target.region);
      const compartmentId = await verifyConsoleTarget(clients, target, signal);
      const existing = await listConsoles(clients, target, compartmentId, signal);
      if (existing.some((connection) => connection.lifecycleState !== "DELETED")) {
        // Even a same-session record must be cleaned first: it was created with a different key.
        throw new CloudError("实例已有控制台连接，请先结束原连接", "CONSOLE_CONNECTION_EXISTS");
      }
      ssh = await sshFactory({ sessionId, signal });
      cancelled(signal);
      // Persist the ambiguity BEFORE dispatch. A process crash at any subsequent point
      // must leave enough metadata for cleanup to retain the slot and reconcile by tags.
      onCreationState?.("uncertain");
      creationState = "uncertain";
      creationAttempted = true;
      const createRequest = {
        createInstanceConsoleConnectionDetails: {
          instanceId: target.instanceId,
          publicKey: ssh.publicKey,
          freeformTags: consoleTags(target, sessionId),
        },
        opcRetryToken: sessionId,
      };
      let created: CloudDocument | undefined;
      for (let createAttempt = 0; createAttempt < 2; createAttempt++) {
        cancelled(signal);
        try {
          // Keep the original status for rejection classification; normalize errors only
          // at this transport's public boundary. Client RPC timeouts remain in force.
          const response = await clients.compute.call(
            "createInstanceConsoleConnection",
            createRequest,
          );
          created = response.instanceConsoleConnection;
          break;
        } catch (createError) {
          const status = errorStatus(createError);
          const rejected =
            status !== undefined &&
            [400, 401, 403, 404, 405, 409, 410, 411, 412, 413, 414, 415, 422, 429].includes(status);
          if (createAttempt === 0 && rejected) {
            // A later rejection cannot disprove an earlier ambiguous attempt.
            onCreationState?.("rejected");
            creationState = "rejected";
            creationAttempted = false;
            throw createError;
          }
          // A timeout can hide a successful create. Reconcile by tags; never blindly create again.
          // A fresh bounded signal allows recording a late result even after request cancellation.
          const reconcileSignal = AbortSignal.timeout(15_000);
          let recovered: CloudDocument | undefined;
          for (let attempt = 0; attempt < Math.min(3, maxPolls); attempt++) {
            const matching = (
              await listConsoles(clients, target, compartmentId, reconcileSignal)
            ).filter(
              (connection) =>
                ownsConsole(connection, target, sessionId) &&
                connection.lifecycleState !== "DELETED",
            );
            if (matching.length === 1) {
              recovered = matching[0];
              break;
            }
            if (matching.length > 1)
              throw new CloudError(
                "检测到重复控制台连接，已停止并进入清理",
                "CONSOLE_AMBIGUOUS_CREATE",
              );
            if (attempt + 1 < Math.min(3, maxPolls))
              await consoleDelay(pollIntervalMs, reconcileSignal);
          }
          if (recovered) {
            created = recovered;
            break;
          }
          if (createAttempt === 0 && !rejected && !signal.aborted) {
            // Replay at most once, with the exact same public key, tags and idempotency
            // token. Never issue a new token or recreate during post-restart cleanup.
            await consoleDelay(pollIntervalMs, signal);
            continue;
          }
          throw createError;
        }
      }
      // Persist before any cancellation check/network call. Persistence failures must
      // propagate into cleanup, rather than being mistaken for lost create responses.
      if (typeof created?.id === "string") {
        connectionId = created.id;
        onConnectionCreated(connectionId);
        onCreationState?.("created");
        creationState = "created";
      }
      if (!created?.id)
        throw new CloudError("OCI 创建控制台未返回连接 ID", "INVALID_CONSOLE_RESPONSE");
      cancelled(signal);
      requireOwnedConsole(created, target, sessionId);
      if (created.compartmentId !== compartmentId)
        throw new CloudError("OCI 控制台连接所属区间不一致", "CONSOLE_TARGET_MISMATCH");
      connectionId = created.id;
      const active = await waitActive(clients, created.id, target, sessionId, signal);
      if (active.compartmentId !== compartmentId)
        throw new CloudError("OCI 控制台连接所属区间不一致", "CONSOLE_TARGET_MISMATCH");
      if (typeof active.vncConnectionString !== "string")
        throw new CloudError("此实例未提供 VNC 控制台连接", "CONSOLE_VNC_UNAVAILABLE");
      const endpoint = parseVncConnectionString(active.vncConnectionString, {
        instanceId: target.instanceId,
        connectionId: active.id,
        region: target.region,
      });
      const tunnel = await ssh.open({
        endpoint,
        serviceHostKeyFingerprint: active.serviceHostKeyFingerprint,
        signal,
      });
      cancelled(signal);
      return { ...tunnel, connectionId: active.id };
    } catch (error) {
      await ssh?.close().catch(() => {});
      if (creationAttempted) {
        // Manager retains the durable slot and independently retries failed cleanup.
        // Never remove a foreign connection or convert an uncertain cleanup into success.
        await cleanup({
          target,
          sessionId,
          connectionId,
          creationState,
          onCreationResolved() {
            onCreationState?.("created");
            creationState = "created";
          },
          signal: AbortSignal.timeout(15_000),
        }).catch(() => {});
      }
      throw cloudError(error, "OCI 控制台连接失败");
    } finally {
      if (clients) await closeClients(clients);
    }
  }

  return { start, cleanup };
}

export const consoleTransport = createConsoleTransport();
