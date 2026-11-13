export type ConsoleSessionState =
  "preparing" | "ready" | "connected" | "closing" | "closed" | "failed";

/** Browser-safe view. SSH keys, OCI connection strings and login tokens stay server-side. */
export interface ConsoleSessionSummary {
  id: string;
  instanceId: string;
  instanceName: string;
  accountId: string;
  state: ConsoleSessionState;
  createdAt: string;
  expiresAt: string;
  lastError: string | null;
  cleanupPending: boolean;
}

export interface ConsoleSocketTicket {
  ticket: string;
  expiresAt: string;
  path: string;
}

/** Existing OCI connection metadata; never includes keys or connection commands. */
export interface ConsoleConnectionSummary {
  id: string;
  state: string;
}
