import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { DashboardData, SessionUser } from "../../src/lib/contracts";

// This suite deliberately uses an existing, local demo server. It never starts
// services, reads a personal .env file, or submits a cloud/configuration mutation.
test.describe.configure({ mode: "serial" });

type Guard = { external: string[]; mutations: string[]; errors: string[] };
const guards = new WeakMap<BrowserContext, Guard>();
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
let demo: DashboardData;

function localOrigin(value: string | undefined) {
  const url = new URL(value || "http://localhost:3000");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Smoke tests only support a localhost OCI Dash server.");
  }
  return url.origin;
}

async function guardNetwork(context: BrowserContext, origin: string) {
  const guard: Guard = { external: [], mutations: [], errors: [] };
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
    if (
      !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
      !["/api/auth/login", "/api/auth/logout"].includes(url.pathname)
    ) {
      guard.mutations.push(`${request.method()} ${url.pathname}`);
      await route.abort();
      return;
    }
    await route.continue();
  });
}

async function requireDemo(context: BrowserContext, origin: string) {
  const response = await context.request.get(`${origin}/api/auth/me`);
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { user: SessionUser; demo: boolean };
  if (body.demo !== true) throw new Error("This readonly smoke suite requires demo=true.");
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  // beforeEach has already verified demo=true. Screenshots remain opt-in and
  // contain only demonstration resources, never login values or session tokens.
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
    demo.instances.find((item) => item.displayName === "SG-Oracle-02") || demo.instances[0];
  expect(instance).toBeTruthy();
  await page.goto(`/instances/${encodeURIComponent(instance.id)}`);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(instance.displayName);
  return instance;
}

test.beforeAll(async ({ browser, baseURL }) => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password)
    throw new Error(
      "Inject ADMIN_PASSWORD for the local demo administrator before running E2E tests.",
    );
  const origin = localOrigin(baseURL);
  const context = await browser.newContext({
    baseURL: origin,
    locale: "zh-CN",
  });
  await guardNetwork(context, origin);
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    await expect(page.locator(".brand")).toContainText("OCI Dash");
    // Avoid including a credential-bearing Playwright fill call in a failure log.
    try {
      await page.getByLabel(/^用户名/).fill(process.env.ADMIN_USERNAME || "admin");
      await page.getByLabel(/^密码/).fill(password);
    } catch {
      throw new Error("Could not fill the local administrator login fields.");
    }
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await page.waitForURL("**/overview");
    await requireDemo(context, origin);
    const response = await context.request.get(`${origin}/api/dashboard`);
    expect(response.status()).toBe(200);
    demo = (await response.json()) as DashboardData;
    expect(demo.demo).toBe(true);
    expect(demo.instances.length).toBeGreaterThan(0);
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
  await requireDemo(context, origin);
});

test.afterEach(async ({ context }) => {
  const guard = guards.get(context);
  expect(
    guard?.mutations,
    "The UI must never submit cloud/configuration writes in demo mode",
  ).toEqual([]);
  expect(guard?.external, "No external service should be contacted").toEqual([]);
  expect(guard?.errors, "The page should not raise uncaught JavaScript errors").toEqual([]);
});

test("总览展示资源指标与动态监控", async ({ page }, testInfo) => {
  await page.goto("/overview");
  await test.step("总览和四项指标加载完成", async () => {
    await expect(page.getByRole("heading", { name: "资源总览" })).toBeVisible();
    await expect(page.locator(".metric-card")).toHaveCount(4);
    await expect(page.locator(".metric-card").first()).toContainText(String(demo.totals.instances));
    await expect(page.getByText("演示环境 · 只读", { exact: true })).toBeVisible();
  });
  await test.step("监控时间范围可以切换", async () => {
    await page.getByLabel("监控时间范围").selectOption("7d");
    await expect(page.getByRole("img", { name: "CPU 使用率时间趋势" })).toBeVisible();
    await expect(page.getByRole("img", { name: "CPU 使用率时间趋势" })).toContainText(
      /\d{2}\/\d{2}/,
    );
  });
  await capture(page, testInfo, "overview-desktop");
});

test("实例搜索、状态与账号筛选", async ({ page }, testInfo) => {
  await page.goto("/instances");
  const rows = page.locator(".resource-table tbody tr");
  await expect(rows.first()).toBeVisible();
  await test.step("名称搜索返回正确实例", async () => {
    await page.getByLabel("搜索实例名称、地址或 OCID").fill("SG-Oracle-02");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("SG-Oracle-02");
    await page.getByLabel("搜索实例名称、地址或 OCID").fill("");
  });
  await test.step("停止状态计数和结果一致", async () => {
    await page.getByRole("button", { name: /^已停止/ }).click();
    await expect(rows).toHaveCount(
      demo.instances.filter((item) => item.state === "STOPPED").length,
    );
    await page.getByRole("button", { name: /^全部实例/ }).click();
  });
  await test.step("账号筛选限定资源范围", async () => {
    const account = demo.instances[0].accountId;
    await page.getByLabel("筛选账号").selectOption(account);
    await expect(rows).toHaveCount(
      demo.instances.filter((item) => item.accountId === account).length,
    );
    await page.getByLabel("筛选账号").selectOption("");
  });
  await test.step("演示环境禁止创建实例", async () => {
    await expect(page.getByRole("button", { name: "创建实例", exact: true })).toBeDisabled();
  });
  await capture(page, testInfo, "instances-desktop");
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
        await expect(page.getByRole("button", { name: "调整容量与性能" }).first()).toBeDisabled();
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

test("连接对话框与公网地址保护", async ({ page }, testInfo) => {
  await instancePage(page);
  await test.step("连接对话框保留焦点并支持 Escape", async () => {
    await page.getByRole("button", { name: "SSH 连接信息", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "SSH 连接信息" })).toBeVisible();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest("dialog")))).toBe(
      true,
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "SSH 连接信息" })).not.toBeVisible();
  });
  await test.step("网络详情展示完整绑定与保护标记", async () => {
    await page.getByRole("tab", { name: "网络", exact: true }).click();
    await expect(page.getByText("保留公网 IP", { exact: true })).toBeVisible();
    await expect(page.getByText("受保护", { exact: true })).toBeVisible();
    const rotations = page.getByRole("button", {
      name: "更换 IP",
      exact: true,
    });
    expect(await rotations.count()).toBeGreaterThan(0);
    for (const button of await rotations.all()) await expect(button).toBeDisabled();
    await expect(page.getByRole("button", { name: "分配 IPv6", exact: true })).toBeDisabled();
  });
  await capture(page, testInfo, "instance-network");
});

test("账号列表完成加载且凭据操作只读", async ({ page }, testInfo) => {
  await page.goto("/accounts");
  await expect(page.locator(".account-card")).toHaveCount(demo.accounts.length);
  await expect(page.getByRole("button", { name: "添加账号", exact: true })).toBeDisabled();
  for (const name of ["刷新资源", "编辑", "移除"]) {
    await test.step(`${name}按钮在演示模式禁用`, async () => {
      for (const button of await page.getByRole("button", { name, exact: true }).all())
        await expect(button).toBeDisabled();
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

test("主题切换持久化且安全设置只读", async ({ page }, testInfo) => {
  await page.goto("/settings");
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
  await expect(page.getByRole("button", { name: "修改密码", exact: true })).toBeDisabled();
});

test("390px 小屏导航与已加载的实例表格不撑宽页面", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overview");
  await expect(page.locator(".metric-card")).toHaveCount(4);
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
});

// Last in the serial suite: this invalidates the in-memory shared test session.
test("退出后受保护页面和 API 要求重新登录", async ({ page }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "资源总览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await page.waitForURL("**/login");
  await page.goto("/instances");
  await page.waitForURL("**/login");
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  const response = await page.request.get("/api/auth/me");
  expect(response.status()).toBe(401);
});
