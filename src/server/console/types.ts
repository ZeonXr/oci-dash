import type { Duplex } from "node:stream";
import type { ConsoleConnectionSummary } from "../../lib/console-contracts";
import type { OciCredentials } from "../oci/types";

export interface ConsoleActor {
  userId: string;
  username: string;
  sessionHash: string;
}

/** Server-only target, resolved from the stored instance and account. */
export interface ConsoleTarget {
  instanceId: string;
  instanceName: string;
  accountId: string;
  region: string;
  credentials: OciCredentials;
}

export interface ConsoleTunnel {
  connectionId: string;
  connect(): Promise<Duplex>;
  close(): Promise<void>;
  /** Resolves when the tunnel exits, whether deliberately or unexpectedly. */
  closed: Promise<void>;
}

/** A sent request stays uncertain until its result is observed or explicitly rejected. */
export type ConsoleCreationState = "not_attempted" | "uncertain" | "created" | "rejected";

export interface ConsoleTransport {
  connections(input: {
    target: ConsoleTarget;
    signal: AbortSignal;
  }): Promise<ConsoleConnectionSummary[]>;
  start(input: {
    target: ConsoleTarget;
    sessionId: string;
    /** The exact existing connection the user explicitly confirmed replacing. */
    replaceConnectionId?: string;
    signal: AbortSignal;
    onCompartmentVerified?(compartmentId: string): void;
    onCreationState?(state: ConsoleCreationState): void;
    onConnectionCreated(connectionId: string): void;
  }): Promise<ConsoleTunnel>;
  /** Deletes only the OCI connection tagged for this recorded application session. */
  cleanup(input: {
    target: ConsoleTarget;
    sessionId: string;
    connectionId: string | null;
    compartmentId?: string | null;
    onCompartmentVerified?(compartmentId: string): void;
    creationState?: ConsoleCreationState;
    /** Called only after finding and deleting every connection for an uncertain create. */
    onCreationResolved?(): void;
    signal: AbortSignal;
  }): Promise<void>;
}
