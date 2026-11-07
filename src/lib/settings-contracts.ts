export interface SettingsResult {
  username: string;
  mfaEnabled: boolean;
  demo: boolean;
  version: string;
  worker: { alive: boolean; lastSeenAt: string | null; runningJobs: number };
}
