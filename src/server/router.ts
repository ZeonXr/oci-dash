import { z } from "zod";
import type { DashboardData, OperationRequest } from "@/lib/contracts";
import { isJobPending } from "@/lib/job-state";
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
import { getDatabase, audit } from "./db";
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
import { analyticsService } from "./analytics/service";
import { cpuService } from "./analytics/cpu";

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
      return json({ user: result.user }, 200, {
        "Set-Cookie": sessionCookie(result.token),
      });
    }
    if (method === "POST" && path === "auth/logout") {
      logout(request);
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", true) });
    }
    const user = requireUser(request);
    if (method === "GET" && path === "auth/me") return json({ user });
    if (
      ["GET", "POST"].includes(method) &&
      ["analytics/traffic", "analytics/costs", "analytics/cpu"].includes(path)
    ) {
      const input: Record<string, string> = Object.create(null);
      for (const [key, value] of url.searchParams) {
        if (Object.hasOwn(input, key))
          throw new AppError("查询参数不能重复", 400, "INVALID_ANALYTICS_QUERY");
        input[key] = value;
      }
      const report =
        path === "analytics/traffic"
          ? await analyticsService.traffic(input, method === "POST", request.signal)
          : path === "analytics/cpu"
            ? await cpuService.query(input, method === "POST")
            : await analyticsService.costs(input, method === "POST", request.signal);
      return json(report);
    }
    if (method === "POST" && path === "inventory/refresh") {
      const result = requestInventoryRefresh(await readJson(request), user.username);
      const active = result.jobs.some(isJobPending);
      return json(result, active ? 202 : 200);
    }
    if (method === "GET" && path === "dashboard") {
      const accounts = listAccounts(),
        instances = listInstances();
      const data: DashboardData = {
        accounts,
        instances,
        jobs: listJobs(100),
        activity: recentActivity(),
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
          accounts: listAccounts(),
          syncJobs: listAccountSyncJobs(),
        });
      if (method === "POST") {
        return json(
          createAccountConnection(accountSchema.parse(await readJson(request)), user.username),
          201,
        );
      }
    }
    if (segments[0] === "accounts" && segments[1]) {
      const id = segments[1];
      if (segments.length === 2 && method === "PATCH") {
        return json(
          updateAccountConnection(
            id,
            accountPatchSchema.parse(await readJson(request)),
            user.username,
          ),
        );
      }
      if (segments.length === 2 && method === "DELETE") {
        deleteAccount(id, user.username);
        return json({ ok: true });
      }
      if (segments.length === 3 && method === "POST" && segments[2] === "verify") {
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
        const region = regionSchema.parse(url.searchParams.get("region"));
        const compartmentId = url.searchParams.get("compartmentId") ?? undefined;
        if (compartmentId && !/^ocid1\.(tenancy|compartment)\.[A-Za-z0-9._-]+$/.test(compartmentId))
          throw new AppError("区间 OCID 不正确");
        return json(await ociAdapter.createOptions(getCredentials(id, region), compartmentId));
      }
    }
    if (method === "GET" && path === "instances") return json({ instances: listInstances() });
    if (segments[0] === "instances" && segments[1] && method === "GET") {
      const instance = getInstance(segments[1]);
      if (!instance) throw new AppError("实例不存在", 404);
      if (segments.length === 2) return json({ instance });
      if (segments.length === 3 && segments[2] === "security")
        return json({
          groups: await ociAdapter.securityGroups(
            getCredentials(instance.accountId, instance.region),
            instance,
          ),
        });
      if (segments.length === 3 && segments[2] === "metrics") {
        const range = z.enum(["1h", "24h", "7d"]).parse(url.searchParams.get("range") ?? "1h");
        // Validate the current account's enabled region before consulting a prior snapshot.
        const snapshot = getCredentialSnapshot(instance.accountId, instance.region);
        const scopeOf = (value: typeof instance) =>
          JSON.stringify([
            value.accountId,
            value.id,
            value.region,
            value.compartmentId,
            value.vnics.map((vnic) => vnic.id).sort(),
          ]);
        const scope = scopeOf(instance);
        const key = JSON.stringify([
          scope,
          snapshot.revision,
          snapshot.credentials.tenancyId,
          snapshot.credentials.userId,
          range,
        ]);
        const cached = metricsCache.get(key);
        if (cached && cached.expires > Date.now()) return json(cached.value);
        const value = await ociAdapter.metrics(snapshot.credentials, instance, range);
        const current = getCredentialSnapshot(instance.accountId, instance.region);
        if (current.revision !== snapshot.revision)
          throw new AppError("账号配置已变更，请重新读取监控", 409, "ACCOUNT_CHANGED");
        if (scopeOf(getInstance(instance.id)) !== scope)
          throw new AppError("实例监控范围已变更，请重新读取", 409, "RESOURCE_CHANGED");
        if (metricsCache.size >= 100) metricsCache.delete(metricsCache.keys().next().value!);
        metricsCache.set(key, { expires: Date.now() + 60000, value });
        return json(value);
      }
    }
    if (method === "POST" && path === "operations") {
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
    if (method === "GET" && path === "jobs") return json({ jobs: listJobs() });
    if (segments[0] === "jobs" && segments[1]) {
      const id = segments[1],
        job = getJob(id);
      if (!job) throw new AppError("任务不存在", 404);
      if (segments.length === 2 && method === "GET") return json({ job, events: getJobEvents(id) });
      if (
        segments.length === 3 &&
        method === "POST" &&
        ["cancel", "retry"].includes(segments[2]!)
      ) {
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
        version: process.env.APP_VERSION ?? "0.1.0",
        worker: {
          alive: worker.online,
          lastSeenAt: worker.lastHeartbeatAt,
          runningJobs: worker.activeJobs,
        },
      });
    }
    if (segments[0] === "settings" && method === "POST") {
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
