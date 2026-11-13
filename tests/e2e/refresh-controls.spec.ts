import { expect, test as base, type Page } from "@playwright/test";
import type { JobSummary } from "../../src/lib/contracts";
import { fixtureAccounts } from "../fixtures/seed-data";
import { jobPageFixture } from "../fixtures/job-page";

const accounts = fixtureAccounts().slice(0, 2);
const account = accounts[0]!;
const clockTime = new Date("2026-11-13T05:40:00.000Z");

function task(
  id: string,
  resourceId: string,
  state: JobSummary["state"],
  selectedAccount = account,
): JobSummary {
  return {
    id,
    kind: "instance-start",
    accountId: selectedAccount.id,
    accountName: selectedAccount.name,
    region: selectedAccount.homeRegion,
    resourceId,
    state,
    attempt: 1,
    maxAttempts: 4,
    createdAt: "2026-11-12T00:00:00.000Z",
    startedAt: "2026-11-12T00:00:01.000Z",
    finishedAt: state === "succeeded" ? "2026-11-12T00:00:02.000Z" : null,
    nextRunAt: null,
    lastError: null,
    result: null,
  };
}

interface RefreshControlsFixture {
  jobs: JobSummary[];
  reads: number;
  queries: URLSearchParams[];
  gates: Map<number, Promise<void>>;
  failJobs: boolean;
}

const test = base.extend<{ refreshControls: RefreshControlsFixture }>({
  refreshControls: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [];
      const errors: string[] = [];
      const state: RefreshControlsFixture = {
        jobs: [
          task("refresh-control-running", "keep-filter-running", "running"),
          task("refresh-control-complete", "keep-filter-complete", "succeeded"),
          task("refresh-control-other", "keep-filter-other", "running", accounts[1]!),
        ],
        reads: 0,
        queries: [],
        gates: new Map(),
        failJobs: false,
      };
      const track = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
      context.pages().forEach(track);
      context.on("page", track);
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push("WS " + socket.url());
        socket.close();
      });
      // Only the local application shell and assets reach the isolated server.
      // Every API, external request and WebSocket is intercepted before navigation.
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (url.origin !== origin) {
          unexpected.push(method + " " + request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) {
          if (method === "GET") return route.continue();
          unexpected.push(method + " " + url.pathname);
          return route.abort();
        }
        const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
        if (method === "GET" && url.pathname === "/api/auth/me")
          return json({
            user: { id: "refresh-control-user", username: "fixture", mfaEnabled: false },
          });
        if (method === "GET" && url.pathname === "/api/accounts")
          return json({ accounts, syncJobs: [] });
        if (method === "GET" && url.pathname === "/api/jobs") {
          const read = ++state.reads;
          state.queries.push(new URLSearchParams(url.searchParams));
          const snapshot = jobPageFixture(structuredClone(state.jobs), url.searchParams);
          const fail = state.failJobs;
          const gate = state.gates.get(read);
          if (gate) await gate;
          return fail ? json({ error: "Fixture task read unavailable" }, 503) : json(snapshot);
        }
        unexpected.push(method + " " + url.pathname);
        return route.abort();
      });
      try {
        await use(state);
      } finally {
        expect(unexpected, "All API, external and WebSocket requests must be mocked").toEqual([]);
        expect(errors, "Refresh controls must not raise browser errors").toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({
  timezoneId: "Asia/Hong_Kong",
  trace: "off",
  video: "off",
  screenshot: "off",
  serviceWorkers: "block",
});

const heading = (page: Page) => page.locator('[data-slot="page-heading"]');
const refreshButton = (page: Page) =>
  heading(page).getByRole("button", { name: "刷新", exact: true });
const taskList = (page: Page) => page.getByRole("region", { name: "任务列表表格", exact: true });

async function openTasks(page: Page, query = "") {
  await page.clock.install({ time: clockTime });
  await page.clock.pauseAt(new Date(clockTime.getTime() + 1000));
  await page.goto("/tasks" + query);
  await expect(heading(page).getByRole("heading", { name: "任务", exact: true })).toBeVisible();
}

async function showRefreshTooltip(page: Page) {
  await refreshButton(page).hover();
  await page.clock.runFor(400);
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toBeVisible();
  return tooltip;
}

async function buttonWidth(page: Page) {
  return refreshButton(page).evaluate((button) => button.getBoundingClientRect().width);
}

test("任务页只在单行刷新提示中显示成功读取时间", async ({ page }) => {
  await openTasks(page);
  await expect(taskList(page).locator("tbody tr")).toHaveCount(3);
  const refresh = refreshButton(page);
  await expect(refresh).toHaveText("刷新");
  await expect(refresh).toHaveAttribute("data-variant", "outline");
  await expect(heading(page).locator("time.updated-at")).toHaveCount(0);
  await expect(heading(page)).not.toContainText("上次更新");
  const tooltip = await showRefreshTooltip(page);
  await expect(tooltip).toHaveText("上次更新：13:40");
  await expect(tooltip.locator("br")).toHaveCount(0);
  const dimensions = await tooltip.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      contentHeight:
        element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
      lineHeight: parseFloat(style.lineHeight),
    };
  });
  expect(dimensions.contentHeight).toBeLessThanOrEqual(dimensions.lineHeight + 1);
});

test("自动轮询静默，手动刷新等待完成且保留筛选、旧行和按钮宽度", async ({
  page,
  refreshControls,
}) => {
  const query = new URLSearchParams({
    query: "keep-filter",
    accountId: account.id,
    state: "running",
  });
  await openTasks(page, "?" + query);
  const list = taskList(page);
  await expect(list.locator("tbody tr")).toHaveCount(1);
  await expect(list).toContainText("keep-filter-running");
  const refresh = refreshButton(page);
  await expect(refresh).toBeEnabled();
  const originalWidth = await buttonWidth(page);
  const originalUrl = page.url();
  const before = refreshControls.reads;
  let releasePoll = () => {};
  let releaseManual = () => {};
  refreshControls.gates.set(
    before + 1,
    new Promise<void>((resolve) => {
      releasePoll = resolve;
    }),
  );
  refreshControls.gates.set(
    before + 2,
    new Promise<void>((resolve) => {
      releaseManual = resolve;
    }),
  );
  try {
    await page.clock.runFor(5000);
    await expect.poll(() => refreshControls.reads).toBe(before + 1);
    await expect(refresh).toBeEnabled();
    await expect(refresh).not.toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
    await expect(list.locator("tbody tr")).toHaveCount(1);

    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveCount(1);
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "spin");
    expect(await buttonWidth(page)).toBeCloseTo(originalWidth, 1);
    refreshControls.jobs[0]!.lastError = "手动刷新后的任务记录";
    releasePoll();
    await expect.poll(() => refreshControls.reads).toBe(before + 2);
    // Finishing the older poll must not finish the manually requested new read.
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh).toBeDisabled();
    await expect(list).not.toContainText("手动刷新后的任务记录");
    await expect(list.locator("tbody tr")).toHaveCount(1);
    await expect(page.getByLabel("搜索任务", { exact: true })).toHaveValue("keep-filter");
    await expect(page.getByLabel("按账号筛选任务", { exact: true })).toHaveAttribute(
      "data-value",
      account.id,
    );
    await expect(page.getByLabel("按状态筛选任务", { exact: true })).toHaveAttribute(
      "data-value",
      "running",
    );
    expect(page.url()).toBe(originalUrl);
    expect(await buttonWidth(page)).toBeCloseTo(originalWidth, 1);
    releaseManual();
    await expect(list).toContainText("手动刷新后的任务记录");
    await expect(refresh).toBeEnabled();
    await expect(refresh).not.toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "none");
    await expect(list.locator("tbody tr")).toHaveCount(1);
    expect(page.url()).toBe(originalUrl);
    expect(await buttonWidth(page)).toBeCloseTo(originalWidth, 1);
    expect(
      refreshControls.queries.every(
        (params) =>
          params.get("query") === "keep-filter" &&
          params.get("accountId") === account.id &&
          params.get("state") === "running",
      ),
    ).toBe(true);
  } finally {
    refreshControls.gates.clear();
    releasePoll();
    releaseManual();
  }
});

test("尚无成功读取时间时刷新提示只显示刷新", async ({ page, refreshControls }) => {
  refreshControls.failJobs = true;
  await openTasks(page);
  await expect(page.getByText("Fixture task read unavailable", { exact: true })).toBeVisible();
  await expect(refreshButton(page)).toBeEnabled();
  await expect(heading(page).locator("time.updated-at")).toHaveCount(0);
  await expect(await showRefreshTooltip(page)).toHaveText("刷新");
});
