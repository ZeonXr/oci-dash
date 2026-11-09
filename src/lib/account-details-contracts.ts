import type { AccountSummary } from "./contracts";

export interface AccountCloudInfo {
  tenancy: {
    id: string;
    name: string;
    description: string | null;
    homeRegionKey: string | null;
  } | null;
  user: {
    id: string;
    name: string;
    description: string | null;
    email: string | null;
    state: string | null;
    createdAt: string | null;
    mfaActivated: boolean | null;
  } | null;
  regions: { name: string; key: string | null; status: string; home: boolean }[] | null;
  errors: { section: "tenancy" | "user" | "regions"; message: string }[];
  checkedAt: string;
}

export interface AccountDetails {
  account: AccountSummary;
  /** Observed resources in the current configured region scope, not a tenancy-wide quota. */
  inventory: {
    instances: number;
    running: number;
    stopped: number;
    ocpus: number | null;
    memoryGb: number | null;
    bootVolumeGb: number | null;
    publicIps: number;
    lastSyncedAt: string | null;
    partial: boolean;
  };
  cloud: AccountCloudInfo;
}
