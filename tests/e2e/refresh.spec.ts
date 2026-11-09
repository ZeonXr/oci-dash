import { expect, test as base, type Page } from "@playwright/test";
import { jobPageFixture } from "../fixtures/job-page";
import type {
  AccountSummary,
  DashboardData,
  InstanceSummary,
  InventoryRefreshResult,
  JobSummary,
} from "../../src/lib/contracts";

// Every API and WebSocket is intercepted before navigation. Only the local
// application shell/assets reach the isolated server; no OCI request can escape.
const account: AccountSummary = {
  id: "refresh-fixture-account",
  name: "Refresh fixture",
  tenancyId: "ocid1.tenancy.oc1..refreshfixture",
  userId: "ocid1.user.oc1..refreshfixture",
  fingerprint: "aa:".repeat(15) + "aa",
  homeRegion: "ap-tokyo-1",
  regions: ["ap-tokyo-1"],
  status: "connected",
  lastSyncAt: "2026-01-01T00:00:00.000Z",
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
function instances(): InstanceSummary[] {
  return Array.from({ length: 22 }, (_, index) => ({
    id: "refresh-instance-" + (index + 1),
    accountId: account.id,
    accountName: account.name,
    displayName: "Fixture-" + String(index + 1).padStart(2, "0"),
    region: account.homeRegion,
    availabilityDomain: "fixture:AP-TOKYO-1-AD-1",
    compartmentId: account.tenancyId,
    state: "RUNNING",
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    createdAt: account.createdAt,
    vnics: [],
    bootVolumes: [],
    tags: {},
    syncedAt: account.lastSyncAt!,
  }));
}
function job(id = "refresh-fixture-sync"): JobSummary {
  return {
    id,
    kind: "sync-account",
    accountId: account.id,
    accountName: account.name,
    region: account.homeRegion,
    resourceId: null,
    state: "queued",
    attempt: 0,
    maxAttempts: 4,
    createdAt: account.createdAt,
    startedAt: null,
    finishedAt: null,
    nextRunAt: null,
    lastError: null,
    result: null,
  };
}
type RequestRecord = {
  method: string;
  path: string;
  body?: { mode?: "auto" | "manual"; accountIds?: string[] };
};
interface RefreshFixture {
  now: number;
  accounts: AccountSummary[];
  rows: InstanceSummary[];
  syncJob: JobSummary | null;
  syncJobs: JobSummary[];
  taskRows: JobSummary[];
  jobQueries: URLSearchParams[];
  requests: RequestRecord[];
  failedRequests: string[];
  unexpected: string[];
  jobsGate?: Promise<void>;
  accountsGate?: Promise<void>;
  refreshGate?: Promise<void>;
  instancesGate?: Promise<void>;
  jobGates: Map<string, Promise<void>>;
  failedSnapshots: number;
  activeInstanceReads: number;
  peakInstanceReads: number;
  finish(state: "succeeded" | "failed", update?: (rows: InstanceSummary[]) => void): void;
  finishAccount(
    id: string,
    state: "succeeded" | "failed",
    update?: (rows: InstanceSummary[]) => void,
  ): void;
  count(path: string, method?: string): number;
  manualRequests(): RequestRecord[];
}
const test = base.extend<{ refreshApi: RefreshFixture }>({
  refreshApi: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL || "http://localhost:3000").origin;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
      throw new Error("Refresh UI tests require an isolated localhost server.");
    const errors: string[] = [];
    const state: RefreshFixture = {
      now: Date.now(),
      accounts: [{ ...account }],
      rows: instances(),
      syncJobs: [],
      get syncJob() {
        return state.syncJobs.find((job) => job.accountId === account.id) ?? null;
      },
      set syncJob(value) {
        state.syncJobs = state.syncJobs.filter((job) => job.accountId !== account.id);
        if (value) state.syncJobs.push(value);
      },
      jobGates: new Map(),
      failedSnapshots: 0,
      activeInstanceReads: 0,
      peakInstanceReads: 0,
      taskRows: [
        {
          ...job("refresh-fixture-task"),
          kind: "instance-rename",
          resourceId: "refresh-instance-1",
          state: "succeeded",
          attempt: 1,
        },
      ],
      requests: [],
      jobQueries: [],
      failedRequests: [],
      unexpected: [],
      finish(status, update) {
        state.finishAccount(account.id, status, update);
      },
      finishAccount(id, status, update) {
        const job = state.syncJobs.find((item) => item.accountId === id);
        const selected = state.accounts.find((item) => item.id === id);
        if (!job || !selected) throw new Error("No fixture synchronization was requested.");
        update?.(state.rows);
        const timestamp = new Date(state.now + 1000).toISOString();
        Object.assign(job, {
          state: status,
          attempt: 1,
          finishedAt: timestamp,
          lastError: status === "failed" ? "模拟 OCI 读取失败" : null,
        });
        selected.status = status === "succeeded" ? "connected" : "error";
        selected.lastError = job.lastError;
        if (status === "succeeded") {
          selected.lastSyncAt = timestamp;
          state.rows
            .filter((row) => row.accountId === id)
            .forEach((row) => {
              row.syncedAt = timestamp;
            });
        }
      },
      count(path, method = "GET") {
        return state.requests.filter(
          (request) => request.path === path && request.method === method,
        ).length;
      },
      manualRequests() {
        return state.requests.filter(
          (request) => request.path === "/api/inventory/refresh" && request.body?.mode === "manual",
        );
      },
    };
    const track = (page: Page) => {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("requestfailed", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/"))
          state.failedRequests.push(new URL(request.url()).pathname);
      });
    };
    context.pages().forEach(track);
    context.on("page", track);
    await context.addInitScript(() => {
      let visibility: DocumentVisibilityState = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => visibility === "hidden",
      });
      (
        window as unknown as { setRefreshFixtureVisibility(value: DocumentVisibilityState): void }
      ).setRefreshFixtureVisibility = (value) => {
        visibility = value;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    await context.routeWebSocket(/.*/, (socket) => {
      const path = new URL(socket.url()).pathname;
      if (!path.includes("webpack-hmr")) state.unexpected.push("WS " + path);
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      const method = request.method(),
        path = url.pathname;
      if (url.origin !== origin) {
        state.unexpected.push(method + " " + url.origin + path);
        return route.abort();
      }
      if (path.startsWith("/flags/")) {
        if (method === "GET" && /^\/flags\/[a-z]{2}\.svg$/.test(path)) return route.continue();
        state.unexpected.push(method + " " + path);
        return route.abort();
      }
      if (!path.startsWith("/api/")) {
        if (method === "GET") return route.continue();
        state.unexpected.push(method + " " + path);
        return route.abort();
      }
      const entry: RequestRecord = { method, path };
      if (method === "POST") entry.body = request.postDataJSON();
      state.requests.push(entry);
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (method === "GET" && path === "/api/auth/me")
        return json({
          user: { id: "refresh-user", username: "fixture", mfaEnabled: false },
        });
      if (method === "GET" && path === "/api/accounts") {
        if (state.accountsGate) await state.accountsGate;
        return json({
          accounts: state.accounts,
          syncJobs: state.syncJobs,
        });
      }
      if (method === "GET" && path === "/api/instances") {
        const snapshot = structuredClone(state.rows);
        state.activeInstanceReads++;
        state.peakInstanceReads = Math.max(state.peakInstanceReads, state.activeInstanceReads);
        try {
          if (state.instancesGate) await state.instancesGate;
          if (state.failedSnapshots > 0) {
            state.failedSnapshots--;
            return await json({ error: "模拟快照读取失败" }, 503);
          }
          return await json({ instances: snapshot });
        } finally {
          state.activeInstanceReads--;
        }
      }
      if (method === "GET" && path === "/api/dashboard") {
        const body: DashboardData = {
          accounts: state.accounts,
          instances: state.rows,
          jobs: state.taskRows,
          activity: [],
          totals: {
            accounts: state.accounts.length,
            instances: state.rows.length,
            running: state.rows.filter((row) => row.state === "RUNNING").length,
            stopped: state.rows.filter((row) => row.state === "STOPPED").length,
            storageGb: 0,
            regions: 1,
          },
        };
        return json(body);
      }
      const detail = path.match(/^\/api\/instances\/([^/]+)(?:\/(metrics|security))?$/);
      if (method === "GET" && detail) {
        const instance = state.rows.find((row) => row.id === decodeURIComponent(detail[1]));
        if (!instance) return json({ error: "Fixture instance not found" }, 404);
        if (detail[2] === "metrics")
          return json({ points: [], intervalSeconds: 60, available: false, source: "oci" });
        if (detail[2] === "security") return json({ groups: [] });
        return json({ instance });
      }
      if (method === "POST" && path === "/api/inventory/refresh") {
        expect(["auto", "manual"]).toContain(entry.body?.mode);
        if (state.refreshGate) await state.refreshGate;
        const selected = state.accounts.filter(
          (item) => !entry.body?.accountIds || entry.body.accountIds.includes(item.id),
        );
        if (entry.body?.accountIds)
          expect(selected.map((item) => item.id).sort()).toEqual([...entry.body.accountIds].sort());
        const pending = (item: JobSummary) =>
          !["succeeded", "failed", "cancelled"].includes(item.state);
        if (entry.body?.mode === "manual") {
          const sequence = state.manualRequests().length;
          for (const item of selected) {
            if (state.syncJobs.some((current) => current.accountId === item.id && pending(current)))
              continue;
            const id =
              "refresh-fixture-sync" +
              (item.id === account.id ? "" : `-${item.id}`) +
              (sequence > 1 ? `-${sequence}` : "");
            state.syncJobs = [
              ...state.syncJobs.filter((current) => current.accountId !== item.id),
              {
                ...job(id),
                accountId: item.id,
                accountName: item.name,
                region: item.homeRegion,
              },
            ];
          }
        }
        const active = state.syncJobs.filter(
          (item) => selected.some((a) => a.id === item.accountId) && pending(item),
        );
        const body: InventoryRefreshResult = {
          jobs: active,
          accounts: selected.map((item) => {
            const job = active.find((current) => current.accountId === item.id);
            return {
              accountId: item.id,
              status: job ? (entry.body?.mode === "manual" ? "queued" : "active") : "fresh",
              jobId: job?.id ?? null,
              lastSyncedAt: item.lastSyncAt,
              nextRefreshAt: new Date(state.now + 60_000).toISOString(),
            };
          }),
        };
        return json(body, active.length ? 202 : 200);
      }
      if (method === "GET" && path === "/api/jobs") {
        state.jobQueries.push(new URLSearchParams(url.searchParams));
        if (state.jobsGate) await state.jobsGate;
        return json(jobPageFixture(state.taskRows, url.searchParams));
      }
      const sync = state.syncJobs.find((item) => path === `/api/jobs/${item.id}`);
      if (method === "GET" && sync) {
        const gate = state.jobGates.get(sync.id);
        if (gate) await gate;
        return json({
          job: state.syncJobs.find((item) => item.id === sync.id),
          events: [],
        });
      }
      const task = state.taskRows.find(
        (row) => path === `/api/jobs/${row.id}` || path === `/api/jobs/${row.id}/cancel`,
      );
      if (task && method === "GET" && path === `/api/jobs/${task.id}`)
        return json({ job: task, events: [] });
      if (task && method === "POST" && path === `/api/jobs/${task.id}/cancel`) {
        Object.assign(task, {
          state: "cancelled",
          nextRunAt: null,
          waitingForCompletion: false,
          finishedAt: new Date(state.now).toISOString(),
        });
        return json({ job: task });
      }
      state.unexpected.push(method + " " + path);
      return json({ error: "Unmocked API blocked by refresh fixture" }, 501);
    });
    await use(state);
    expect(state.unexpected, "Every API/external request must be mocked").toEqual([]);
    expect(errors, "Refresh must not raise uncaught browser errors").toEqual([]);
  },
});

function taskHistory(fixture: RefreshFixture, count: number): JobSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    ...job(`history-${String(index + 1).padStart(3, "0")}`),
    kind: "instance-rename",
    resourceId: `task-resource-${String(index + 1).padStart(3, "0")}`,
    state: index === 0 ? "running" : "succeeded",
    createdAt: new Date(fixture.now + index * 1000).toISOString(),
    finishedAt: index === 0 ? null : new Date(fixture.now + index * 1000).toISOString(),
  }));
}

test("任务分页读取完整历史，筛选与浏览器前进后退保持查询范围", async ({ page, refreshApi }) => {
  refreshApi.taskRows = taskHistory(refreshApi, 121);
  await page.goto("/tasks?page=12");
  const list = page.getByRole("region", { name: "任务列表表格", exact: true });
  await expect(list.locator("tbody tr")).toHaveCount(10);
  await expect(page.getByRole("navigation", { name: "表格分页" })).toContainText("共 121 条");
  await expect.poll(() => refreshApi.jobQueries.at(-1)?.get("page")).toBe("12");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page).toHaveURL(/page=13/);
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list).toContainText("task-resource-001");
  await page.goBack();
  await expect(page).toHaveURL(/page=12/);
  await expect(list.locator("tbody tr")).toHaveCount(10);
  await page.goForward();
  await expect(page).toHaveURL(/page=13/);
  await expect(list).toContainText("task-resource-001");
  await page.reload();
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await page.getByLabel("按状态筛选任务", { exact: true }).selectOption("running");
  await expect(page.getByRole("navigation", { name: "表格分页" })).toContainText("共 1 条");
  await expect(list).toContainText("task-resource-001");
  await expect.poll(() => refreshApi.jobQueries.at(-1)?.get("state")).toBe("running");
  await expect.poll(() => refreshApi.jobQueries.at(-1)?.get("page")).toBe("1");
  await page.getByRole("button", { name: "重置筛选", exact: true }).click();
  await page.getByRole("button", { name: "提交时间", exact: true }).click();
  await expect.poll(() => refreshApi.jobQueries.at(-1)?.get("sort")).toBe("ascending");
  await expect(list.locator("tbody tr").first()).toContainText("task-resource-001");
  await page.getByLabel("搜索任务", { exact: true }).fill("重命名实例");
  await expect.poll(() => refreshApi.jobQueries.at(-1)?.get("query")).toBe("重命名实例");
  await expect(page.getByRole("navigation", { name: "表格分页" })).toContainText("共 121 条");
});

test("实例历史按实例查询完整页，近期任务不受其他实例的新历史挤出", async ({ page, refreshApi }) => {
  refreshApi.taskRows = taskHistory(refreshApi, 131).map((task, index) => ({
    ...task,
    resourceId: index < 101 ? "refresh-instance-1" : "unrelated-instance",
  }));
  await page.goto("/instances/refresh-instance-1");
  await expect(page.locator(".recent-task-summary a")).toHaveAttribute(
    "href",
    "/tasks/history-101",
  );
  await page.getByRole("tab", { name: "任务与活动", exact: true }).click();
  const history = page.getByRole("region", { name: "实例任务表格", exact: true });
  await expect(history.locator("tbody tr")).toHaveCount(10);
  await expect(page.getByRole("navigation", { name: "表格分页" })).toContainText("共 101 条");
  await page.getByLabel("每页条数", { exact: true }).selectOption("50");
  await expect(history.locator("tbody tr")).toHaveCount(50);
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(history.locator("tbody tr")).toHaveCount(50);
  await expect(page.getByRole("navigation", { name: "表格分页" })).toContainText("2 / 3");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(history.locator("tbody tr")).toHaveCount(1);
  await expect(history.getByRole("link", { name: "查看详情", exact: true })).toHaveAttribute(
    "href",
    "/tasks/history-001",
  );
  const latest = refreshApi.jobQueries.at(-1)!;
  expect(latest.get("resourceId")).toBe("refresh-instance-1");
  expect(latest.get("accountId")).toBe(account.id);
  expect(latest.get("page")).toBe("3");
  expect(latest.get("pageSize")).toBe("50");
});

test("实例任务观察单独查询全部活动任务，发现最近100条以外的旧任务", async ({
  page,
  refreshApi,
}) => {
  refreshApi.taskRows = taskHistory(refreshApi, 121);
  refreshApi.taskRows[0].resourceId = "refresh-instance-1";
  await page.goto("/instances");
  await expect
    .poll(() => refreshApi.jobQueries.some((query) => query.get("active") === "true"))
    .toBe(true);
  await expect.poll(() => refreshApi.count("/api/jobs/history-001")).toBeGreaterThan(0);
  expect(refreshApi.manualRequests()).toEqual([]);
});
test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

const refreshButton = (page: Page) =>
  page.locator(".page-heading").getByRole("button", { name: "刷新", exact: true });
const rows = (page: Page) => page.locator(".resource-table tbody tr");
const cards = (page: Page) => page.locator("article.instance-card");
async function openInstances(page: Page) {
  await page.goto("/instances");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await expect(rows(page)).toHaveCount(10);
  await expect(refreshButton(page)).toBeEnabled();
}
async function fixtureVisibility(page: Page, value: DocumentVisibilityState) {
  await page.evaluate((next) => {
    (
      window as unknown as { setRefreshFixtureVisibility(value: DocumentVisibilityState): void }
    ).setRefreshFixtureVisibility(next);
  }, value);
}
async function pauseClock(page: Page, fixture: RefreshFixture) {
  await page.clock.install({ time: new Date(fixture.now) });
  fixture.now += 1000;
  await page.clock.pauseAt(new Date(fixture.now));
}

async function settleTaskPolling(page: Page) {
  // Terminal data updates polling state in an effect, then another effect clears
  // its interval. Let both commits pass a paint before advancing mocked time.
  await page.clock.resume();
  await page.evaluate(async () => {
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

function twoAccounts(fixture: RefreshFixture) {
  const slow: AccountSummary = {
    ...account,
    id: "refresh-slow-account",
    name: "Slow fixture",
    tenancyId: "ocid1.tenancy.oc1..slowfixture",
  };
  fixture.accounts.push(slow);
  fixture.rows = [
    fixture.rows[0],
    {
      ...fixture.rows[1],
      id: "refresh-slow-instance",
      displayName: "Slow-01",
      accountId: slow.id,
      accountName: slow.name,
    },
  ];
  return slow;
}
async function openTwoAccounts(page: Page) {
  await page.goto("/instances");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect(refreshButton(page)).toBeEnabled();
}
async function advance(page: Page, fixture: RefreshFixture, milliseconds = 1100) {
  fixture.now += milliseconds;
  await page.clock.runFor(milliseconds);
}

test("实例总览账号链接校验后限定同步，历史切换保留搜索并可重载", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  let release!: () => void;
  refreshApi.accountsGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto(`/instances?accountId=${account.id}&keep=1#scope`);
    await expect.poll(() => refreshApi.count("/api/accounts")).toBeGreaterThan(0);
    expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(0);
    refreshApi.accountsGate = undefined;
    release();
    await page.getByRole("button", { name: "表格视图", exact: true }).click();
    const selector = page.getByLabel("筛选账号", { exact: true });
    const search = page.getByLabel("搜索实例名称、地址或 OCID", { exact: true });
    await expect(selector).toHaveValue(account.id);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Fixture-01");
    await expect.poll(() => refreshApi.count("/api/inventory/refresh", "POST")).toBe(1);
    expect(
      refreshApi.requests.filter((request) => request.path === "/api/inventory/refresh")[0].body,
    ).toMatchObject({ accountIds: [account.id] });
    await search.fill("01");
    await selector.selectOption(slow.id);
    await expect(page).toHaveURL(new RegExp(`/instances\\?accountId=${slow.id}&keep=1#scope$`));
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Slow-01");
    await expect(search).toHaveValue("01");
    await page.goBack();
    await expect(selector).toHaveValue(account.id);
    await expect(rows(page)).toContainText("Fixture-01");
    await expect(search).toHaveValue("01");
    await page.goForward();
    await expect(selector).toHaveValue(slow.id);
    await expect(rows(page)).toContainText("Slow-01");
    await page.reload();
    await expect(selector).toHaveValue(slow.id);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page)).toContainText("Slow-01");
    expect(
      refreshApi.requests
        .filter((request) => request.path === "/api/inventory/refresh")
        .every((request) => request.body?.accountIds?.length === 1),
    ).toBe(true);
  } finally {
    release();
    refreshApi.accountsGate = undefined;
  }
});

test("实例失效账号链接校验后回到全部账号，不向已移除账号提交同步", async ({ page, refreshApi }) => {
  twoAccounts(refreshApi);
  await page.goto("/instances?accountId=removed-account&keep=1#scope");
  await expect(page).toHaveURL(/\/instances\?keep=1#scope$/);
  await expect(page.getByLabel("筛选账号", { exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  await expect.poll(() => refreshApi.count("/api/inventory/refresh", "POST")).toBeGreaterThan(0);
  expect(
    refreshApi.requests
      .filter((request) => request.path === "/api/inventory/refresh")
      .every((request) => request.body?.accountIds === undefined),
  ).toBe(true);
});

test("手动刷新提交 OCI 同步任务，终态后重新读取快照，等待期间保留原行", async ({
  page,
  refreshApi,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openInstances(page);
  const before = refreshApi.count("/api/instances");
  const refresh = refreshButton(page);
  const originalSize = await refresh.evaluate((button) => {
    const { width, height } = button.getBoundingClientRect();
    return { width, height };
  });
  await expect(refresh.locator("svg")).toHaveCount(1);
  await refresh.click();
  await expect.poll(() => refreshApi.manualRequests().length).toBe(1);
  await expect(refresh).toBeDisabled();
  await expect(refresh).toHaveAttribute("aria-busy", "true");
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh.locator("svg")).toHaveCSS("animation-name", "spin");
  await expect(refresh.locator("svg")).toHaveCSS("animation-duration", "1s");
  await expect(refresh.locator("svg")).toHaveCSS("animation-timing-function", "linear");
  expect(
    await refresh.evaluate((button) => {
      const { width, height } = button.getBoundingClientRect();
      return { width, height };
    }),
  ).toEqual(originalSize);
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("link", { name: "Fixture-01", exact: true })).toBeVisible();
  refreshApi.finish("succeeded", (items) => {
    items[0].displayName = "Fixture-01 updated";
  });
  await expect(page.getByRole("link", { name: "Fixture-01 updated", exact: true })).toBeVisible();
  expect(refreshApi.count("/api/jobs/refresh-fixture-sync")).toBeGreaterThan(0);
  expect(refreshApi.count("/api/instances")).toBeGreaterThan(before);
  await expect(refresh).toBeEnabled();
  await expect(refresh).not.toHaveAttribute("aria-busy", "true");
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
  expect(
    await refresh.evaluate((button) => {
      const { width, height } = button.getBoundingClientRect();
      return { width, height };
    }),
  ).toEqual(originalSize);
});

test("同步失败显示可重试错误，保留先前快照和表格", async ({ page, refreshApi }) => {
  await openInstances(page);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.manualRequests().length).toBe(1);
  refreshApi.finish("failed");
  await expect(page.getByText("Refresh fixture：模拟 OCI 读取失败", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("link", { name: "Fixture-01", exact: true })).toBeVisible();
  await expect(refreshButton(page)).toBeEnabled();
});

test("卡片切换与刷新保留筛选和当前页，详情读取新快照且离页停止库存轮询", async ({
  page,
  refreshApi,
}) => {
  await pauseClock(page, refreshApi);
  await openInstances(page);
  await page.getByLabel("搜索实例名称、地址或 OCID").fill("Fixture");
  await page.getByLabel("筛选账号", { exact: true }).selectOption(account.id);
  await page.getByLabel("筛选区域", { exact: true }).selectOption(account.homeRegion);
  await page.getByLabel("筛选状态", { exact: true }).selectOption("RUNNING");
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  const pagination = page.getByRole("navigation", { name: "表格分页" });
  await expect(pagination).toContainText("2 / 3");
  await expect(refreshButton(page)).toBeEnabled();
  const namesBefore = (await rows(page).locator(".name-link").allTextContents()).map((name) =>
    name.trim(),
  );
  const syncsBefore = refreshApi.count("/api/inventory/refresh", "POST");
  await page.getByRole("button", { name: "卡片视图", exact: true }).click();
  await expect(cards(page)).toHaveCount(10);
  await expect(pagination).toContainText("2 / 3");
  expect(
    (await cards(page).locator(".name-link").allTextContents()).map((name) => name.trim()),
  ).toEqual(namesBefore);
  expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(syncsBefore);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.manualRequests().length).toBe(1);
  refreshApi.finish("succeeded", (items) => {
    items[11].displayName = "Fixture-12 updated";
  });
  refreshApi.now += 5000;
  await page.clock.runFor(5000);
  await expect(page.getByRole("link", { name: "Fixture-12 updated", exact: true })).toBeVisible();
  await expect(pagination).toContainText("2 / 3");
  await expect(page.getByLabel("搜索实例名称、地址或 OCID")).toHaveValue("Fixture");
  await expect(page.getByLabel("筛选账号", { exact: true })).toHaveValue(account.id);
  await expect(page.getByLabel("筛选区域", { exact: true })).toHaveValue(account.homeRegion);
  await expect(page.getByLabel("筛选状态", { exact: true })).toHaveValue("RUNNING");
  await page.getByRole("link", { name: "Fixture-12 updated", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Fixture-12 updated");
  expect(refreshApi.count("/api/instances/refresh-instance-12")).toBeGreaterThan(0);
  await page.locator(".sidebar nav").getByRole("link", { name: "任务", exact: true }).click();
  await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
  await expect(page.locator(".task-table tbody tr")).toHaveCount(1);
  const inventoryReads = refreshApi.count("/api/instances");
  const detailReads = refreshApi.count("/api/instances/refresh-instance-12");
  const inventoryRefreshes = refreshApi.count("/api/inventory/refresh", "POST");
  refreshApi.now += 120_000;
  await page.clock.runFor(120_000);
  expect(refreshApi.count("/api/instances")).toBe(inventoryReads);
  expect(refreshApi.count("/api/instances/refresh-instance-12")).toBe(detailReads);
  expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(inventoryRefreshes);
});

test("隐藏页面停止快照和自动同步请求，恢复可见后更新", async ({ page, refreshApi }) => {
  await pauseClock(page, refreshApi);
  await openInstances(page);
  await expect.poll(() => refreshApi.count("/api/inventory/refresh", "POST")).toBeGreaterThan(0);
  await fixtureVisibility(page, "hidden");
  const readsBefore = refreshApi.count("/api/instances");
  const syncsBefore = refreshApi.count("/api/inventory/refresh", "POST");
  refreshApi.now += 120_000;
  await page.clock.runFor(120_000);
  expect(refreshApi.count("/api/instances")).toBe(readsBefore);
  expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(syncsBefore);
  refreshApi.rows[0].displayName = "Fixture-01 resumed";
  await fixtureVisibility(page, "visible");
  await expect(page.getByRole("link", { name: "Fixture-01 resumed", exact: true })).toBeVisible();
  expect(refreshApi.count("/api/instances")).toBeGreaterThan(readsBefore);
  await expect
    .poll(() => refreshApi.count("/api/inventory/refresh", "POST"))
    .toBeGreaterThan(syncsBefore);
});

test("慢 GET 不被五秒轮询反复取消，完成后继续正常轮询", async ({ page, refreshApi }) => {
  await pauseClock(page, refreshApi);
  let release!: () => void;
  refreshApi.jobsGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/tasks");
    await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
    await expect.poll(() => refreshApi.count("/api/jobs")).toBe(1);
    refreshApi.now += 16_000;
    await page.clock.runFor(16_000);
    expect(refreshApi.count("/api/jobs")).toBe(1);
    expect(refreshApi.failedRequests.filter((path) => path === "/api/jobs")).toEqual([]);
    release();
    refreshApi.jobsGate = undefined;
    await expect(page.locator(".task-table tbody tr")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "重命名实例", exact: true })).toBeVisible();
    refreshApi.now += 5000;
    await page.clock.runFor(5000);
    await expect.poll(() => refreshApi.count("/api/jobs")).toBe(2);
    expect(refreshApi.failedRequests.filter((path) => path === "/api/jobs")).toEqual([]);
  } finally {
    release();
    refreshApi.jobsGate = undefined;
  }
});

test("空偏好默认卡片，显式视图选择持久化且两种视图共享排序", async ({ page, refreshApi }) => {
  await page.goto("/instances");
  const tableView = page.getByRole("button", { name: "表格视图", exact: true });
  const cardView = page.getByRole("button", { name: "卡片视图", exact: true });
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(tableView).toHaveAttribute("aria-pressed", "false");
  await expect(cards(page)).toHaveCount(10);
  expect(await page.evaluate(() => localStorage.getItem("oci-dash:instances:view"))).toBeNull();
  await tableView.click();
  await expect(rows(page)).toHaveCount(10);
  await expect(refreshButton(page)).toBeEnabled();
  await expect(tableView).toHaveAttribute("aria-pressed", "true");
  await expect(cardView).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(启动|停止|取消选择)$/ })).toHaveCount(0);
  const tableNames = (await rows(page).locator(".name-link").allTextContents()).map((name) =>
    name.trim(),
  );
  const writesBefore = refreshApi.count("/api/inventory/refresh", "POST");

  await cardView.click();
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(tableView).toHaveAttribute("aria-pressed", "false");
  await expect(cards(page)).toHaveCount(10);
  await expect(rows(page)).toHaveCount(0);
  expect(
    await page.locator(".instance-cards").evaluate((element) => getComputedStyle(element).display),
  ).toBe("grid");
  expect(
    (await cards(page).locator(".name-link").allTextContents()).map((name) => name.trim()),
  ).toEqual(tableNames);
  for (const card of await cards(page).all()) {
    await expect(card.locator(".name-link")).toHaveCount(1);
    const href = await card.locator(".name-link").getAttribute("href");
    expect(href).toMatch(/^\/instances\/refresh-instance-\d+$/);
    expect(
      await card
        .locator("a")
        .evaluateAll(
          (links, target) => links.filter((link) => link.getAttribute("href") === target).length,
          href,
        ),
    ).toBeGreaterThanOrEqual(2);
  }
  await page.getByRole("button", { name: "按实例名称排序", exact: true }).click();
  await expect(cards(page).first().locator(".name-link")).toHaveText("Fixture-22");
  const descendingNames = (await cards(page).locator(".name-link").allTextContents()).map((name) =>
    name.trim(),
  );
  await tableView.click();
  await expect(rows(page).first().locator(".name-link")).toHaveText("Fixture-22");
  await expect(page.getByRole("columnheader", { name: "实例名称", exact: true })).toHaveAttribute(
    "aria-sort",
    "descending",
  );
  expect(
    (await rows(page).locator(".name-link").allTextContents()).map((name) => name.trim()),
  ).toEqual(descendingNames);
  await cardView.click();
  await expect(cards(page)).toHaveCount(10);
  expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(writesBefore);
  expect(refreshApi.manualRequests()).toEqual([]);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("oci-dash:instances:view")))
    .toBe("cards");

  await cards(page).first().locator(".name-link").click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Fixture-22");
  await page.goBack();
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(10);
  await page.reload();
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(10);
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await tableView.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("oci-dash:instances:view")))
    .toBe("table");
  await page.reload();
  await expect(tableView).toHaveAttribute("aria-pressed", "true");
  await expect(rows(page)).toHaveCount(10);
  await expect(cards(page)).toHaveCount(0);
});

test("视图偏好存储不可用时默认卡片，本次访问仍可切换", async ({ page, context, refreshApi }) => {
  await context.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key) {
      if (key === "oci-dash:instances:view")
        throw new DOMException("Fixture storage unavailable", "SecurityError");
      return getItem.call(this, key);
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === "oci-dash:instances:view")
        throw new DOMException("Fixture storage unavailable", "SecurityError");
      return setItem.call(this, key, value);
    };
  });
  await page.goto("/instances");
  const tableView = page.getByRole("button", { name: "表格视图", exact: true });
  const cardView = page.getByRole("button", { name: "卡片视图", exact: true });
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(10);
  await tableView.click();
  await expect(rows(page)).toHaveCount(10);
  await expect(tableView).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await expect(cardView).toHaveAttribute("aria-pressed", "true");
  await expect(cards(page)).toHaveCount(10);
  expect(refreshApi.manualRequests()).toEqual([]);
});

test("表格和卡片统一显示区域代码，已知区域使用本地旗帜而未知区域不虚构旗帜", async ({
  page,
  refreshApi,
}) => {
  refreshApi.rows[0].region = "unknown-test-1";
  await openInstances(page);
  const unknownRow = rows(page).filter({
    has: page.getByRole("link", { name: "Fixture-01", exact: true }),
  });
  const knownRow = rows(page).filter({
    has: page.getByRole("link", { name: "Fixture-02", exact: true }),
  });
  await expect(unknownRow).toContainText("unknown-test-1");
  await expect(knownRow.getByText(account.homeRegion, { exact: true })).toHaveCount(1);
  await expect(unknownRow.locator('img[src^="/flags/"]')).toHaveCount(0);
  const tableFlag = knownRow.locator('img[src^="/flags/"]');
  await expect(tableFlag).toHaveCount(1);
  await expect(tableFlag).toHaveAttribute("src", /^\/flags\/[a-z]{2}\.svg$/);
  await expect
    .poll(() =>
      tableFlag.evaluate(
        (element) =>
          (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);

  const writesBefore = refreshApi.count("/api/inventory/refresh", "POST");
  await page.getByRole("button", { name: "卡片视图", exact: true }).click();
  await expect(cards(page)).toHaveCount(10);
  const unknownCard = cards(page).filter({
    has: page.getByRole("link", { name: "Fixture-01", exact: true }),
  });
  const knownCard = cards(page).filter({
    has: page.getByRole("link", { name: "Fixture-02", exact: true }),
  });
  await expect(unknownCard).toContainText("unknown-test-1");
  await expect(knownCard.getByText(account.homeRegion, { exact: true })).toHaveCount(1);
  await expect(unknownCard.locator('img[src^="/flags/"]')).toHaveCount(0);
  const cardFlag = knownCard.locator('img[src^="/flags/"]');
  await expect(cardFlag).toHaveCount(1);
  await expect
    .poll(() =>
      cardFlag.evaluate(
        (element) =>
          (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true);
  expect(
    await page.locator(".instance-cards img").evaluateAll((images) =>
      images.every((image) => {
        const url = new URL((image as HTMLImageElement).src);
        return url.origin === location.origin && /^\/flags\/[a-z]{2}\.svg$/.test(url.pathname);
      }),
    ),
  ).toBe(true);
  expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(writesBefore);
  expect(refreshApi.manualRequests()).toEqual([]);
});

test("可恢复中断任务继续轮询，完成后停止且显示等待期限", async ({ page, refreshApi }) => {
  await pauseClock(page, refreshApi);
  const task = refreshApi.taskRows[0];
  Object.assign(task, {
    state: "interrupted",
    attempt: 4,
    maxAttempts: 4,
    waitingForCompletion: true,
    nextRunAt: new Date(refreshApi.now + 5000).toISOString(),
    completionDeadlineAt: new Date(refreshApi.now + 1800000).toISOString(),
  });
  const path = `/api/jobs/${task.id}`;
  await page.goto(`/tasks/${task.id}`);
  await expect(page.locator(".task-step.current")).toHaveText("执行中");
  await expect(page.getByText("任务执行期间自动更新", { exact: true })).toBeVisible();
  await expect(page.getByText("本轮完成期限", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消任务", exact: true })).toBeVisible();
  const before = refreshApi.count(path);
  Object.assign(task, { state: "running", nextRunAt: null });
  await page.clock.runFor(3100);
  await expect.poll(() => refreshApi.count(path)).toBeGreaterThan(before);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("执行中");
  Object.assign(task, {
    state: "succeeded",
    waitingForCompletion: false,
    finishedAt: new Date(refreshApi.now).toISOString(),
  });
  await page.clock.runFor(3100);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("已完成");
  await settleTaskPolling(page);
  const completed = refreshApi.count(path);
  await page.clock.runFor(10000);
  expect(refreshApi.count(path)).toBe(completed);
});

test("不可恢复中断任务停止轮询并可直接取消，无需重试云端操作", async ({ page, refreshApi }) => {
  await pauseClock(page, refreshApi);
  const task = refreshApi.taskRows[0];
  Object.assign(task, { state: "interrupted", attempt: 4, maxAttempts: 4, nextRunAt: null });
  const path = `/api/jobs/${task.id}`;
  await page.goto(`/tasks/${task.id}`);
  await expect(page.locator(".task-step.current")).toHaveText("等待处理");
  await expect(page.getByText("自动恢复已停止，可重试或取消任务", { exact: true })).toBeVisible();
  await settleTaskPolling(page);
  const before = refreshApi.count(path);
  await page.clock.runFor(10000);
  expect(refreshApi.count(path)).toBe(before);
  await page.getByRole("button", { name: "取消任务", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "取消任务", exact: true });
  await dialog.getByRole("button", { name: "确认取消", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("已取消");
  expect(refreshApi.count(path + "/cancel", "POST")).toBe(1);
  expect(
    refreshApi.requests
      .filter((request) => request.method !== "GET")
      .map((request) => request.path),
  ).toEqual([path + "/cancel"]);
});

test("批量同步立即检查状态，快账号先显示且不等待慢账号的状态请求", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  await pauseClock(page, refreshApi);
  await openTwoAccounts(page);
  const before = refreshApi.count("/api/instances");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowId = `refresh-fixture-sync-${slow.id}`;
  refreshApi.jobGates.set(slowId, gate);
  try {
    await refreshButton(page).click();
    // The clock is paused: these reads prove there is no initial 2s delay.
    await expect.poll(() => refreshApi.count("/api/jobs/refresh-fixture-sync")).toBe(1);
    await expect.poll(() => refreshApi.count(`/api/jobs/${slowId}`)).toBe(1);
    refreshApi.finish("succeeded", (items) => {
      items[0].displayName = "Fixture-01 fast";
    });
    await advance(page, refreshApi);
    await expect(page.getByRole("link", { name: "Fixture-01 fast", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Slow-01", exact: true })).toBeVisible();
    await expect(refreshButton(page)).toBeDisabled();
    expect(refreshApi.count("/api/instances")).toBe(before + 1);
    const completedReads = refreshApi.count("/api/jobs/refresh-fixture-sync");
    await advance(page, refreshApi, 3000);
    expect(refreshApi.count("/api/jobs/refresh-fixture-sync")).toBe(completedReads);
    expect(refreshApi.count("/api/instances")).toBe(before + 1);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    refreshApi.finishAccount(slow.id, "succeeded", (items) => {
      items[1].displayName = "Slow-01 done";
    });
    refreshApi.jobGates.delete(slowId);
    release();
    await expect(page.getByRole("link", { name: "Slow-01 done", exact: true })).toBeVisible();
    await expect(refreshButton(page)).toBeEnabled();
    expect(refreshApi.peakInstanceReads).toBe(1);
    expect(refreshApi.manualRequests()).toHaveLength(1);
    expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(2);
  } finally {
    release();
    refreshApi.jobGates.clear();
  }
});

test("账号逐个完成后仅慢账号保留转圈，失败账号及时显示错误", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  refreshApi.syncJobs = refreshApi.accounts.map((item) => ({
    ...job(`active-${item.id}`),
    accountId: item.id,
    accountName: item.name,
    state: "running",
  }));
  await pauseClock(page, refreshApi);
  await page.goto("/settings/accounts");
  const fastCard = page
    .locator(".account-card")
    .filter({ has: page.getByRole("button", { name: `查看 ${account.name} 详情`, exact: true }) });
  const slowCard = page
    .locator(".account-card")
    .filter({ has: page.getByRole("button", { name: `查看 ${slow.name} 详情`, exact: true }) });
  await expect(fastCard.locator(".spin")).toHaveCount(1);
  await expect(slowCard.locator(".spin")).toHaveCount(1);
  refreshApi.finish("failed");
  await advance(page, refreshApi);
  await expect(fastCard.locator(".spin")).toHaveCount(0);
  await expect(fastCard.getByRole("button", { name: "重试刷新", exact: true })).toBeEnabled();
  await expect(fastCard).toContainText("模拟 OCI 读取失败");
  await expect(slowCard.locator(".spin")).toHaveCount(1);
  refreshApi.finishAccount(slow.id, "succeeded");
  await advance(page, refreshApi);
  await expect(slowCard.locator(".spin")).toHaveCount(0);
  await expect(slowCard.getByRole("button", { name: "刷新资源", exact: true })).toBeEnabled();
  expect(refreshApi.manualRequests()).toEqual([]);
});

test("快照读取失败保留旧行，另一个账号完成后仍能发布新快照", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  await pauseClock(page, refreshApi);
  await openTwoAccounts(page);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.syncJobs.length).toBe(2);
  refreshApi.failedSnapshots = 1;
  refreshApi.finish("succeeded", (items) => {
    items[0].displayName = "Fixture-01 recovered";
  });
  await advance(page, refreshApi);
  await expect(page.getByText("模拟快照读取失败", { exact: true })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Fixture-01", exact: true })).toBeVisible();
  await expect(refreshButton(page)).toBeDisabled();
  refreshApi.finishAccount(slow.id, "succeeded", (items) => {
    items[1].displayName = "Slow-01 recovered";
  });
  await advance(page, refreshApi);
  await expect(page.getByRole("link", { name: "Fixture-01 recovered", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Slow-01 recovered", exact: true })).toBeVisible();
  await expect(page.getByText("模拟快照读取失败", { exact: true })).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
  await expect(refreshButton(page)).toBeEnabled();
});

test("相邻账号完成时串行合并快照读取，完成ID不会反复刷新", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  await pauseClock(page, refreshApi);
  await openTwoAccounts(page);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.syncJobs.length).toBe(2);
  const before = refreshApi.count("/api/instances");
  let release!: () => void;
  refreshApi.instancesGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    refreshApi.finish("succeeded", (items) => {
      items[0].displayName = "Fixture-01 first";
    });
    await advance(page, refreshApi);
    await expect.poll(() => refreshApi.activeInstanceReads).toBe(1);
    refreshApi.finishAccount(slow.id, "succeeded", (items) => {
      items[1].displayName = "Slow-01 second";
    });
    await advance(page, refreshApi);
    expect(refreshApi.count("/api/instances")).toBe(before + 1);
    expect(refreshApi.peakInstanceReads).toBe(1);
    refreshApi.instancesGate = undefined;
    release();
    await expect(page.getByRole("link", { name: "Fixture-01 first", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Slow-01 second", exact: true })).toBeVisible();
    await expect(refreshButton(page)).toBeEnabled();
    expect(refreshApi.count("/api/instances")).toBe(before + 2);
    await advance(page, refreshApi, 3000);
    expect(refreshApi.count("/api/instances")).toBe(before + 2);
    expect(refreshApi.peakInstanceReads).toBe(1);
  } finally {
    release();
    refreshApi.instancesGate = undefined;
  }
});

test("隐藏中止状态等待而不取消后台任务，恢复时补查隐藏期间完成的账号", async ({
  page,
  refreshApi,
}) => {
  const slow = twoAccounts(refreshApi);
  await pauseClock(page, refreshApi);
  await openTwoAccounts(page);
  const slowId = `refresh-fixture-sync-${slow.id}`;
  let release!: () => void;
  refreshApi.jobGates.set(
    slowId,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  try {
    await refreshButton(page).click();
    await expect.poll(() => refreshApi.count(`/api/jobs/${slowId}`)).toBe(1);
    refreshApi.finish("succeeded", (items) => {
      items[0].displayName = "Fixture-01 visible";
    });
    await advance(page, refreshApi);
    await expect(page.getByRole("link", { name: "Fixture-01 visible", exact: true })).toBeVisible();
    await fixtureVisibility(page, "hidden");
    await expect.poll(() => refreshApi.failedRequests.includes(`/api/jobs/${slowId}`)).toBe(true);
    const reads = refreshApi.count("/api/instances");
    const requests = refreshApi.count(`/api/jobs/${slowId}`);
    const syncs = refreshApi.count("/api/inventory/refresh", "POST");
    refreshApi.finishAccount(slow.id, "succeeded", (items) => {
      items[1].displayName = "Slow-01 while hidden";
    });
    refreshApi.jobGates.delete(slowId);
    release();
    await advance(page, refreshApi, 10_000);
    expect(refreshApi.count("/api/instances")).toBe(reads);
    expect(refreshApi.count(`/api/jobs/${slowId}`)).toBe(requests);
    expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(syncs);
    await fixtureVisibility(page, "visible");
    await expect(
      page.getByRole("link", { name: "Slow-01 while hidden", exact: true }),
    ).toBeVisible();
    await expect.poll(() => refreshApi.count(`/api/jobs/${slowId}`)).toBeGreaterThan(requests);
    await expect(refreshButton(page)).toBeEnabled();
    expect(refreshApi.manualRequests()).toHaveLength(1);
    expect(refreshApi.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false);
  } finally {
    release();
    refreshApi.jobGates.clear();
  }
});

test("120秒边界结束浏览器等待，保持旧快照和后台任务", async ({ page, refreshApi }) => {
  const slow = twoAccounts(refreshApi);
  await pauseClock(page, refreshApi);
  await openTwoAccounts(page);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.syncJobs.length).toBe(2);
  // Jobs are created before the POST response reaches the browser. Its first
  // status requests prove the waiting budget has actually started.
  await expect.poll(() => refreshApi.count("/api/jobs/refresh-fixture-sync")).toBe(1);
  await expect.poll(() => refreshApi.count(`/api/jobs/refresh-fixture-sync-${slow.id}`)).toBe(1);
  const notice = page.getByText("资源同步仍在后台执行，稍后将自动更新。可在账号页查看进度。", {
    exact: true,
  });
  await advance(page, refreshApi, 119_999);
  await expect(refreshButton(page)).toBeDisabled();
  await expect(notice).toHaveCount(0);
  await advance(page, refreshApi, 1);
  await expect(notice).toBeVisible();
  await expect(refreshButton(page)).toBeEnabled();
  await expect(rows(page)).toHaveCount(2);
  expect(refreshApi.syncJobs.every((item) => item.state === "queued")).toBe(true);
  expect(refreshApi.requests.some((request) => request.path.endsWith("/cancel"))).toBe(false);
  const count = refreshApi.requests.length;
  await advance(page, refreshApi, 2000);
  expect(refreshApi.requests.length).toBe(count);
  await expect(notice).toBeVisible();
  // A deliberate retry bypasses the automatic-check cooldown and joins the
  // original jobs, rather than cancelling or replacing work still in progress.
  const ids = refreshApi.syncJobs.map((item) => item.id);
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.manualRequests().length).toBe(2);
  expect(refreshApi.syncJobs.map((item) => item.id)).toEqual(ids);
  await expect(refreshButton(page)).toBeDisabled();
  await expect(notice).toHaveCount(0);
});

for (const alreadyActive of [false, true]) {
  test(`自动检查期间手动点击合并请求：${alreadyActive ? "已有同步不再创建" : "fresh后保留一次手动同步"}`, async ({
    page,
    refreshApi,
  }) => {
    await pauseClock(page, refreshApi);
    if (alreadyActive) refreshApi.syncJob = job();
    let release!: () => void;
    refreshApi.refreshGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await openInstances(page);
      await expect.poll(() => refreshApi.count("/api/inventory/refresh", "POST")).toBe(1);
      await refreshButton(page).evaluate((button: HTMLButtonElement) => {
        button.click();
        button.click();
      });
      refreshApi.refreshGate = undefined;
      release();
      await expect(refreshButton(page)).toBeDisabled();
      await expect.poll(() => refreshApi.manualRequests().length).toBe(alreadyActive ? 0 : 1);
      const jobPath = `/api/jobs/${refreshApi.syncJob!.id}`;
      let completedStatusReceived = false;
      page.on("response", async (response) => {
        if (response.request().method() !== "GET" || new URL(response.url()).pathname !== jobPath)
          return;
        const body = await response.json().catch(() => null);
        if (body?.job?.state === "succeeded") completedStatusReceived = true;
      });
      refreshApi.finish("succeeded");
      // Recording the manual request does not mean its response or first status
      // read has reached the browser. Keep driving the paused clock until the
      // terminal status arrives, including when a pending response arms the next poll late.
      await expect
        .poll(async () => {
          await advance(page, refreshApi);
          return completedStatusReceived;
        })
        .toBe(true);
      await expect(refreshButton(page)).toBeEnabled();
      expect(refreshApi.count("/api/inventory/refresh", "POST")).toBe(alreadyActive ? 1 : 2);
    } finally {
      release();
      refreshApi.refreshGate = undefined;
    }
  });
}
