import { expect, test as base, type Page } from "@playwright/test";

type Reply = { status: number; body: unknown };
type AuthFixture = {
  status: Reply;
  statusGate?: Promise<void>;
  setup: Reply;
  login: Reply;
  authenticated: boolean;
  writes: { path: string; body: Record<string, unknown> }[];
  consoleMessages: string[];
};
const user = { id: "setup-fixture-user", username: "fixture-admin", mfaEnabled: false };

// Every API and socket is intercepted before navigation. Only the localhost
// application shell/assets load; these tests never initialize a real database.
const test = base.extend<{ auth: AuthFixture }>({
  auth: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL || "http://localhost:3000").origin;
      if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
        throw new Error("Setup UI tests require an isolated localhost server.");
      const auth: AuthFixture = {
        status: { status: 200, body: { setupRequired: true } },
        setup: { status: 201, body: { user } },
        login: { status: 200, body: { user } },
        authenticated: false,
        writes: [],
        consoleMessages: [],
      };
      const unexpected: string[] = [];
      const errors: string[] = [];
      const track = (page: Page) => {
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => auth.consoleMessages.push(message.text()));
      };
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
        const path = url.pathname;
        const method = request.method();
        if (url.origin === origin) {
          if (method === "GET") {
            if (path === "/api/auth/status") {
              await auth.statusGate;
              return route.fulfill({ status: auth.status.status, json: auth.status.body });
            }
            if (path === "/api/auth/me")
              return route.fulfill({ json: { user: auth.authenticated ? user : null } });
            if (path === "/api/accounts")
              return route.fulfill({ json: { accounts: [], syncJobs: [] } });
            if (path === "/api/jobs") return route.fulfill({ json: { jobs: [], recentJobs: [] } });
            if (
              [
                "/login",
                "/overview",
                "/instances",
                "/traffic",
                "/costs",
                "/tasks",
                "/settings",
                "/settings/accounts",
                "/settings/security",
                "/settings/general",
                "/favicon.ico",
                "/icon.svg",
              ].includes(path) ||
              path.startsWith("/_next/")
            )
              return route.continue();
          }
          if (method === "POST" && ["/api/auth/setup", "/api/auth/login"].includes(path)) {
            auth.writes.push({ path, body: request.postDataJSON() });
            const reply = path === "/api/auth/setup" ? auth.setup : auth.login;
            if (reply.status < 300) auth.authenticated = true;
            return route.fulfill({ status: reply.status, json: reply.body });
          }
        }
        unexpected.push(`${method} ${url.origin}${path}`);
        return route.abort();
      });
      await use(auth);
      expect(unexpected, "Unexpected requests and real API writes are blocked").toEqual([]);
      expect(errors, "Setup must not cause uncaught JavaScript errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

async function fillSetup(page: Page, password = "Fixture-only-password-2026") {
  await page.getByRole("textbox", { name: "用户名", exact: true }).fill("fixture-admin");
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByLabel("确认密码", { exact: true }).fill(password);
}

async function mockClipboard(page: Page, failure: boolean) {
  await page.addInitScript((reject) => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          if (reject) throw new DOMException("Clipboard permission denied", "NotAllowedError");
          (window as Window & { copiedForTest?: string }).copiedForTest = value;
        },
      },
    });
  }, failure);
}

test("必须明确取得设置状态后才展示首次创建表单", async ({ page, auth }) => {
  let release!: () => void;
  auth.statusGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto("/login");
  await expect(page.getByText("正在检查登录状态…", { exact: true })).toBeVisible();
  await expect(page.getByRole("form")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建管理员", exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole("heading", { name: "创建管理员", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "用户名", exact: true })).toBeFocused();
  expect(auth.writes).toHaveLength(0);
});

test("状态请求失败或响应格式错误时只显示重试，不开放设置", async ({ page, auth }) => {
  auth.status = { status: 503, body: { error: "暂时无法读取设置状态" } };
  await page.goto("/login");
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText(
    "暂时无法读取设置状态",
  );
  await expect(page.getByRole("form")).toHaveCount(0);
  auth.status = { status: 200, body: { setupRequired: "true" } };
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText(
    "无法确认管理员设置状态",
  );
  await expect(page.getByRole("form")).toHaveCount(0);
  auth.status = { status: 200, body: { setupRequired: false } };
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成并复制", exact: true })).toHaveCount(0);
  expect(auth.writes).toHaveLength(0);
});

test("创建前验证用户名、密码长度与确认值，成功后进入总览", async ({ page, auth }) => {
  await page.goto("/login");
  const username = page.getByRole("textbox", { name: "用户名", exact: true });
  const password = page.getByLabel("密码", { exact: true });
  const confirmation = page.getByLabel("确认密码", { exact: true });
  const submit = page.getByRole("button", { name: "创建管理员", exact: true });
  await fillSetup(page);
  await username.fill("   ");
  await submit.click();
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText(
    "用户名长度须为 1–80 个字符",
  );
  await expect(username).toBeFocused();
  await username.fill("  fixture-admin  ");
  await password.fill("too-short");
  await submit.click();
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText(
    "密码长度须为 12–256 个字符",
  );
  await expect(password).toBeFocused();
  await password.fill("Fixture-only-password-2026");
  await confirmation.fill("Different-fixture-password");
  await submit.click();
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText(
    "两次输入的密码不一致",
  );
  await expect(confirmation).toBeFocused();
  expect(auth.writes).toHaveLength(0);
  await confirmation.fill("Fixture-only-password-2026");
  await submit.click();
  await expect(page).toHaveURL((url) => url.pathname === "/overview");
  await expect(page.getByRole("heading", { name: "数据总览", exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "添加账号后查看用量", exact: true }),
  ).toBeVisible();
  expect(auth.writes).toEqual([
    {
      path: "/api/auth/setup",
      body: {
        username: "fixture-admin",
        password: "Fixture-only-password-2026",
      },
    },
  ]);
});

test("生成并复制填入两处，不提交、不写入存储或日志", async ({ page, auth }) => {
  await mockClipboard(page, false);
  await page.goto("/login");
  await page.getByRole("button", { name: "生成并复制", exact: true }).click();
  await expect(page.locator(".login-panel").getByRole("status")).toContainText("密码已生成并复制");
  const password = await page.getByLabel("密码", { exact: true }).inputValue();
  expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
  expect(password).toMatch(/[A-Z]/);
  expect(password).toMatch(/[a-z]/);
  expect(password).toMatch(/[0-9]/);
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveValue(password);
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  expect(
    await page.evaluate(() => (window as Window & { copiedForTest?: string }).copiedForTest),
  ).toBe(password);
  expect(auth.writes).toHaveLength(0);
  expect(
    await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })),
  ).toEqual({ local: 0, session: 0 });
  expect(auth.consoleMessages.some((message) => message.includes(password))).toBe(false);
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "text");
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await page.getByRole("button", { name: "显示确认密码", exact: true }).click();
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveAttribute("type", "text");
});

test("剪贴板被拒绝时保留生成值，移动端可显示并选中后手动复制", async ({ page, auth }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockClipboard(page, true);
  await page.goto("/login");
  await page.getByRole("button", { name: "生成并复制", exact: true }).click();
  await expect(page.locator(".login-panel").getByRole("status")).toContainText("无法复制到剪贴板");
  const password = page.getByLabel("密码", { exact: true });
  const generated = await password.inputValue();
  expect(generated).toHaveLength(32);
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveValue(generated);
  await page.getByRole("button", { name: "显示并选中密码", exact: true }).click();
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toBeFocused();
  expect(
    await password.evaluate((input: HTMLInputElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([0, 32]);
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 1);
  expect(auth.writes).toHaveLength(0);
});

test("另一页面已创建管理员时清空密码并切换登录", async ({ page, auth }) => {
  auth.setup = { status: 409, body: { code: "SETUP_ALREADY_COMPLETED", error: "设置已完成" } };
  await page.goto("/login");
  await fillSetup(page);
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await page.getByRole("button", { name: "创建管理员", exact: true }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
  await expect(page.locator(".login-panel").getByRole("alert")).toContainText("管理员已创建");
  await expect(page.getByLabel("密码", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("密码", { exact: true })).toHaveAttribute("type", "password");
  await expect(page.getByLabel("确认密码", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "用户名", exact: true })).toBeFocused();
  expect(auth.writes.map(({ path }) => path)).toEqual(["/api/auth/setup"]);
});

test("已有管理员仍可使用原有密码及双重验证登录", async ({ page, auth }) => {
  auth.status = { status: 200, body: { setupRequired: false } };
  auth.login = { status: 401, body: { code: "MFA_REQUIRED", error: "需要验证码" } };
  await page.goto("/login");
  await page.getByRole("textbox", { name: "用户名", exact: true }).fill("fixture-admin");
  await page.getByLabel("密码", { exact: true }).fill("Fixture-login-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  const code = page.getByRole("textbox", { name: /双重验证/ });
  await expect(code).toBeFocused();
  await code.fill("123456");
  auth.login = { status: 200, body: { user: { ...user, mfaEnabled: true } } };
  await page.getByRole("button", { name: "验证并登录", exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === "/overview");
  expect(auth.writes.map(({ path }) => path)).toEqual(["/api/auth/login", "/api/auth/login"]);
  expect(auth.writes[1].body.code).toBe("123456");
  expect(auth.writes[1].body.password).toBe("Fixture-login-password");
});

test("已有会话直接进入总览", async ({ page, auth }) => {
  auth.status = { status: 200, body: { setupRequired: false } };
  auth.authenticated = true;
  await page.goto("/login");
  await expect(page).toHaveURL((url) => url.pathname === "/overview");
  await expect(page.getByRole("heading", { name: "数据总览", exact: true })).toBeVisible();
  expect(auth.writes).toHaveLength(0);
});
