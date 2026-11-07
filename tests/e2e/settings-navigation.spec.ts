import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import type { SettingsResult } from "../../src/lib/settings-contracts";

// All APIs and sockets are intercepted. The local server serves only pages,
// RSC navigation responses, and assets; no real setting or cloud write is made.
const sections = [
  { path: "/settings/accounts", label: "OCI 账号" },
  { path: "/settings/security", label: "登录安全" },
  { path: "/settings/general", label: "通用" },
] as const;
const appPaths = new Set([
  "/accounts",
  "/settings",
  "/overview",
  "/instances",
  "/traffic",
  "/costs",
  "/tasks",
  ...sections.map(({ path }) => path),
]);
const test = base.extend<{ isolatedApi: undefined }>({
  isolatedApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL || "http://localhost:3000").origin;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
        throw new Error("Settings navigation tests require an isolated localhost server.");
      const unexpected: string[] = [];
      const errors: string[] = [];
      const track = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
      context.pages().forEach(track);
      context.on("page", track);
      await context.routeWebSocket("**/*", (socket) => {
        if (!new URL(socket.url()).pathname.includes("webpack-hmr"))
          unexpected.push("WS " + socket.url());
        socket.close();
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const path = url.pathname;
        const json = (body: unknown) => route.fulfill({ status: 200, json: body });
        if (url.origin === origin && method === "GET") {
          if (path === "/api/auth/me")
            return json({
              user: { id: "settings-navigation-user", username: "fixture", mfaEnabled: false },
              demo: true,
            });
          if (path === "/api/accounts") return json({ accounts: [], syncJobs: [], demo: true });
          if (path === "/api/instances") return json({ instances: [], demo: true });
          if (path === "/api/jobs") return json({ jobs: [], demo: true });
          if (path === "/api/settings") {
            const body: SettingsResult = {
              username: "fixture",
              mfaEnabled: false,
              demo: true,
              version: "navigation-fixture",
              worker: { alive: true, lastSeenAt: "2026-11-08T00:00:00Z", runningJobs: 0 },
            };
            return json(body);
          }
          // Unlike the isolated form test, allow RSC responses for actual Link,
          // redirect, refresh, and browser-history behavior.
          if (
            appPaths.has(path) ||
            path.startsWith("/_next/") ||
            path === "/favicon.ico" ||
            path === "/icon.svg"
          )
            return route.continue();
        }
        unexpected.push(`${method} ${url.origin}${path}`);
        return route.abort();
      });
      await use(undefined);
      expect(unexpected, "Unknown API requests, writes, and external traffic are blocked").toEqual(
        [],
      );
      expect(errors, "Navigation must not cause uncaught JavaScript errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

async function capture(page: Page, info: TestInfo, name: string) {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}

async function currentSection(page: Page, path: string) {
  await expect(page).toHaveURL((url) => url.pathname === path);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("设置");
  const navigation = page.getByRole("navigation", { name: "设置分区", exact: true });
  await expect(navigation.getByRole("link")).toHaveText(sections.map(({ label }) => label));
  await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
  for (const section of sections) {
    const link = navigation.getByRole("link", { name: section.label, exact: true });
    await expect(link).toHaveAttribute("href", section.path);
    if (section.path === path) await expect(link).toHaveAttribute("aria-current", "page");
    else await expect(link).not.toHaveAttribute("aria-current", "page");
  }
  await expect(page.locator(".sidebar-settings")).toHaveAttribute("aria-current", "page");
  if (path === "/settings/accounts") {
    await expect(page.getByRole("region", { name: "OCI 账号", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "添加你的第一个 OCI 账号" })).toBeVisible();
  } else if (path === "/settings/security") {
    await expect(
      page.getByRole("heading", { level: 2, name: "登录安全", exact: true }),
    ).toBeVisible();
  } else {
    await expect(page.getByRole("heading", { name: "外观", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "运行状态", exact: true })).toBeVisible();
  }
}

async function primaryNavigation(page: Page) {
  const navigation = page.getByRole("navigation", { name: "主导航", exact: true });
  await expect(navigation.getByRole("link")).toHaveText(["总览", "实例", "流量", "成本", "任务"]);
  await expect(navigation.getByRole("link", { name: /账号/ })).toHaveCount(0);
  await expect(navigation.locator('a[href="/accounts"], a[href="/settings/accounts"]')).toHaveCount(
    0,
  );
}

test("旧账号链接与设置入口均重定向到 OCI 账号分区", async ({ page }) => {
  for (const legacy of ["/accounts", "/settings"]) {
    await test.step(legacy, async () => {
      await page.goto(legacy);
      await currentSection(page, "/settings/accounts");
      await primaryNavigation(page);
    });
  }
});

test("设置三个深链接刷新后保留当前分区与单一页面标题", async ({ page }, info) => {
  for (const { path } of sections) {
    await test.step(path, async () => {
      await page.goto(path);
      await currentSection(page, path);
      await page.reload();
      await currentSection(page, path);
      await capture(page, info, `settings-${path.split("/").at(-1)}-desktop`);
    });
  }
});

test("分区链接和浏览器前进后退同步当前态", async ({ page }) => {
  await page.goto("/settings/accounts");
  await currentSection(page, "/settings/accounts");
  const navigation = page.getByRole("navigation", { name: "设置分区", exact: true });
  await navigation.getByRole("link", { name: "登录安全", exact: true }).click();
  await currentSection(page, "/settings/security");
  await navigation.getByRole("link", { name: "通用", exact: true }).click();
  await currentSection(page, "/settings/general");
  for (const path of ["/settings/security", "/settings/accounts"]) {
    await page.goBack();
    await currentSection(page, path);
  }
  for (const path of ["/settings/security", "/settings/general"]) {
    await page.goForward();
    await currentSection(page, path);
  }
});

test("移动导航通过底部设置进入分区，切换后页面不溢出", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/overview");
  await expect(page.getByRole("heading", { level: 1, name: "数据总览" })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await primaryNavigation(page);
  const settings = page
    .getByRole("dialog", { name: "主导航", exact: true })
    .getByRole("link", { name: "设置", exact: true });
  await expect(settings).not.toHaveAttribute("aria-current", "page");
  await settings.click();
  await currentSection(page, "/settings/accounts");
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await capture(page, info, "settings-accounts-mobile");
  await page
    .getByRole("navigation", { name: "设置分区", exact: true })
    .getByRole("link", { name: "登录安全", exact: true })
    .click();
  await currentSection(page, "/settings/security");
  await capture(page, info, "settings-security-mobile");
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  await expect(settings).toHaveAttribute("aria-current", "page");
  await primaryNavigation(page);
  await capture(page, info, "settings-navigation-mobile");
  await page.keyboard.press("Escape");
  await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
  await expect(page.getByRole("button", { name: "展开导航", exact: true })).toBeFocused();
  await page
    .getByRole("navigation", { name: "设置分区", exact: true })
    .getByRole("link", { name: "通用", exact: true })
    .click();
  await currentSection(page, "/settings/general");
  await capture(page, info, "settings-general-mobile");
});

test("空账号时总览、实例、流量和成本的引导都进入新账号路径", async ({ page }) => {
  for (const path of ["/overview", "/instances", "/traffic", "/costs"]) {
    await test.step(path, async () => {
      await page.goto(path);
      const guide = page.getByRole("main").getByRole("link", {
        name: path === "/overview" ? "添加账号" : "管理账号",
        exact: true,
      });
      await expect(guide).toHaveAttribute("href", "/settings/accounts");
      await guide.click();
      await currentSection(page, "/settings/accounts");
    });
  }
});
