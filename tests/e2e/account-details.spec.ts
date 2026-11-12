import { expect, test as base, type Page } from "@playwright/test";
import type { AccountSummary } from "../../src/lib/contracts";
import type { AccountDetails } from "../../src/lib/account-details-contracts";

const account: AccountSummary = {
  id: "details-fixture",
  name: "Phoenix fixture-" + "a".repeat(64),
  tenancyId: "ocid1.tenancy.oc1.." + "t".repeat(120),
  userId: "ocid1.user.oc1.." + "u".repeat(120),
  fingerprint: "ab:".repeat(15) + "ab",
  homeRegion: "us-phoenix-1",
  regions: ["us-phoenix-1", "ap-tokyo-1"],
  status: "connected",
  lastSyncAt: "2026-11-09T00:00:00.000Z",
  lastError: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};

function details(): AccountDetails {
  return {
    account,
    inventory: {
      instances: 3,
      running: 2,
      stopped: 1,
      ocpus: 4,
      memoryGb: 12,
      bootVolumeGb: 150,
      publicIps: 4,
      lastSyncedAt: account.lastSyncAt,
      partial: false,
    },
    cloud: {
      tenancy: {
        id: account.tenancyId,
        name: "Fixture tenancy",
        description: "OCI tenancy information",
        homeRegionKey: "NRT",
      },
      user: {
        id: account.userId,
        name: "fixture-user",
        description: "API identity",
        email: "fixture@example.invalid",
        state: "ACTIVE",
        createdAt: account.createdAt,
        mfaActivated: true,
      },
      regions: [
        { name: "us-phoenix-1", key: "PHX", status: "READY", home: false },
        { name: "ap-tokyo-1", key: "NRT", status: "READY", home: true },
        { name: "uk-london-1", key: "LHR", status: "IN_PROGRESS", home: false },
      ],
      errors: [],
      checkedAt: "2026-11-09T00:05:00.000Z",
    },
  };
}

interface Fixture {
  reads: number;
  response: AccountDetails;
  gate?: Promise<void>;
  failNext?: boolean;
}

const test = base.extend<{ detailsApi: Fixture }>({
  detailsApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [],
        errors: string[] = [];
      const state: Fixture = { reads: 0, response: details() };
      const track = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
      context.pages().forEach(track);
      context.on("page", track);
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push("WS " + socket.url());
        socket.close();
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) {
          unexpected.push(request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/") && request.method() === "GET")
          return route.continue();
        const json = (body: unknown) => route.fulfill({ json: body });
        if (request.method() === "GET") {
          if (url.pathname === "/api/auth/me")
            return json({ user: { id: "fixture", username: "admin", mfaEnabled: false } });
          if (url.pathname === "/api/accounts") return json({ accounts: [account], syncJobs: [] });
          if (url.pathname === "/api/instances") return json({ instances: [] });
          if (url.pathname === "/api/jobs") return json({ jobs: [], recentJobs: [] });
          if (url.pathname === `/api/accounts/${account.id}/details`) {
            state.reads++;
            if (state.gate) await state.gate;
            if (state.failNext) {
              state.failNext = false;
              return route.fulfill({
                status: 503,
                json: { error: "Synthetic details unavailable" },
              });
            }
            return json(state.response);
          }
        }
        if (url.pathname === "/api/inventory/refresh" && request.method() === "POST")
          return json({
            jobs: [],
            accounts: [
              {
                accountId: account.id,
                status: "fresh",
                jobId: null,
                lastSyncedAt: account.lastSyncAt,
                nextRefreshAt: null,
              },
            ],
          });
        unexpected.push(request.method() + " " + url.pathname);
        return route.abort();
      });
      await use(state);
      expect(unexpected, "No cloud writes or external requests may escape the fixture").toEqual([]);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test("账号详情按需读取，保留连接配置并展示云身份及区域标签", async ({ page, detailsApi }) => {
  let release!: () => void;
  detailsApi.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as unknown as { copied: string }).copied = value;
        },
      },
    });
  });
  await page.goto("/settings/accounts");
  const trigger = page.getByRole("button", { name: `查看 ${account.name} 详情` });
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText(account.name);
  const card = page.locator(".account-card");
  await expect(card.getByRole("button", { name: "详情", exact: true })).toHaveCount(0);
  await expect(card.getByText("us-phoenix-1", { exact: true })).toHaveCount(1);
  await expect(card.getByText("ap-tokyo-1", { exact: true })).toHaveCount(1);
  await expect(card.getByText("配置主区域", { exact: true })).toHaveCount(0);
  await expect(card.getByText("租户", { exact: true })).toHaveCount(0);
  expect(detailsApi.reads).toBe(0);
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "账号详情", exact: true });
  try {
    await expect(dialog.getByText(account.tenancyId, { exact: true })).toBeVisible();
    await expect(dialog.getByText("正在读取 OCI 账号信息…", { exact: true })).toBeVisible();
    release();
    await expect(dialog.getByText("Fixture tenancy", { exact: true })).toBeVisible();
    await expect(dialog.getByText("fixture@example.invalid", { exact: true })).toBeVisible();
    await expect(
      dialog.getByText("配置主区域", { exact: true }).locator("..").locator("code"),
    ).toHaveText("us-phoenix-1");
    await expect(
      dialog.getByText("OCI 主区域", { exact: true }).locator("..").locator("code"),
    ).toHaveText("ap-tokyo-1");
    await expect(dialog.getByRole("region", { name: "已同步资源", exact: true })).toContainText(
      "2 运行中 · 1 已停止",
    );
    const regions = dialog.getByRole("region", { name: "OCI 已订阅区域", exact: true });
    await expect(regions.locator("code").filter({ hasText: "us-phoenix-1" })).toHaveCount(1);
    await expect(regions.locator("code").filter({ hasText: "uk-london-1" })).toHaveCount(1);
    await expect(regions.getByText("IN_PROGRESS", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "复制Tenancy OCID", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
      .toBe(account.tenancyId);
    // Move off icon tooltips before exercising the containing dialog's Escape handler.
    await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
    await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    release();
  }
});

test("账号详情的局部失败可重试，刷新失败仍保留已取得的信息", async ({ page, detailsApi }) => {
  detailsApi.response.cloud.user = null;
  detailsApi.response.cloud.errors = [{ section: "user", message: "Synthetic user read denied" }];
  detailsApi.response.inventory.partial = true;
  await page.goto("/settings/accounts");
  await page.getByRole("button", { name: `查看 ${account.name} 详情` }).click();
  const dialog = page.getByRole("dialog", { name: "账号详情", exact: true });
  await expect(dialog.getByText("Synthetic user read denied", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Fixture tenancy", { exact: true })).toBeVisible();
  await expect(dialog.getByText("部分资源未更新", { exact: true })).toBeVisible();
  detailsApi.failNext = true;
  await dialog.getByRole("button", { name: "刷新详情", exact: true }).click();
  await expect(dialog.getByText("Synthetic details unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Fixture tenancy", { exact: true })).toBeVisible();
  detailsApi.response = details();
  await dialog.getByRole("button", { name: "重试", exact: true }).click();
  await expect(dialog.getByText("fixture-user", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Synthetic user read denied", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Synthetic details unavailable", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("账号卡片在小屏保持操作间距，名称可通过键盘打开详情并恢复焦点", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/settings/accounts");
  const card = page.locator(".account-card");
  await expect(card).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const remove = card.getByRole("button", { name: "移除", exact: true });
  const edit = card.getByRole("button", { name: "编辑", exact: true });
  const removeBounds = await remove.boundingBox();
  const editBounds = await edit.boundingBox();
  const contentRight = await card.locator('[data-slot="card-content"]').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
  });
  expect(removeBounds).not.toBeNull();
  expect(editBounds).not.toBeNull();
  expect(Math.abs(removeBounds!.x + removeBounds!.width - contentRight)).toBeLessThanOrEqual(1);
  expect(removeBounds!.x - (editBounds!.x + editBounds!.width)).toBeGreaterThanOrEqual(6);
  expect(Math.abs(removeBounds!.y - editBounds!.y)).toBeLessThanOrEqual(1);
  const trigger = page.getByRole("button", { name: `查看 ${account.name} 详情` });
  await trigger.focus();
  await trigger.press("Enter");
  const dialog = page.getByRole("dialog", { name: "账号详情", exact: true });
  await expect(dialog.getByText("Fixture tenancy", { exact: true })).toBeVisible();
  const dimensions = await dialog.evaluate((element) => {
    const body = element.querySelector('[data-slot="dialog-body"]')!;
    const bounds = element.getBoundingClientRect();
    return {
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      dialog: bounds.width,
      dialogScroll: element.scrollWidth,
      dialogClient: element.clientWidth,
      left: bounds.left,
      right: bounds.right,
      body: body.clientWidth,
      bodyScroll: body.scrollWidth,
    };
  });
  expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport + 1);
  expect(dimensions.left).toBeGreaterThanOrEqual(0);
  expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.dialogScroll).toBeLessThanOrEqual(dimensions.dialogClient + 1);
  expect(dimensions.bodyScroll).toBeLessThanOrEqual(dimensions.body + 1);
  // Move off icon tooltips before exercising the containing dialog's Escape handler.
  await dialog.getByRole("button", { name: "关闭", exact: true }).focus();
  await expect(page.locator('[data-slot="tooltip-content"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
