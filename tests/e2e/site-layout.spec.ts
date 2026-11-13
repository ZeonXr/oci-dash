import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { SettingsResult } from "../../src/lib/settings-contracts";
import { fixtureAccounts, fixtureInstances, fixtureJobs } from "../fixtures/seed-data";
import { jobPageFixture } from "../fixtures/job-page";

const widths = [639, 640, 767, 768, 1023, 1024, 1279, 1280];
const accounts = fixtureAccounts().slice(0, 3);
const instances = fixtureInstances().slice(0, 3);
const jobs = fixtureJobs();

const test = base.extend<{ siteApi: { authenticated: boolean } }>({
  siteApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const state = { authenticated: true };
      const unexpected: string[] = [];
      const errors: string[] = [];
      const track = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
      context.pages().forEach(track);
      context.on("page", track);
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push("WS " + socket.url());
        socket.close();
      });
      // Only application documents and assets reach the isolated server.
      // All APIs, writes, sockets and external requests are intercepted.
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
        const json = (body: unknown) => route.fulfill({ json: body });
        if (method === "GET") {
          if (url.pathname === "/api/auth/status") return json({ setupRequired: true });
          if (url.pathname === "/api/auth/me")
            return json({
              user: state.authenticated
                ? { id: "site-layout-user", username: "Layout fixture", mfaEnabled: false }
                : null,
            });
          if (url.pathname === "/api/accounts") return json({ accounts, syncJobs: [] });
          if (url.pathname === "/api/instances") return json({ instances });
          if (url.pathname === "/api/jobs") return json(jobPageFixture(jobs, url.searchParams));
          if (url.pathname === "/api/settings") {
            const settings: SettingsResult = {
              username: "Layout fixture",
              mfaEnabled: false,
              version: "layout-fixture",
              worker: { alive: true, lastSeenAt: accounts[0]!.lastSyncAt, runningJobs: 0 },
            };
            return json(settings);
          }
        }
        if (method === "POST" && url.pathname === "/api/inventory/refresh")
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
        unexpected.push(method + " " + url.pathname);
        return route.abort();
      });
      await use(state);
      expect(unexpected, "No unmocked API, external request or WebSocket may escape").toEqual([]);
      expect(errors, "Layout changes must not raise browser errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

async function noPageOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

async function insideViewport(control: Locator) {
  const box = await control.boundingBox();
  const viewport = control.page().viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
}

test("实例、任务和账号页面跨标准断点时保持内容与导航可用", async ({ page }, info) => {
  for (const path of ["/instances", "/tasks", "/settings/accounts"]) {
    await page.goto(path);
    await expect(page.locator("#main-content")).toBeVisible();
    if (path === "/instances") await expect(page.getByRole("article")).toHaveCount(3);
    if (path === "/tasks") await expect(page.locator(".task-table tbody tr")).toHaveCount(3);
    if (path === "/settings/accounts") await expect(page.locator(".account-card")).toHaveCount(3);
    for (const width of widths) {
      await test.step(`${path} at ${width}`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await noPageOverflow(page);
        const navigation = page.locator("#primary-navigation");
        const trigger = page.getByRole("button", { name: "展开导航", exact: true });
        if (width >= 1024) {
          await expect(navigation).toBeVisible();
          await expect(trigger).not.toBeVisible();
        } else {
          await expect(navigation).not.toBeVisible();
          await expect(trigger).toBeVisible();
        }
        if (process.env.E2E_SCREENSHOTS === "1" && [640, 1024, 1280].includes(width))
          await page.screenshot({
            path: info.outputPath(`site-${path.split("/").at(-1)}-${width}.png`),
            fullPage: true,
            animations: "disabled",
          });
      });
    }
  }
});

test("放大根字号的暗色短屏中弹窗只滚动内容，切换导航边界恢复焦点", async ({ page }, info) => {
  await page.setViewportSize({ width: 639, height: 480 });
  await page.goto("/settings/accounts");
  await expect(page.locator(".account-card")).toHaveCount(3);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
    document.documentElement.dataset.theme = "dark";
  });
  await noPageOverflow(page);
  const trigger = page.getByRole("button", { name: "添加账号", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加 OCI 账号", exact: true });
  await expect(dialog).toBeVisible();
  await insideViewport(dialog);
  const dimensions = await dialog.evaluate((element) => {
    const header = element.querySelector('[data-slot="dialog-header"]')!;
    const body = element.querySelector('[data-slot="dialog-body"]')!;
    const footer = element.querySelector('[data-slot="dialog-footer"]')!;
    return {
      headerBottom: header.getBoundingClientRect().bottom,
      bodyTop: body.getBoundingClientRect().top,
      bodyBottom: body.getBoundingClientRect().bottom,
      footerTop: footer.getBoundingClientRect().top,
      scrollHeight: body.scrollHeight,
      clientHeight: body.clientHeight,
    };
  });
  expect(Math.abs(dimensions.headerBottom - dimensions.bodyTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(dimensions.bodyBottom - dimensions.footerTop)).toBeLessThanOrEqual(1);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  await insideViewport(dialog.locator('[data-slot="dialog-header"]'));
  await insideViewport(dialog.locator('[data-slot="dialog-footer"]'));
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath("site-dialog-dark-large-text.png"),
      animations: "disabled",
    });
  await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 1023, height: 800 });
  const menu = page.getByRole("button", { name: "展开导航", exact: true });
  await menu.click();
  const sheet = page.getByRole("dialog", { name: "主导航", exact: true });
  await expect(sheet).toBeVisible();
  await page.setViewportSize({ width: 1024, height: 800 });
  await expect(sheet).not.toBeVisible();
  await expect(page.locator("#primary-navigation .sidebar-settings")).toBeFocused();
  await expect(menu).not.toBeVisible();
  await noPageOverflow(page);
});

test("首次设置表单跨断点和放大字号后保持输入与操作可见", async ({ page, siteApi }, info) => {
  siteApi.authenticated = false;
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "创建管理员", exact: true })).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 800 });
    await noPageOverflow(page);
    if (width >= 1024) await expect(page.getByRole("region", { name: "OCI Dash" })).toBeVisible();
    else await expect(page.getByRole("region", { name: "OCI Dash" })).not.toBeVisible();
  }
  await page.setViewportSize({ width: 639, height: 480 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "20px";
    document.documentElement.dataset.theme = "dark";
  });
  await noPageOverflow(page);
  const submit = page.getByRole("button", { name: "创建管理员", exact: true });
  await submit.scrollIntoViewIfNeeded();
  await insideViewport(submit);
  await expect(page.getByLabel("用户名", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath("site-setup-dark-large-text.png"),
      fullPage: true,
      animations: "disabled",
    });
});
