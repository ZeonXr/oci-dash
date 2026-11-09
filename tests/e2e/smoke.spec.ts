import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { DashboardData, SessionUser } from "../../src/lib/contracts";
import {
  fixtureAccounts,
  fixtureActivity,
  fixtureEvents,
  fixtureInstances,
  fixtureJobs,
  fixtureMetrics,
  fixtureSecurity,
} from "../fixtures/seed-data";
import {
  fixtureCostReport,
  fixtureCpuReport,
  fixtureTrafficReport,
} from "../fixtures/analytics-data";
import { parseCostQuery, parseTrafficQuery } from "../../src/server/analytics/query";
import { jobPageFixture } from "../fixtures/job-page";

// Authentication and empty-state checks use a fresh isolated server. Populated
// screens receive synthetic responses from Playwright, never from the app runtime.
test.describe.configure({ mode: "serial" });

type Guard = { external: string[]; mutations: string[]; errors: string[]; fixtures: boolean };
const guards = new WeakMap<BrowserContext, Guard>();
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
const accounts = fixtureAccounts();
const instances = fixtureInstances();
const samples: DashboardData = {
  accounts,
  instances,
  jobs: fixtureJobs(),
  activity: fixtureActivity(),
  totals: {
    accounts: accounts.length,
    instances: instances.length,
    running: instances.filter((item) => item.state === "RUNNING").length,
    stopped: instances.filter((item) => item.state === "STOPPED").length,
    storageGb: instances.reduce(
      (sum, instance) =>
        sum + instance.bootVolumes.reduce((total, volume) => total + volume.sizeGb, 0),
      0,
    ),
    regions: new Set(instances.map((item) => item.region)).size,
  },
};

function localOrigin(value: string | undefined) {
  const url = new URL(value || "http://localhost:6240");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Smoke tests only support a localhost OCI Dash server.");
  }
  return url.origin;
}

async function guardNetwork(context: BrowserContext, origin: string, allowSetup = false) {
  const guard: Guard = { external: [], mutations: [], errors: [], fixtures: true };
  guards.set(context, guard);
  context.on("page", (page) => page.on("pageerror", (error) => guard.errors.push(error.message)));
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin && url.protocol !== "data:") {
      guard.external.push(`${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    const path = url.pathname;
    const method = request.method();
    const json = (value: unknown) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
    if (path.startsWith("/api/") && !path.startsWith("/api/auth/")) {
      if (
        !guard.fixtures &&
        (method === "GET" || (method === "POST" && path === "/api/inventory/refresh"))
      ) {
        await route.continue();
        return;
      }
      if (guard.fixtures) {
        if (["GET", "POST"].includes(method) && path.startsWith("/api/analytics/")) {
          const query = Object.fromEntries(url.searchParams);
          if (path === "/api/analytics/traffic")
            return json(fixtureTrafficReport(parseTrafficQuery(query)));
          if (path === "/api/analytics/costs")
            return json(fixtureCostReport(parseCostQuery(query)));
          if (path === "/api/analytics/cpu") return json(fixtureCpuReport(query.accountId));
        }
        if (method === "POST" && path === "/api/inventory/refresh")
          return json({
            jobs: [],
            accounts: accounts.map((account) => ({
              accountId: account.id,
              status: "fresh",
              jobId: null,
              lastSyncedAt: account.lastSyncAt,
              nextRefreshAt: null,
            })),
          });
        if (method === "GET") {
          if (path === "/api/dashboard") return json(samples);
          if (path === "/api/accounts") return json({ accounts, syncJobs: [] });
          if (path === "/api/instances") return json({ instances });
          if (path === "/api/jobs") return json(jobPageFixture(samples.jobs, url.searchParams));
          if (path === "/api/settings")
            return json({
              username: process.env.ADMIN_USERNAME,
              mfaEnabled: false,
              version: "test",
              worker: { alive: true, lastSeenAt: new Date().toISOString(), runningJobs: 0 },
            });
          const instanceMatch = /^\/api\/instances\/([^/]+)(?:\/(metrics|security))?$/.exec(path);
          if (instanceMatch) {
            const instance = instances.find(
              (item) => item.id === decodeURIComponent(instanceMatch[1]),
            );
            if (instance) {
              if (instanceMatch[2] === "metrics")
                return json(
                  fixtureMetrics((url.searchParams.get("range") || "1h") as "1h" | "24h" | "7d"),
                );
              if (instanceMatch[2] === "security") return json({ groups: fixtureSecurity() });
              return json({ instance });
            }
          }
          const jobMatch = /^\/api\/jobs\/([^/]+)$/.exec(path);
          if (jobMatch) {
            const job = samples.jobs.find((item) => item.id === decodeURIComponent(jobMatch[1]));
            if (job) return json({ job, events: fixtureEvents(job.id) });
          }
        }
      }
      guard.mutations.push(`Unexpected API request: ${method} ${path}`);
      await route.abort();
      return;
    }
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
      !["/api/auth/login", "/api/auth/logout"].includes(url.pathname) &&
      !(allowSetup && method === "POST" && path === "/api/auth/setup")
    ) {
      guard.mutations.push(`${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
}

async function requireTestSession(context: BrowserContext, origin: string) {
  const response = await context.request.get(`${origin}/api/auth/me`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { user: SessionUser };
  expect(body.user.username).toBe(process.env.ADMIN_USERNAME);
  expect(body).not.toHaveProperty("demo");
}

async function requireEmptyServer(context: BrowserContext, origin: string) {
  // APIRequestContext bypasses browser route fixtures, checking the actual database.
  for (const [path, field] of [
    ["accounts", "accounts"],
    ["instances", "instances"],
    ["jobs", "jobs"],
  ]) {
    const response = await context.request.get(`${origin}/api/${path}`);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body[field]).toEqual([]);
    expect(body).not.toHaveProperty("demo");
  }
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  // This owned server is empty; populated browser screens contain only fixtures.
  if (process.env.E2E_SCREENSHOTS === "1") {
    await page.screenshot({
      path: testInfo.outputPath(`${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
  }
}

async function instancePage(page: Page) {
  const instance =
    samples.instances.find((item) => item.displayName === "SG-Oracle-02") || samples.instances[0];
  expect(instance).toBeTruthy();
  await page.goto(`/instances/${encodeURIComponent(instance.id)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(instance.displayName);
  return instance;
}

test.beforeAll(async ({ browser, baseURL }) => {
  const run = process.env.E2E_ISOLATED_RUN || "";
  if (
    !/^oci-dash-e2e-[a-f0-9-]{36}$/.test(run) ||
    process.env.ADMIN_USERNAME !== run.slice("oci-dash-".length)
  )
    throw new Error(
      "Run this suite through npm run test:e2e:isolated with its fresh test administrator.",
    );
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "Inject ADMIN_PASSWORD for the isolated test administrator before running E2E tests.",
    );
  const origin = localOrigin(baseURL);
  const context = await browser.newContext({
    baseURL: origin,
    locale: "zh-CN",
  });
  await guardNetwork(context, origin, true);
  try {
    const initialStatus = await context.request.get(`${origin}/api/auth/status`);
    expect(initialStatus.status()).toBe(200);
    expect(await initialStatus.json()).toEqual({ setupRequired: true });
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "创建管理员", exact: true })).toBeVisible();
    await expect(page.locator(".brand")).toContainText("OCI Dash");
    // Avoid including a credential-bearing Playwright fill call in a failure log.
    try {
      await page.getByLabel(/^用户名/).fill(process.env.ADMIN_USERNAME || "admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
      await page.getByLabel("确认密码", { exact: true }).fill(password);
    } catch {
      throw new Error("Could not fill the local administrator setup fields.");
    }
    await page.getByRole("button", { name: "创建管理员", exact: true }).click();
    await page.waitForURL("**/overview");
    const initializedStatus = await context.request.get(`${origin}/api/auth/status`);
    expect(initializedStatus.status()).toBe(200);
    expect(await initializedStatus.json()).toEqual({ setupRequired: false });
    await requireTestSession(context, origin);
    // Verify the new administrator can sign in through the existing login flow,
    // then share only that fresh session with the later serial smoke tests.
    const logout = await context.request.post(`${origin}/api/auth/logout`, {
      headers: { Origin: origin },
    });
    expect(logout.status()).toBe(200);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "创建管理员", exact: true })).toHaveCount(0);
    try {
      await page.getByLabel("用户名", { exact: true }).fill(process.env.ADMIN_USERNAME || "admin");
      await page.getByLabel("密码", { exact: true }).fill(password);
    } catch {
      throw new Error("Could not fill the local administrator login fields.");
    }
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/overview");
    await requireTestSession(context, origin);
    await requireEmptyServer(context, origin);
    const response = await context.request.get(`${origin}/api/dashboard`);
    expect(response.status()).toBe(200);
    const empty = (await response.json()) as DashboardData;
    expect(empty.instances).toEqual([]);
    expect(empty.accounts).toEqual([]);
    expect(empty.totals).toEqual({
      accounts: 0,
      instances: 0,
      running: 0,
      stopped: 0,
      storageGb: 0,
      regions: 0,
    });
    expect(empty).not.toHaveProperty("demo");
    cookies = await context.cookies();
    expect(guards.get(context)?.mutations).toEqual([]);
    expect(guards.get(context)?.external).toEqual([]);
    expect(guards.get(context)?.errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test.afterAll(async ({ browser, baseURL }) => {
  if (!cookies.length) return;
  const origin = localOrigin(baseURL);
  const context = await browser.newContext({ baseURL: origin });
  try {
    await context.addCookies(cookies);
    // Also remove the test session when an earlier serial test fails and skips
    // the logout test. This is the only cleanup write, and never affects OCI.
    await context.request
      .post(`${origin}/api/auth/logout`, {
        headers: { Origin: origin },
        timeout: 5000,
      })
      .catch(() => undefined);
  } finally {
    cookies = [];
    await context.close();
  }
});

test.beforeEach(async ({ context, baseURL }) => {
  const origin = localOrigin(baseURL);
  await guardNetwork(context, origin);
  await context.addCookies(cookies);
  await requireTestSession(context, origin);
});

test.afterEach(async ({ context }) => {
  const guard = guards.get(context);
  expect(
    guard?.mutations,
    "All cloud and configuration calls must be intercepted by test fixtures",
  ).toEqual([]);
  expect(guard?.external, "No external service should be contacted").toEqual([]);
  expect(guard?.errors, "The page should not raise uncaught JavaScript errors").toEqual([]);
});

test("全新数据库显示添加账号引导，不填充示例资源", async ({ page, context, baseURL }) => {
  guards.get(context)!.fixtures = false;
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "添加账号后查看用量" })).toBeVisible();
  await expect(page.locator(".overview-panel")).toHaveCount(0);
  await page.goto("/settings/accounts");
  await expect(page.getByRole("heading", { name: "添加你的第一个 OCI 账号" })).toBeVisible();
  await expect(page.locator(".account-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "添加账号", exact: true }).first()).toBeEnabled();
  await page.goto("/instances");
  await expect(page.getByRole("heading", { name: "还没有实例资源" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建实例", exact: true })).toBeDisabled();
  await requireEmptyServer(context, localOrigin(baseURL));
});

test("数据总览展示用量摘要与四个统计面板", async ({ page }, testInfo) => {
  await page.goto("/overview");
  await test.step("用量摘要和统计面板加载完成", async () => {
    await expect(page.getByRole("heading", { name: "数据总览" })).toBeVisible();
    await expect(page.locator(".overview-summary")).toHaveCount(3);
    await expect(page.locator('.overview-summary-value[aria-busy="false"]')).toHaveCount(3);
    for (const name of ["发送流量", "接收流量", "平均 CPU"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect(page.locator(".overview-panel")).toHaveCount(4);
    for (const name of ["收发流量趋势", "实例流量排行", "实例负载", "费用走势"]) {
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("img", { name: "每日发送与接收流量，单位 GiB" })).toBeVisible();
    await expect(page.getByRole("list", { name: "实例流量排行" })).toBeVisible();
    await expect(page.getByRole("grid", { name: "最近 24 小时 CPU 热力图" })).toBeVisible();
    await expect(page.getByRole("img", { name: /^每日服务费用，币种 / })).toBeVisible();
    await expect(page.getByText("演示环境 · 只读", { exact: true })).toHaveCount(0);
  });
  await test.step("总览时间范围可以切换", async () => {
    const range = page.locator(".data-overview .page-heading p");
    const previous = await range.innerText();
    await page.getByLabel("总览时间范围", { exact: true }).selectOption("30d");
    await expect(range).not.toHaveText(previous);
    await expect(page.getByRole("img", { name: "每日发送与接收流量，单位 GiB" })).toBeVisible();
  });
  await capture(page, testInfo, "overview-desktop");
});

test("实例搜索、状态与账号筛选", async ({ page }, testInfo) => {
  await page.goto("/instances");
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  const rows = page.locator(".resource-table tbody tr");
  await expect(rows.first()).toBeVisible();
  await test.step("名称搜索返回正确实例", async () => {
    await page.getByLabel("搜索实例名称、地址或 OCID").fill("SG-Oracle-02");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("SG-Oracle-02");
    await page.getByLabel("搜索实例名称、地址或 OCID").fill("");
  });
  await test.step("停止状态计数和结果一致", async () => {
    await page.getByLabel("筛选状态", { exact: true }).selectOption("STOPPED");
    await expect(rows).toHaveCount(
      samples.instances.filter((item) => item.state === "STOPPED").length,
    );
    await page.getByLabel("筛选状态", { exact: true }).selectOption("");
  });
  await test.step("账号筛选限定资源范围", async () => {
    const account = samples.instances[0].accountId;
    await page.getByLabel("筛选账号").selectOption(account);
    await expect(rows).toHaveCount(
      samples.instances.filter((item) => item.accountId === account).length,
    );
    await page.getByLabel("筛选账号").selectOption("");
  });
  await test.step("已有账号时可进入创建实例", async () => {
    await expect(page.getByRole("button", { name: "创建实例", exact: true })).toBeEnabled();
  });
  await capture(page, testInfo, "instances-desktop");
  await test.step("卡片视图展示同一批实例且没有多选控件", async () => {
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(启动|停止|取消选择)$/ })).toHaveCount(0);
    await page.getByRole("button", { name: "卡片视图", exact: true }).click();
    await expect(page.getByRole("button", { name: "卡片视图", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const cards = page.locator("article.instance-card");
    await expect(cards).toHaveCount(Math.min(10, samples.instances.length));
    await expect(cards.first().locator(".name-link")).toHaveCount(1);
    await expect(page.locator(".resource-table")).toHaveCount(0);
    expect(
      await page
        .locator(".instance-cards")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    const flags = cards.locator('img[src^="/flags/"]');
    await expect(flags).toHaveCount(Math.min(10, samples.instances.length));
    await expect
      .poll(() =>
        flags.evaluateAll((images) =>
          images.every(
            (image) =>
              (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
          ),
        ),
      )
      .toBe(true);
  });
  await capture(page, testInfo, "instances-cards-desktop");
});

test("实例详情六个标签及键盘导航", async ({ page }, testInfo) => {
  await instancePage(page);
  for (const label of ["概览", "监控", "网络", "安全规则", "存储", "任务与活动"]) {
    await test.step(`${label}内容可以加载`, async () => {
      await page.getByRole("tab", { name: label, exact: true }).click();
      await expect(page.getByRole("tabpanel")).toBeVisible();
      if (label === "安全规则")
        await expect(page.getByRole("button", { name: "刷新规则", exact: true })).toBeVisible();
      if (label === "存储")
        await expect(page.getByRole("button", { name: "调整容量与性能" }).first()).toBeEnabled();
      expect(
        (await page.getByRole("alert").allTextContents()).filter((value) => value.trim()),
      ).toEqual([]);
    });
  }
  await test.step("方向键切换标签", async () => {
    await page.getByRole("tab", { name: "概览", exact: true }).click();
    await page.getByRole("tab", { name: "概览", exact: true }).press("ArrowRight");
    await expect(page.getByRole("tab", { name: "监控", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: "监控", exact: true }).press("Home");
    await expect(page.getByRole("tab", { name: "概览", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  await capture(page, testInfo, "instance-overview");
});

test("实例监控摘要分别采用有效采样并按区间计算网络平均速率", async ({ page }) => {
  const timestamp = (minute: number) => new Date(Date.UTC(2026, 10, 9, 12, minute)).toISOString();
  await page.route("**/api/instances/fixture-instance-1/metrics?**", async (route) => {
    const range = new URL(route.request().url()).searchParams.get("range");
    await route.fulfill({
      json: {
        available: true,
        source: "oci",
        intervalSeconds: range === "24h" ? 300 : range === "7d" ? 3600 : 60,
        points: [
          { timestamp: timestamp(0), cpu: 15, receivedBytes: null, sentBytes: null },
          { timestamp: timestamp(1), cpu: null, receivedBytes: 75_000_000, sentBytes: null },
          { timestamp: timestamp(2), cpu: null, receivedBytes: null, sentBytes: 150_000_000 },
        ],
      },
    });
  });
  await instancePage(page);
  const card = (label: string) =>
    page.locator(".metric-card").filter({ has: page.getByText(label, { exact: true }) });
  await expect(card("CPU 使用率").locator(".metric-value")).toHaveText("15%");
  await expect(card("网络接收").locator(".metric-value")).toHaveText("10 Mbps");
  await expect(card("网络发送").locator(".metric-value")).toHaveText("20 Mbps");
  await expect(card("网络接收").locator(".metric-note")).toContainText("1 分钟平均");
  await page.getByLabel("监控时间范围").selectOption("24h");
  await expect(card("CPU 使用率").locator(".metric-value")).toHaveText("15%");
  await expect(card("网络接收").locator(".metric-value")).toHaveText("2 Mbps");
  await expect(card("网络发送").locator(".metric-value")).toHaveText("4 Mbps");
  await expect(card("网络接收").locator(".metric-note")).toContainText("5 分钟平均");
});

test("离开实例监控时取消无人使用的查询", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false,
    aborted = false;
  const path = "/api/instances/fixture-instance-1/metrics";
  page.on("requestfailed", (request) => {
    if (new URL(request.url()).pathname === path) aborted = true;
  });
  await page.route(`**${path}?**`, async (route) => {
    requested = true;
    await gate;
    await route.fulfill({
      json: { points: [], intervalSeconds: 60, available: false, source: "oci" },
    });
  });
  try {
    await instancePage(page);
    await expect.poll(() => requested).toBe(true);
    await page.getByRole("tab", { name: "网络", exact: true }).click();
    await expect.poll(() => aborted).toBe(true);
    await expect(page.getByRole("tabpanel")).toBeVisible();
  } finally {
    release();
  }
});

test("公网地址保护", async ({ page }, testInfo) => {
  const selected = await instancePage(page);
  await test.step("网络详情展示完整绑定与保护标记", async () => {
    await page.getByRole("tab", { name: "网络", exact: true }).click();
    await expect(page.getByText("保留公网 IP", { exact: true })).toBeVisible();
    await expect(page.getByText("受保护", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "更换 IP", exact: true })).toHaveCount(0);
    const addresses = selected.vnics
      .flatMap((vnic) => vnic.privateIps)
      .filter((binding) => binding.publicIp);
    expect(addresses).toHaveLength(2);
    for (const binding of addresses) {
      await page
        .getByRole("button", { name: `查看 IP ${binding.publicIp} 详情`, exact: true })
        .click();
      const details = page.getByRole("dialog", { name: "IP 详情", exact: true });
      const replace = details.getByRole("button", { name: "更换公网 IP", exact: true });
      if (binding.lifetime === "EPHEMERAL" && !binding.protected)
        await expect(replace).toBeEnabled();
      else await expect(replace).toBeDisabled();
      await details.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(details).toHaveCount(0);
    }
    await expect(page.getByRole("button", { name: "分配 IPv6", exact: true })).toBeEnabled();
  });
  await capture(page, testInfo, "instance-network");
});

test("账号列表完成加载且凭据操作可用", async ({ page }, testInfo) => {
  await page.goto("/settings/accounts");
  await expect(page.locator(".account-card")).toHaveCount(samples.accounts.length);
  await expect(page.getByRole("button", { name: "添加账号", exact: true })).toBeEnabled();
  for (const name of ["刷新资源", "编辑", "移除"]) {
    await test.step(`${name}按钮可用`, async () => {
      for (const button of await page.getByRole("button", { name, exact: true }).all())
        await expect(button).toBeEnabled();
    });
  }
  await capture(page, testInfo, "accounts");
});

test("任务详情展示状态与事件历史", async ({ page }, testInfo) => {
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看详情", exact: true }).first().click();
  await expect(page.getByRole("heading", { name: "执行日志", exact: true })).toBeVisible();
  await expect(page.locator(".timeline-item").first()).toBeVisible();
  await capture(page, testInfo, "task-detail");
});

test("主题切换持久化且安全设置可用", async ({ page }, testInfo) => {
  await page.goto("/settings/general");
  await test.step("启用深色主题", async () => {
    await page.getByRole("button", { name: "深色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await capture(page, testInfo, "settings-dark");
  });
  await test.step("刷新后保留主题偏好", async () => {
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
  await page
    .getByRole("navigation", { name: "设置分区" })
    .getByRole("link", { name: "登录安全", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/security$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("设置");
  await expect(page.getByRole("button", { name: "修改密码", exact: true })).toBeEnabled();
  await capture(page, testInfo, "settings-security");
});

test("390px 小屏导航与实例表格和卡片均不撑宽页面", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "数据总览" })).toBeVisible();
  await expect(page.locator(".overview-summary")).toHaveCount(3);
  await test.step("侧栏默认隐藏且不接受焦点", async () => {
    await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
    const width = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
    await capture(page, testInfo, "overview-mobile");
  });
  await test.step("展开导航并进入实例页", async () => {
    await page.getByRole("button", { name: "展开导航", exact: true }).click();
    await expect(page.getByRole("button", { name: "展开导航", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.locator(".sidebar nav").getByRole("link", { name: "实例", exact: true }).click();
    await page.getByRole("button", { name: "表格视图", exact: true }).click();
    await expect(page.locator(".resource-table tbody tr").first()).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  });
  await test.step("宽表格只在自身容器内横向滚动", async () => {
    const width = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
    const table = await page.locator(".table-scroll").evaluate((element) => ({
      visible: element.clientWidth,
      content: element.scrollWidth,
    }));
    expect(table.content).toBeGreaterThan(table.visible);
    await capture(page, testInfo, "instances-mobile");
  });
  await test.step("卡片在小屏使用网格布局且不横向溢出", async () => {
    await page.getByRole("button", { name: "卡片视图", exact: true }).click();
    await expect(page.locator("article.instance-card")).toHaveCount(
      Math.min(10, samples.instances.length),
    );
    await expect(page.getByRole("checkbox")).toHaveCount(0);
    const dimensions = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      cardWidths: [...document.querySelectorAll("article.instance-card")].map(
        (element) => element.getBoundingClientRect().width,
      ),
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
    expect(dimensions.cardWidths.every((width) => width <= dimensions.viewport)).toBe(true);
    expect(
      await page
        .locator(".instance-cards")
        .evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    await capture(page, testInfo, "instances-cards-mobile");
  });
});

// Last in the serial suite: this invalidates the in-memory shared test session.
test("退出后受保护页面和 API 要求重新登录", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "数据总览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.waitForURL("**/login");
  await page.goto("/instances");
  await page.waitForURL("**/login");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  const response = await page.request.get("/api/auth/me");
  expect(response.status()).toBe(401);
});
