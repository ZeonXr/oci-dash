import type { AccountSummary, JobSummary } from "@/lib/contracts";
import {
  createAccount,
  getAccount,
  updateAccount,
  type AccountInput,
  type AccountPatchInput,
} from "./accounts";
import { audit, getDatabase } from "./db";
import { AppError } from "./errors";
import { getJobStore } from "./jobs";

export interface AccountConnectionResult {
  account: AccountSummary;
  job?: JobSummary;
  consoleCleanupRecovery?: boolean;
}

const regionSet = (account: AccountSummary) =>
  JSON.stringify([...new Set([account.homeRegion, ...account.regions])].sort());

export function createAccountConnection(
  input: AccountInput,
  actor: string,
): AccountConnectionResult {
  // Initialize the queue schema before starting a transaction that could roll back.
  const store = getJobStore();
  return getDatabase()
    .transaction(() => {
      const account = createAccount(input, actor);
      const job = store.enqueueAccountSync(account.id, actor);
      audit(actor, "account.connect", account.name, "自动连接与资源同步已排队");
      return { account, job };
    })
    .immediate();
}

export function updateAccountConnection(
  id: string,
  input: AccountPatchInput,
  actor: string,
): AccountConnectionResult {
  const store = getJobStore();
  return getDatabase()
    .transaction(() => {
      const previous = getAccount(id);
      if (!previous) throw new AppError("账号不存在", 404, "ACCOUNT_NOT_FOUND");
      const account = updateAccount(id, input, actor);
      // Leave the account free for cleanup retries. Users can sync after the
      // console's verified deletion has released its slot.
      if (input.recoverConsoleCleanup) return { account, consoleCleanupRecovery: true };
      const reconnect =
        Boolean(input.privateKey) ||
        account.homeRegion !== previous.homeRegion ||
        regionSet(account) !== regionSet(previous);
      if (!reconnect) return { account };
      const job = store.enqueueAccountSync(account.id, actor);
      audit(actor, "account.connect", account.name, "配置已更新，自动连接与资源同步已排队");
      return { account, job };
    })
    .immediate();
}
