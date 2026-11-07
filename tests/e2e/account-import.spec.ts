import { createHash, generateKeyPairSync } from "node:crypto";
import { expect, test as base, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { AccountSummary, JobSummary } from "../../src/lib/contracts";

// All API traffic is mocked before navigation. No credentials, sessions, or cloud
// writes reach the server; only the local application shell and assets are loaded.
type Write = { method: string; path: string; body: Record<string, unknown> };
type MockApi = { accounts: AccountSummary[]; syncJobs: JobSummary[]; writes: Write[] };
const sample: AccountSummary = {
  id: "ui-test-account",
  name: "Test account",
  tenancyId: "ocid1.tenancy.oc1..uitest",
  userId: "ocid1.user.oc1..uitest",
  fingerprint: "aa:".repeat(15) + "aa",
  homeRegion: "ap-tokyo-1",
  regions: ["ap-tokyo-1"],
  status: "unchecked",
  lastSyncAt: null,
  lastError: null,
  createdAt: "2026-11-07T00:00:00Z",
};
const queuedSync: JobSummary = {
  id: "ui-test-sync",
  kind: "sync-account",
  accountId: sample.id,
  accountName: sample.name,
  region: sample.homeRegion,
  resourceId: null,
  state: "queued",
  attempt: 0,
  maxAttempts: 3,
  createdAt: sample.createdAt,
  startedAt: null,
  finishedAt: null,
  nextRunAt: null,
  lastError: null,
  result: null,
};
const test = base.extend<{ mockApi: MockApi }>({
  mockApi: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL || "http://localhost:3000").origin;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
      throw new Error("Account UI tests require a local isolated server.");
    }
    const state: MockApi = { accounts: [], syncJobs: [], writes: [] };
    const unexpected: string[] = [];
    let pageErrors = 0;
    const trackErrors = (page: Page) => page.on("pageerror", () => pageErrors++);
    context.pages().forEach(trackErrors);
    context.on("page", trackErrors);
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const json = (body: unknown) => route.fulfill({ status: 200, json: body });
      if (url.origin === origin && url.pathname.startsWith("/api/")) {
        if (method === "GET" && url.pathname === "/api/auth/me") {
          return json({
            user: { id: "ui-test-user", username: "tester", mfaEnabled: false },
            demo: false,
          });
        }
        if (method === "GET" && url.pathname === "/api/accounts") {
          return json({ accounts: state.accounts, syncJobs: state.syncJobs, demo: false });
        }
        if (
          (method === "POST" && url.pathname === "/api/accounts") ||
          (method === "PATCH" && url.pathname === `/api/accounts/${sample.id}`)
        ) {
          const body = request.postDataJSON() as Record<string, unknown>;
          state.writes.push({ method, path: url.pathname, body });
          const account = { ...sample, name: String(body.name), regions: body.regions as string[] };
          state.accounts = [account];
          if (method === "POST") {
            const syncJob = { ...queuedSync, accountName: account.name };
            state.syncJobs = [syncJob];
            return json({ account, job: syncJob });
          }
          return json({ account }); // Metadata edits never echo a private key or invent a job.
        }
        if (method === "POST" && url.pathname === `/api/accounts/${sample.id}/sync`) {
          state.writes.push({ method, path: url.pathname, body: request.postDataJSON() });
          const job = { ...queuedSync, id: "ui-test-sync-retry" };
          state.syncJobs = [job];
          return json({ job });
        }
      } else if (url.origin === origin && method === "GET") {
        // Next.js link prefetches are unnecessary for this isolated form test.
        if (request.headers()["rsc"] === "1") return route.abort();
        if (
          (request.resourceType() === "document" && url.pathname === "/accounts") ||
          url.pathname.startsWith("/_next/") ||
          url.pathname === "/favicon.ico" ||
          url.pathname === "/icon.svg"
        ) {
          return route.continue();
        }
      }
      unexpected.push(`${method} ${url.origin}${url.pathname}`);
      return route.abort();
    });
    await use(state);
    expect(unexpected, "Unmocked API and external requests must never reach a server").toEqual([]);
    expect(pageErrors, "The form must not raise uncaught JavaScript errors").toBe(0);
    state.writes.length = 0;
  },
});
test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

const opener = (page: Page) =>
  page.locator(".page-heading").getByRole("button", { name: "添加账号", exact: true });
async function openAdd(page: Page) {
  await opener(page).click();
  const dialog = page.getByRole("dialog", { name: "添加 OCI 账号" });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function centered(dialog: Locator) {
  const box = await dialog.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const v = visualViewport;
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      vw: v?.width ?? innerWidth,
      vh: v?.height ?? innerHeight,
      vx: v?.offsetLeft ?? 0,
      vy: v?.offsetTop ?? 0,
      modal: element.matches(":modal"),
    };
  });
  expect(box.modal).toBe(true);
  expect(Math.abs(box.x + box.width / 2 - (box.vx + box.vw / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - (box.vy + box.vh / 2))).toBeLessThanOrEqual(2);
  expect(box.x - box.vx).toBeGreaterThanOrEqual(12);
  expect(box.y - box.vy).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(box.vx + box.vw - 12);
  expect(box.y + box.height).toBeLessThanOrEqual(box.vy + box.vh - 12);
}
async function emptyScreenshot(page: Page, dialog: Locator, info: TestInfo, name: string) {
  if (process.env.E2E_SCREENSHOTS !== "1") return;
  await expect(dialog.getByLabel(/^OCI 配置文本/)).toHaveValue("");
  await expect(dialog.getByLabel(/^API 私钥文件/)).toHaveValue("");
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: "disabled" });
}
function config(fingerprint: string) {
  return `[DEFAULT]\nuser=${sample.userId}\nfingerprint=${fingerprint}\ntenancy=${sample.tenancyId}\nregion=${sample.homeRegion}\nkey_file=<path to your private keyfile>`;
}

test("桌面添加弹窗居中，两项必填即可导入，键盘焦点正确", async ({ page, mockApi }, info) => {
  await page.setViewportSize({ width: 1691, height: 1004 });
  await page.goto("/accounts");
  let dialog = await openAdd(page);
  await centered(dialog);
  await expect(dialog.locator("input:visible, textarea:visible")).toHaveCount(2);
  await expect(dialog.locator("input[required]:visible, textarea[required]:visible")).toHaveCount(
    2,
  );
  await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
  await expect(dialog.getByRole("button", { name: /解析配置/ })).toHaveCount(0);
  await emptyScreenshot(page, dialog, info, "account-add-desktop-empty");
  await dialog.getByRole("heading", { name: "添加 OCI 账号" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^OCI 配置文本/).focus();
  for (const key of ["Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    const focus = await dialog.evaluate((el) => ({
      inside: el.contains(document.activeElement),
      documentHasFocus: document.hasFocus(),
      tag: document.activeElement?.tagName,
      id: document.activeElement?.id,
    }));
    // Native dialogs allow Tab to reach browser chrome. While the document has
    // focus, no background page control may receive it.
    expect(focus.inside || !focus.documentHasFocus, `Focus after ${key}`).toBe(true);
  }
  await dialog.getByLabel(/^OCI 配置文本/).focus();
  await opener(page).evaluate((element) => element.focus());
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(opener(page)).toBeFocused();
  dialog = await openAdd(page);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "der", type: "spki" },
  });
  const fingerprint = createHash("md5").update(publicKey).digest("hex").match(/.{2}/g)!.join(":");
  await dialog.getByLabel(/^OCI 配置文本/).fill(config(fingerprint));
  await dialog.getByLabel(/^API 私钥文件/).setInputFiles({
    name: "test-account-2026-11-07T00_00_00.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from(privateKey),
  });
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mockApi.writes.length).toBe(1);
  const { method, body } = mockApi.writes[0];
  expect(method).toBe("POST");
  // Compare public fields separately: a failed assertion must never print a key.
  expect(body.name).toBe("test-account");
  expect(body.tenancyId).toBe(sample.tenancyId);
  expect(body.userId).toBe(sample.userId);
  expect(body.fingerprint).toBe(fingerprint);
  expect(body.homeRegion).toBe("ap-tokyo-1");
  expect(body.regions).toEqual(["ap-tokyo-1"]);
  expect(
    body.privateKey === privateKey.trim(),
    "The uploaded key must be submitted unchanged",
  ).toBe(true);
  expect("key_file" in body || "profileName" in body).toBe(false);
  const card = page.locator(".account-card");
  await expect(card.getByRole("heading")).toHaveText("test-account");
  await expect(card).toContainText("等待连接");
  await expect(card.getByRole("button", { name: /^(验证|同步)$/ })).toHaveCount(0);
  mockApi.accounts[0] = {
    ...mockApi.accounts[0],
    status: "connected",
    lastSyncAt: sample.createdAt,
  };
  mockApi.syncJobs[0] = {
    ...mockApi.syncJobs[0],
    state: "succeeded",
    finishedAt: sample.createdAt,
  };
  // The 3-second account poll must update the card without a manual refresh.
  await expect(card.getByText("已连接", { exact: true })).toBeVisible({ timeout: 8000 });
  await expect(card.getByRole("button", { name: "刷新资源", exact: true })).toBeEnabled();
  expect(mockApi.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/accounts",
  ]);
});

test("连接失败可重试，排队期间禁用按钮且不重复提交", async ({ page, mockApi }) => {
  const error = "测试连接失败，请检查账号配置。";
  mockApi.accounts = [{ ...sample, status: "error", lastError: error }];
  mockApi.syncJobs = [
    { ...queuedSync, state: "failed", lastError: error, finishedAt: sample.createdAt },
  ];
  await page.goto("/accounts");
  const card = page.locator(".account-card");
  await expect(card).toContainText(error);
  const retry = card.getByRole("button", { name: "重试连接", exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  const waiting = card.getByRole("button", { name: "等待连接", exact: true });
  await expect(waiting).toBeDisabled();
  await expect(card.getByRole("button", { name: "重试连接", exact: true })).toHaveCount(0);
  // A native click on a disabled button must not dispatch another request.
  await waiting.evaluate((element) => (element as HTMLButtonElement).click());
  await expect(waiting).toBeDisabled();
  expect(mockApi.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `POST /api/accounts/${sample.id}/sync`,
  ]);
});

test("缺少配置字段与非 PEM 文件均在提交前显示错误", async ({ page, mockApi }) => {
  await page.goto("/accounts");
  const dialog = await openAdd(page);
  await dialog
    .getByLabel(/^OCI 配置文本/)
    .fill(config(sample.fingerprint).replace(/^tenancy=.*\n/m, ""));
  await dialog.getByLabel(/^API 私钥文件/).setInputFiles({
    name: "invalid.pem",
    mimeType: "application/x-pem-file",
    buffer: Buffer.from("not a PEM private key"),
  });
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("所选配置档缺少必填项：租户 OCID。");
  expect(mockApi.writes.length).toBe(0);
  await dialog.getByLabel(/^OCI 配置文本/).fill(config(sample.fingerprint));
  await dialog.getByRole("button", { name: "添加账号", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请选择 PEM 格式的 OCI RSA API 私钥文件。");
  expect(mockApi.writes.length).toBe(0);
  await expect(dialog).toBeVisible();
});

test("编辑名称不读取或提交现有私钥，也不重新连接", async ({ page, mockApi }) => {
  mockApi.accounts = [{ ...sample }];
  await page.goto("/accounts");
  await page.locator(".account-card").getByRole("button", { name: "编辑", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑账号" });
  await expect(dialog.getByRole("checkbox", { name: "替换连接凭据" })).not.toBeChecked();
  await expect(dialog.getByLabel(/^OCI 配置文本/)).toHaveCount(0);
  await expect(dialog.locator('input[type="file"]')).toHaveCount(0);
  await dialog.getByLabel(/^账号名称/).fill("Renamed account");
  await dialog.getByLabel(/^同步区域/).fill("ap-tokyo-1\nap-tokyo-1");
  await dialog.getByRole("button", { name: "保存更改", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(mockApi.writes.length).toBe(1);
  const { method, body } = mockApi.writes[0];
  expect(method).toBe("PATCH");
  expect(Object.keys(body).sort()).toEqual(["name", "regions"]);
  expect(body.name).toBe("Renamed account");
  expect(body.regions).toEqual(["ap-tokyo-1"]);
  await expect(page.locator(".account-card").getByRole("heading")).toHaveText("Renamed account");
});

test("390×480 短屏仅内容滚动，标题与操作栏可见，遮罩点击关闭", async ({ page, mockApi }, info) => {
  await page.setViewportSize({ width: 390, height: 480 });
  await page.goto("/accounts");
  const dialog = await openAdd(page);
  await dialog.locator("summary").click();
  await centered(dialog);
  await emptyScreenshot(page, dialog, info, "account-add-mobile-empty");
  const body = dialog.locator(".modal-body");
  expect(await body.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const heading = dialog.locator(".modal-heading");
  const footer = dialog.locator(".modal-footer");
  const before = { heading: await heading.boundingBox(), footer: await footer.boundingBox() };
  await body.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  expect(await body.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const after = { heading: await heading.boundingBox(), footer: await footer.boundingBox() };
  expect(Math.abs(after.heading!.y - before.heading!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(after.footer!.y - before.footer!.y)).toBeLessThanOrEqual(1);
  expect(after.heading!.y).toBeGreaterThanOrEqual(12);
  expect(after.footer!.y + after.footer!.height).toBeLessThanOrEqual(468);
  await expect(heading).toBeInViewport({ ratio: 1 });
  await expect(footer).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole("button", { name: "添加账号", exact: true })).toBeInViewport({
    ratio: 1,
  });
  await heading.click();
  await expect(dialog).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(dialog).not.toBeVisible();
  expect(mockApi.writes.length).toBe(0);
});
