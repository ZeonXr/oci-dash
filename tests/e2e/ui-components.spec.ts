import { expect, test as base, type Locator, type Page } from "@playwright/test";
import type { OperationRequest } from "../../src/lib/contracts";
import { jobPageFixture } from "../fixtures/job-page";
import { fixtureAccounts, fixtureInstances, fixtureMetrics } from "../fixtures/seed-data";

const accounts = fixtureAccounts();
const instances = fixtureInstances();
const running = instances.find((instance) => instance.state === "RUNNING")!;

interface UiFixture {
  operations: OperationRequest[];
  operationGate?: Promise<void>;
  releaseOperation?: () => void;
}

const test = base.extend<{ uiApi: UiFixture }>({
  uiApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [];
      const errors: string[] = [];
      const state: UiFixture = { operations: [] };
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push("WS " + socket.url());
        socket.close();
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.origin !== origin) {
          unexpected.push(request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const json = (body: unknown) => route.fulfill({ json: body });
        if (url.pathname === "/api/auth/me")
          return json({ user: { id: "ui-fixture", username: "admin", mfaEnabled: false } });
        if (url.pathname === "/api/accounts") return json({ accounts, syncJobs: [] });
        if (url.pathname === "/api/instances") return json({ instances });
        if (url.pathname === "/api/jobs") return json(jobPageFixture([], url.searchParams));
        if (url.pathname === "/api/inventory/refresh" && request.method() === "POST")
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
        const detail = /^\/api\/instances\/([^/]+)(\/metrics)?$/.exec(url.pathname);
        if (detail) {
          const instance = instances.find((item) => item.id === decodeURIComponent(detail[1]!));
          if (instance) {
            if (!detail[2]) return json({ instance });
            const range = url.searchParams.get("range");
            return json(fixtureMetrics(range === "24h" || range === "7d" ? range : "1h"));
          }
        }
        if (url.pathname === "/api/operations" && request.method() === "POST") {
          state.operations.push(request.postDataJSON());
          if (state.operationGate) await state.operationGate;
          return json({ job: { id: "ui-fixture-operation" } });
        }
        unexpected.push(request.method() + " " + url.pathname);
        return route.abort();
      });
      try {
        await use(state);
      } finally {
        state.releaseOperation?.();
      }
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

async function openRename(page: Page) {
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "重命名实例", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    )
    .toBeLessThanOrEqual(1);
}

async function expectInsideViewport(control: Locator) {
  await expect(control).toBeVisible();
  await expect
    .poll(async () => {
      const box = await control.boundingBox();
      const viewport = control.page().viewportSize();
      return Boolean(
        box &&
        viewport &&
        box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1,
      );
    })
    .toBe(true);
}

for (const item of [
  { menu: "重命名", title: "重命名实例" },
  { menu: "重启实例", title: "重启实例" },
]) {
  test(`${item.title}关闭后焦点返回更多菜单触发器`, async ({ page, uiApi }) => {
    await page.goto(`/instances/${encodeURIComponent(running.id)}`);
    const trigger = page.getByRole("button", { name: "更多", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: item.menu, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: item.title, exact: true });
    await expect(dialog).toBeVisible();
    if (item.menu === "重命名") await expect(dialog.getByLabel(/^实例名称/)).toBeFocused();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    expect(uiApi.operations).toEqual([]);
  });
}

test("提交期间弹窗禁止关闭，完成后恢复菜单焦点", async ({ page, uiApi }) => {
  await page.goto(`/instances/${encodeURIComponent(running.id)}`);
  const dialog = await openRename(page);
  uiApi.operationGate = new Promise<void>((resolve) => {
    uiApi.releaseOperation = resolve;
  });
  try {
    await dialog.getByLabel(/^实例名称/).fill("renamed-fixture-instance");
    await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect.poll(() => uiApi.operations.length).toBe(1);
    expect(uiApi.operations[0]).toMatchObject({
      kind: "instance-rename",
      resourceId: running.id,
      payload: { displayName: "renamed-fixture-instance" },
    });
    await expect(dialog.getByRole("button", { name: "关闭对话框", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "保存名称", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await page.mouse.click(5, 5);
    await expect(dialog).toBeVisible();
    uiApi.releaseOperation?.();
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole("button", { name: "更多", exact: true })).toBeFocused();
    expect(uiApi.operations).toHaveLength(1);
  } finally {
    uiApi.releaseOperation?.();
  }
});

test("Select支持键盘选择并返回空值的全部状态", async ({ page }) => {
  await page.goto("/instances");
  const control = page.getByRole("combobox", { name: "筛选状态", exact: true });
  const cards = page.getByRole("region", { name: "实例卡片列表", exact: true });
  await expect(cards.getByRole("article")).toHaveCount(instances.length);
  await expect(control).toHaveAttribute("data-value", "");
  await expect(control).toHaveText("全部状态");
  await control.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "全部状态", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option", { name: "运行中", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(control).toHaveAttribute("data-value", "RUNNING");
  await expect(control).toBeFocused();
  await expect(cards.getByRole("article")).toHaveCount(
    instances.filter((instance) => instance.state === "RUNNING").length,
  );
  await page.keyboard.press("Space");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Home");
  await expect(page.getByRole("option", { name: "全部状态", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await expect(control).toHaveAttribute("data-value", "");
  await expect(control).toHaveText("全部状态");
  await expect(control).toBeFocused();
  await expect(cards.getByRole("article")).toHaveCount(instances.length);
});

test("深色窄屏下列表、Select和弹窗保持在视口内", async ({ page, context, uiApi }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await context.addInitScript(() => localStorage.setItem("oci-dash-theme", "dark"));
  await page.goto("/instances");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
  await expect(page.getByRole("article")).toHaveCount(instances.length);
  await expectNoHorizontalOverflow(page);
  await page.getByRole("combobox", { name: "筛选账号", exact: true }).click();
  await expectInsideViewport(page.getByRole("listbox"));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).not.toBeVisible();
  await page.goto(`/instances/${encodeURIComponent(running.id)}`);
  await expect(
    page.getByRole("heading", { name: new RegExp(running.displayName), level: 1 }),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  const dialog = await openRename(page);
  await expectInsideViewport(dialog);
  await expect(dialog.getByLabel(/^实例名称/)).toBeFocused();
  await expectNoHorizontalOverflow(page);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "更多", exact: true })).toBeFocused();
  expect(uiApi.operations).toEqual([]);
});
