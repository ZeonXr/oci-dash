import { expect, test as base, type Page } from "@playwright/test";
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
  rows: InstanceSummary[];
  syncJob: JobSummary | null;
  taskRows: JobSummary[];
  requests: RequestRecord[];
  failedRequests: string[];
  unexpected: string[];
  jobsGate?: Promise<void>;
  finish(state: "succeeded" | "failed", update?: (rows: InstanceSummary[]) => void): void;
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
      rows: instances(),
      syncJob: null,
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
      failedRequests: [],
      unexpected: [],
      finish(status, update) {
        if (!state.syncJob) throw new Error("No fixture synchronization was requested.");
        update?.(state.rows);
        const timestamp = new Date(state.now + 1000).toISOString();
        state.syncJob = {
          ...state.syncJob,
          state: status,
          attempt: 1,
          finishedAt: timestamp,
          lastError: status === "failed" ? "模拟 OCI 读取失败" : null,
        };
        if (status === "succeeded")
          state.rows.forEach((row) => {
            row.syncedAt = timestamp;
          });
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
          demo: false,
        });
      if (method === "GET" && path === "/api/accounts")
        return json({
          accounts: [{ ...account, lastSyncAt: state.rows[0]?.syncedAt ?? account.lastSyncAt }],
          syncJobs: state.syncJob ? [state.syncJob] : [],
          demo: false,
        });
      if (method === "GET" && path === "/api/instances")
        return json({ instances: state.rows, demo: false });
      if (method === "GET" && path === "/api/dashboard") {
        const body: DashboardData = {
          accounts: [account],
          instances: state.rows,
          jobs: state.taskRows,
          activity: [],
          demo: false,
          totals: {
            accounts: 1,
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
        if (detail[2] === "metrics") return json({ points: [], available: false, source: "oci" });
        if (detail[2] === "security") return json({ groups: [], demo: false });
        return json({ instance, demo: false });
      }
      if (method === "POST" && path === "/api/inventory/refresh") {
        expect(["auto", "manual"]).toContain(entry.body?.mode);
        if (entry.body?.accountIds) expect(entry.body.accountIds).toEqual([account.id]);
        if (entry.body?.mode === "manual") state.syncJob = job();
        const active =
          state.syncJob && !["succeeded", "failed"].includes(state.syncJob.state)
            ? state.syncJob
            : null;
        const body: InventoryRefreshResult = {
          jobs: active ? [active] : [],
          accounts: [
            {
              accountId: account.id,
              status: active ? (entry.body?.mode === "manual" ? "queued" : "active") : "fresh",
              jobId: active?.id ?? null,
              lastSyncedAt: state.rows[0]?.syncedAt ?? null,
              nextRefreshAt: new Date(state.now + 60_000).toISOString(),
            },
          ],
          demo: false,
        };
        return json(body, active ? 202 : 200);
      }
      if (method === "GET" && path === "/api/jobs") {
        if (state.jobsGate) await state.jobsGate;
        return json({ jobs: state.taskRows, demo: false });
      }
      if (method === "GET" && path === "/api/jobs/" + state.syncJob?.id)
        return json({ job: state.syncJob, events: [], demo: false });
      state.unexpected.push(method + " " + path);
      return json({ error: "Unmocked API blocked by refresh fixture" }, 501);
    });
    await use(state);
    expect(state.unexpected, "Every API/external request must be mocked").toEqual([]);
    expect(errors, "Refresh must not raise uncaught browser errors").toEqual([]);
  },
});
test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

const refreshButton = (page: Page) =>
  page.locator(".page-heading").getByRole("button", { name: "刷新", exact: true });
const rows = (page: Page) => page.locator(".resource-table tbody tr");
const cards = (page: Page) => page.locator("article.instance-card");
async function openInstances(page: Page) {
  await page.goto("/instances");
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

test("手动刷新提交 OCI 同步任务，终态后重新读取快照，等待期间保留原行", async ({
  page,
  refreshApi,
}) => {
  await openInstances(page);
  const before = refreshApi.count("/api/instances");
  await refreshButton(page).click();
  await expect.poll(() => refreshApi.manualRequests().length).toBe(1);
  await expect(rows(page)).toHaveCount(10);
  await expect(page.getByRole("link", { name: "Fixture-01", exact: true })).toBeVisible();
  refreshApi.finish("succeeded", (items) => {
    items[0].displayName = "Fixture-01 updated";
  });
  await expect(page.getByRole("link", { name: "Fixture-01 updated", exact: true })).toBeVisible();
  expect(refreshApi.count("/api/jobs/refresh-fixture-sync")).toBeGreaterThan(0);
  expect(refreshApi.count("/api/instances")).toBeGreaterThan(before);
  await expect(refreshButton(page)).toBeEnabled();
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

test("卡片切换与刷新保留筛选和当前页，详情与总览读取更新后的快照", async ({ page, refreshApi }) => {
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
  await expect(page.getByRole("link", { name: "Fixture-12 updated", exact: true })).toBeVisible();
  await expect(pagination).toContainText("2 / 3");
  await expect(page.getByLabel("搜索实例名称、地址或 OCID")).toHaveValue("Fixture");
  await expect(page.getByLabel("筛选账号", { exact: true })).toHaveValue(account.id);
  await expect(page.getByLabel("筛选区域", { exact: true })).toHaveValue(account.homeRegion);
  await expect(page.getByLabel("筛选状态", { exact: true })).toHaveValue("RUNNING");
  await page.getByRole("link", { name: "Fixture-12 updated", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Fixture-12 updated");
  expect(refreshApi.count("/api/instances/refresh-instance-12")).toBeGreaterThan(0);
  await page.locator(".sidebar nav").getByRole("link", { name: "总览", exact: true }).click();
  await expect(page.getByRole("heading", { name: "资源总览", exact: true })).toBeVisible();
  expect(refreshApi.count("/api/dashboard")).toBeGreaterThan(0);
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

test("实例视图共享排序且记住偏好，列表不再提供多选或批量操作", async ({ page, refreshApi }) => {
  await openInstances(page);
  const tableView = page.getByRole("button", { name: "表格视图", exact: true });
  const cardView = page.getByRole("button", { name: "卡片视图", exact: true });
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

test("已知区域使用本地旗帜，未知区域在表格和卡片中保留名称而不虚构旗帜", async ({
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
