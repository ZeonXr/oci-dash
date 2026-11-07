import { z } from "zod";
import type { DashboardData, OperationRequest } from "@/lib/contracts";
import {
  login,
  logout,
  requireUser,
  assertSameOrigin,
  sessionCookie,
  currentSessionHash,
  changePassword,
  beginMfa,
  confirmMfa,
  disableMfa,
} from "./auth";
import { getDatabase, isDemo, audit } from "./db";
import { AppError, safeMessage } from "./errors";
import { json, readJson, errorResponse } from "./http";
import { accountSchema, accountPatchSchema, regionSchema, validateOperation } from "./validation";
import {
  deleteAccount,
  getAccount,
  getCredentials,
  getCredentialSnapshot,
  listAccounts,
  setAccountStatus,
} from "./accounts";
import { createAccountConnection, updateAccountConnection } from "./account-connection";
import { getInstance, listInstances, recentActivity } from "./inventory";
import { requestInventoryRefresh } from "./inventory-refresh";
import {
  demoAccounts,
  demoActivity,
  demoEvents,
  demoInstances,
  demoJobs,
  demoMetrics,
  demoSecurity,
} from "./demo";
import {
  enqueueOperation,
  getJob,
  getJobEvents,
  listJobs,
  cancelJob,
  retryJob,
  getWorkerStatus,
  listAccountSyncJobs,
} from "./jobs";
import { ociAdapter } from "./oci/adapter";

const liveOnly = () => {
  if (isDemo())
    throw new AppError("演示模式只用于浏览，不执行云操作或修改配置", 403, "DEMO_READ_ONLY");
};
const metricsCache = new Map<
  string,
  { expires: number; value: Awaited<ReturnType<typeof ociAdapter.metrics>> }
>();

export async function handleApi(request: Request, segments: string[]): Promise<Response> {
  try {
    const path = segments.join("/"),
      method = request.method,
      url = new URL(request.url);
    if (method === "GET" && path === "health") {
      getDatabase().prepare("SELECT 1").get();
      return json({ ok: true, version: process.env.APP_VERSION ?? "0.1.0" });
    }
    if (!["GET", "HEAD"].includes(method)) assertSameOrigin(request);
    if (method === "POST" && path === "auth/login") {
      const input = z
        .object({
          username: z.string().min(1).max(80),
          password: z.string().min(1).max(256),
          code: z.string().max(80).optional(),
        })
        .parse(await readJson(request));
      const result = login(input.username, input.password, input.code);
      return json({ user: result.user, demo: isDemo() }, 200, {
        "Set-Cookie": sessionCookie(result.token),
      });
    }
    if (method === "POST" && path === "auth/logout") {
      logout(request);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", true) });
    }
    const user = requireUser(request),
      demo = isDemo();
    if (method === "GET" && path === "auth/me") return json({ user, demo });
    if (method === "POST" && path === "inventory/refresh") {
      liveOnly();
      const result = requestInventoryRefresh(await readJson(request), user.username);
      const active = result.jobs.some((job) =>
        ["queued", "running", "retrying", "interrupted"].includes(job.state),
      );
      return json(result, active ? 202 : 200);
    }
    if (method === "GET" && path === "dashboard") {
      const accounts = demo ? demoAccounts() : listAccounts(),
        instances = demo ? demoInstances() : listInstances();
      const data: DashboardData = {
        accounts,
        instances,
        jobs: demo ? demoJobs() : listJobs(100),
        activity: demo ? demoActivity() : recentActivity(),
        demo,
        totals: {
          accounts: accounts.length,
          instances: instances.length,
          running: instances.filter((i) => i.state === "RUNNING").length,
          stopped: instances.filter((i) => i.state === "STOPPED").length,
          storageGb: instances.reduce(
            (sum, i) => sum + i.bootVolumes.reduce((n, v) => n + v.sizeGb, 0),
            0,
          ),
          regions: new Set(instances.map((i) => i.region)).size,
        },
      };
      return json(data);
    }
    if (path === "accounts") {
      if (method === "GET")
        return json({
          accounts: demo ? demoAccounts() : listAccounts(),
          syncJobs: demo
            ? demoJobs().filter((job) => job.kind === "sync-account")
            : listAccountSyncJobs(),
          demo,
        });
      if (method === "POST") {
        liveOnly();
        return json(
          createAccountConnection(accountSchema.parse(await readJson(request)), user.username),
          201,
        );
      }
    }
    if (segments[0] === "accounts" && segments[1]) {
      const id = segments[1];
      if (segments.length === 2 && method === "PATCH") {
        liveOnly();
        return json(
          updateAccountConnection(
            id,
            accountPatchSchema.parse(await readJson(request)),
            user.username,
          ),
        );
      }
      if (segments.length === 2 && method === "DELETE") {
        liveOnly();
        deleteAccount(id, user.username);
        return json({ ok: true });
      }
      if (segments.length === 3 && method === "POST" && segments[2] === "verify") {
        liveOnly();
        const account = getAccount(id);
        if (!account) throw new AppError("账号不存在", 404);
        const access = getCredentialSnapshot(id);
        try {
          const info = await ociAdapter.verify(access.credentials);
          // Verification reports subscribed regions without changing the user's selected scope.
          if (!setAccountStatus(id, "connected", null, access.revision))
            throw new AppError("账号配置在验证期间已变更，请重新验证", 409, "ACCOUNT_CHANGED");
          audit(user.username, "account.verify", account.name, "连接验证成功");
          return json({ account: getAccount(id), ...info });
        } catch (error) {
          setAccountStatus(id, "error", safeMessage(error), access.revision);
          throw error;
        }
      }
      if (segments.length === 3 && method === "POST" && segments[2] === "sync") {
        liveOnly();
        const account = getAccount(id);
        if (!account) throw new AppError("账号不存在", 404);
        const refreshed = requestInventoryRefresh(
          { mode: "manual", accountIds: [id] },
          user.username,
        );
        const job = refreshed.jobs[0];
        if (refreshed.accounts[0]?.status === "queued")
          audit(user.username, "inventory.sync", account.name, "连接检查与资源刷新已排队");
        return json({ job }, 202);
      }
      if (segments.length === 3 && method === "GET" && segments[2] === "create-options") {
        liveOnly();
        const region = regionSchema.parse(url.searchParams.get("region"));
        const compartmentId = url.searchParams.get("compartmentId") ?? undefined;
        if (compartmentId && !/^ocid1\.(tenancy|compartment)\.[A-Za-z0-9._-]+$/.test(compartmentId))
          throw new AppError("区间 OCID 不正确");
        return json(await ociAdapter.createOptions(getCredentials(id, region), compartmentId));
      }
    }
    if (method === "GET" && path === "instances")
      return json({ instances: demo ? demoInstances() : listInstances(), demo });
    if (segments[0] === "instances" && segments[1] && method === "GET") {
      const instance = demo
        ? demoInstances().find((i) => i.id === segments[1])
        : getInstance(segments[1]);
      if (!instance) throw new AppError("实例不存在", 404);
      if (segments.length === 2) return json({ instance, demo });
      if (segments.length === 3 && segments[2] === "security")
        return json({
          groups: demo
            ? demoSecurity()
            : await ociAdapter.securityGroups(
                getCredentials(instance.accountId, instance.region),
                instance,
              ),
          demo,
        });
      if (segments.length === 3 && segments[2] === "metrics") {
        const range = z.enum(["1h", "24h", "7d"]).parse(url.searchParams.get("range") ?? "1h");
        if (demo) return json(demoMetrics(range));
        const key = `${instance.accountId}/${instance.id}/${range}`,
          cached = metricsCache.get(key);
        if (cached && cached.expires > Date.now()) return json(cached.value);
        const value = await ociAdapter.metrics(
          getCredentials(instance.accountId, instance.region),
          instance,
          range,
        );
        if (metricsCache.size >= 100) metricsCache.delete(metricsCache.keys().next().value!);
        metricsCache.set(key, { expires: Date.now() + 60000, value });
        return json(value);
      }
    }
    if (method === "POST" && path === "operations") {
      liveOnly();
      const operation = validateOperation(await readJson(request));
      const account = getAccount(operation.accountId);
      if (!account) throw new AppError("账号不存在", 404);
      getCredentials(account.id, operation.region);
      if (operation.resourceId) {
        const instance = getInstance(operation.resourceId);
        if (instance.accountId !== operation.accountId || instance.region !== operation.region)
          throw new AppError("资源与账号或区域不匹配", 409, "RESOURCE_MISMATCH");
        if (
          operation.kind === "instance-terminate" &&
          operation.confirmation !== instance.displayName
        )
          throw new AppError("请输入完整实例名称确认终止", 400, "CONFIRMATION_REQUIRED");
      }
      const job = enqueueOperation(operation, user.username);
      audit(user.username, operation.kind, operation.resourceId ?? account.name, "操作已排队");
      return json({ job }, 202);
    }
    if (method === "GET" && path === "jobs")
      return json({ jobs: demo ? demoJobs() : listJobs(), demo });
    if (segments[0] === "jobs" && segments[1]) {
      const id = segments[1],
        job = demo ? demoJobs().find((j) => j.id === id) : getJob(id);
      if (!job) throw new AppError("任务不存在", 404);
      if (segments.length === 2 && method === "GET")
        return json({ job, events: demo ? demoEvents(id) : getJobEvents(id), demo });
      if (
        segments.length === 3 &&
        method === "POST" &&
        ["cancel", "retry"].includes(segments[2]!)
      ) {
        liveOnly();
        const result = segments[2] === "cancel" ? cancelJob(id) : retryJob(id);
        audit(user.username, `job.${segments[2]}`, id, "请求已提交");
        return json({ job: result });
      }
    }
    if (method === "GET" && path === "settings") {
      const worker = getWorkerStatus();
      return json({
        username: user.username,
        mfaEnabled: user.mfaEnabled,
        demo,
        version: process.env.APP_VERSION ?? "0.1.0",
        worker: {
          alive: worker.online,
          lastSeenAt: worker.lastHeartbeatAt,
          runningJobs: worker.activeJobs,
        },
      });
    }
    if (segments[0] === "settings" && method === "POST") {
      liveOnly();
      const value = await readJson(request);
      if (path === "settings/password") {
        const input = z
          .object({
            currentPassword: z.string().max(256),
            newPassword: z.string().min(12).max(256),
          })
          .parse(value);
        changePassword(user, input.currentPassword, input.newPassword);
        return json({ ok: true, relogin: true }, 200, { "Set-Cookie": sessionCookie("", true) });
      }
      if (path === "settings/mfa/setup") {
        const input = z.object({ password: z.string().max(256) }).parse(value);
        return json(await beginMfa(user, input.password));
      }
      if (path === "settings/mfa/confirm") {
        const input = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(value);
        return json({ recoveryCodes: confirmMfa(user, input.code, currentSessionHash(request)) });
      }
      if (path === "settings/mfa/disable") {
        const input = z
          .object({ password: z.string().max(256), code: z.string().min(6).max(80) })
          .parse(value);
        disableMfa(user, input.password, input.code, currentSessionHash(request));
        return json({ ok: true });
      }
    }
    throw new AppError("接口不存在或不支持该方法", 404, "NOT_FOUND");
  } catch (error) {
    return errorResponse(error);
  }
}
