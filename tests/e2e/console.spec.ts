import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { InstanceSummary } from "../../src/lib/contracts";
import type { ConsoleSessionSummary } from "../../src/lib/console-contracts";

// All API calls and WebSockets are intercepted. No login, credentials, OCI
// writes or connection to a real console are used by this suite.
const instance: InstanceSummary = {
  id: "console-fixture-instance",
  accountId: "console-fixture-account",
  accountName: "测试账号",
  displayName: "Console fixture",
  region: "ap-tokyo-1",
  availabilityDomain: "fixture:AP-TOKYO-1-AD-1",
  compartmentId: "console-fixture-compartment",
  state: "RUNNING",
  shape: "VM.Standard.E2.1.Micro",
  ocpus: 1,
  memoryGb: 1,
  os: "Ubuntu",
  createdAt: "2026-01-01T00:00:00.000Z",
  vnics: [],
  bootVolumes: [],
  tags: {},
  syncedAt: "2026-01-01T00:00:00.000Z",
};
const consolePath = `/instances/${instance.id}/console`;
const now = () => new Date(Date.now() + 300000).toISOString();
const summary = (id = "console-session-1"): ConsoleSessionSummary => ({
  id,
  instanceId: instance.id,
  instanceName: instance.displayName,
  accountId: instance.accountId,
  state: "ready",
  createdAt: new Date().toISOString(),
  expiresAt: now(),
  lastError: null,
  cleanupPending: false,
});

function rfbFixture(socket: WebSocketRoute, authenticated: boolean) {
  let step = 0;
  const messages: Buffer[] = [];
  socket.onMessage((message) => {
    const bytes = typeof message === "string" ? Buffer.from(message) : message;
    messages.push(bytes);
    if (step === 0) {
      expect(bytes.toString()).toBe("RFB 003.008\n");
      step = 1;
      socket.send(Buffer.from([1, 1]));
    } else if (step === 1) {
      expect(bytes[0]).toBe(1);
      step = 2;
      if (!authenticated) {
        const reason = Buffer.from("Fixture authentication failed");
        const failure = Buffer.alloc(8 + reason.length);
        failure.writeUInt32BE(1, 0);
        failure.writeUInt32BE(reason.length, 4);
        reason.copy(failure, 8);
        socket.send(failure);
      } else socket.send(Buffer.alloc(4));
    } else if (step === 2 && authenticated) {
      step = 3;
      const name = Buffer.from("Local test console");
      const init = Buffer.alloc(24 + name.length);
      init.writeUInt16BE(640, 0);
      init.writeUInt16BE(400, 2);
      init[4] = 32;
      init[5] = 24;
      init[7] = 1;
      init.writeUInt16BE(255, 8);
      init.writeUInt16BE(255, 10);
      init.writeUInt16BE(255, 12);
      init[14] = 16;
      init[15] = 8;
      init.writeUInt32BE(name.length, 20);
      name.copy(init, 24);
      socket.send(init);
    }
  });
  socket.send(Buffer.from("RFB 003.008\n"));
  return messages;
}

async function setup(
  page: Page,
  options: {
    instanceState?: InstanceSummary["state"];
    existing?: ConsoleSessionSummary;
    preparing?: boolean;
    authenticated?: boolean;
    holdCreate?: Promise<void>;
  } = {},
) {
  const origin = new URL(test.info().project.use.baseURL || "http://localhost:3000").origin;
  const fixture = {
    session: options.existing || (null as ConsoleSessionSummary | null),
    writes: [] as string[],
    unexpected: [] as string[],
    errors: [] as string[],
    creates: 0,
    touches: 0,
    tickets: 0,
    closes: 0,
    cleanupPending: false,
    socket: null as WebSocketRoute | null,
    messages: [] as Buffer[],
  };
  page.on("pageerror", (error) => fixture.errors.push(error.message));
  await page.addInitScript(() => {
    const sockets: { url: string; protocols: string | string[] | undefined }[] = [];
    (window as unknown as { consoleFixtureSockets: typeof sockets }).consoleFixtureSockets =
      sockets;
    // Install after Playwright's WebSocket routing init script has run.
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        const NativeWebSocket = window.WebSocket;
        // Preserve the socket's immediate prototype: noVNC validates methods on it.
        window.WebSocket = new Proxy(NativeWebSocket, {
          construct(target, args) {
            sockets.push({ url: String(args[0]), protocols: args[1] });
            const socket = Reflect.construct(target, args);
            // Playwright's routed WebSocket has an extra prototype layer. Expose
            // its channel contract directly for noVNC's own-property validation.
            for (const key of [
              "send",
              "close",
              "binaryType",
              "onerror",
              "onmessage",
              "onopen",
              "protocol",
              "readyState",
            ]) {
              let owner = socket;
              while (owner && !Object.getOwnPropertyDescriptor(owner, key))
                owner = Object.getPrototypeOf(owner);
              const descriptor = owner && Object.getOwnPropertyDescriptor(owner, key);
              if (descriptor)
                Object.defineProperty(socket, key, { ...descriptor, enumerable: true });
            }
            return socket;
          },
        });
      },
      { once: true },
    );
  });
  await page.routeWebSocket(/.*/, (socket) => {
    const url = new URL(socket.url());
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\/api\/console\/sessions\/console-session-\d+\/socket$/.test(url.pathname) ||
      url.search
    ) {
      // Next development HMR is also intentionally not connected to a server.
      if (!url.pathname.includes("webpack-hmr"))
        fixture.unexpected.push(`WS ${url.origin}${url.pathname}`);
      socket.close();
      return;
    }
    fixture.socket = socket;
    fixture.messages = rfbFixture(socket, options.authenticated !== false);
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      fixture.unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    if (url.pathname.startsWith("/flags/")) {
      if (
        url.origin === origin &&
        req.method() === "GET" &&
        /^\/flags\/[a-z]{2}\.svg$/.test(url.pathname)
      )
        return route.continue();
      fixture.unexpected.push(`${req.method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) {
      if (req.method() !== "GET") {
        fixture.unexpected.push(`${req.method()} ${url.pathname}`);
        await route.abort();
      } else await route.continue();
      return;
    }
    const method = req.method();
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (method !== "GET") fixture.writes.push(`${method} ${path}`);
    if (path === "/api/auth/me" && method === "GET")
      return json({
        user: { id: "fixture-user", username: "fixture", mfaEnabled: false },
      });
    if (path === "/api/accounts" && method === "GET") return json({ accounts: [] });
    if (path === "/api/inventory/refresh" && method === "POST") {
      expect(req.postDataJSON()).toMatchObject({ mode: "auto" });
      return json({ jobs: [], accounts: [] });
    }
    if (path === `/api/instances/${instance.id}` && method === "GET")
      return json({ instance: { ...instance, state: options.instanceState ?? instance.state } });
    if (path === `/api/instances/${instance.id}/metrics` && method === "GET")
      return json({ points: [], available: false, source: "oci" });
    if (path === "/api/jobs" && method === "GET") return json({ jobs: [], recentJobs: [] });
    if (path === "/api/console/session" && method === "GET")
      return json({ session: fixture.session });
    if (path === "/api/console/sessions" && method === "POST") {
      expect(["TERMINATED", "TERMINATING"]).not.toContain(options.instanceState);
      expect(req.postDataJSON()).toEqual({ instanceId: instance.id });
      fixture.creates += 1;
      fixture.session = summary(`console-session-${fixture.creates}`);
      if (options.preparing) fixture.session.state = "preparing";
      if (options.holdCreate) await options.holdCreate;
      return json({ session: fixture.session }, 202);
    }
    const match = path.match(/^\/api\/console\/sessions\/([^/]+)(?:\/(ticket|touch|close))?$/);
    if (match && fixture.session?.id === match[1]) {
      if (method === "GET" && !match[2]) return json({ session: fixture.session });
      if (method === "POST" && match[2] === "ticket") {
        fixture.tickets += 1;
        return json({
          ticket: "fixture-single-use-ticket",
          expiresAt: now(),
          path: `/api/console/sessions/${fixture.session.id}/socket`,
        });
      }
      if (method === "POST" && match[2] === "touch") {
        fixture.touches += 1;
        return json({ session: fixture.session });
      }
      if ((method === "DELETE" && !match[2]) || (method === "POST" && match[2] === "close")) {
        fixture.closes += 1;
        fixture.session = {
          ...fixture.session,
          state: fixture.cleanupPending ? "failed" : "closed",
          cleanupPending: fixture.cleanupPending,
        };
        return json({ session: fixture.session });
      }
    }
    fixture.unexpected.push(`${method} ${path}`);
    return json({ error: "Unmocked API blocked by console fixture" }, 501);
  });
  return fixture;
}

for (const instanceState of ["TERMINATED", "TERMINATING"]) {
  test(`${instanceState} 实例禁止创建控制台，详情的 VNC 链接仍在新标签打开`, async ({ page }) => {
    const fixture = await setup(page, { instanceState });
    await page.goto(`/instances/${instance.id}`);
    await expect(page.getByRole("link", { name: "VNC 控制台" })).toHaveAttribute(
      "target",
      "_blank",
    );
    await page.goto(consolePath);
    await expect(page.getByText("实例已终止或正在终止，无法连接控制台。")).toBeVisible();
    await expect(page.getByRole("button", { name: "连接", exact: true })).toBeDisabled();
    expect(fixture.creates).toBe(0);
    expect(fixture.tickets).toBe(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    expect(fixture.errors).toEqual([]);
  });
}

test("点击才创建，真实 noVNC 握手、票据子协议和用户活动续时", async ({ page }, testInfo) => {
  const fixture = await setup(page, { preparing: true });
  await page.goto(consolePath);
  const connect = page.getByRole("button", { name: "连接", exact: true });
  await expect(connect).toBeEnabled();
  expect(fixture.writes).toEqual([]);
  await connect.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByRole("status")).toContainText("正在准备");
  expect(fixture.creates).toBe(1);
  expect(fixture.tickets).toBe(0);
  fixture.session!.state = "ready";
  await expect(page.getByRole("status")).toContainText("已连接");
  expect(fixture.tickets).toBe(1);
  const sockets = await page.evaluate(() =>
    (
      window as unknown as {
        consoleFixtureSockets: { url: string; protocols: string[] }[];
      }
    ).consoleFixtureSockets.filter(
      (s) => s.url.includes("/api/console/sessions/") && s.url.endsWith("/socket"),
    ),
  );
  expect(sockets).toHaveLength(1);
  expect(new URL(sockets[0].url).search).toBe("");
  expect(sockets[0].protocols).toEqual(["oci-console", "ticket.fixture-single-use-ticket"]);
  expect(fixture.touches).toBe(0);
  if (process.env.E2E_SCREENSHOTS === "1") {
    await page.screenshot({ path: testInfo.outputPath("console-desktop.png"), fullPage: true });
  }
  await page.getByRole("button", { name: "Ctrl+Alt+Del" }).click();
  await expect.poll(() => fixture.touches).toBe(1);
  await page.locator(".console-screen canvas").click();
  await page.keyboard.press("a");
  expect(fixture.touches).toBe(1);
  await expect(page.getByRole("button", { name: "适应窗口" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "适应窗口" }).click();
  await expect(page.getByRole("button", { name: "适应窗口" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await page.getByRole("button", { name: "断开", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已断开");
  await expect(page.getByRole("button", { name: "重试连接" })).toBeEnabled();
  expect(fixture.closes).toBe(1);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("全站占用和待清理会话阻止新建，用户可重试断开", async ({ page }) => {
  const existing = {
    ...summary("occupied-session"),
    instanceId: "other-instance",
    instanceName: "其他实例",
    state: "connected" as const,
  };
  const fixture = await setup(page, { existing });
  await page.goto(consolePath);
  await expect(page.getByText(/全站同时只能使用一个 VNC 会话/)).toBeVisible();
  expect(fixture.writes).toEqual([]);
  expect(fixture.tickets).toBe(0);
  await page.getByRole("link", { name: "返回实例", exact: true }).click();
  expect(fixture.closes).toBe(0);
  await page.goto(consolePath);
  await expect(page.getByRole("button", { name: "断开现有会话" })).toBeEnabled();
  fixture.cleanupPending = true;
  await page.getByRole("button", { name: "断开现有会话" }).click();
  await expect(page.getByRole("button", { name: "重试断开" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "重试连接" })).toHaveCount(0);
  expect(fixture.creates).toBe(0);
  fixture.cleanupPending = false;
  await page.getByRole("button", { name: "重试断开" }).click();
  await expect(page.getByRole("button", { name: "重试连接" })).toBeEnabled();
  expect(fixture.closes).toBe(2);
  expect(fixture.unexpected).toEqual([]);
});

test("认证失败显示错误并回收本页会话", async ({ page }) => {
  const fixture = await setup(page, { authenticated: false });
  await page.goto(consolePath);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.locator(".console-notices [role=alert]")).toContainText("控制台认证未通过");
  await expect.poll(() => fixture.closes).toBe(1);
  await expect(page.getByRole("button", { name: "重试连接" })).toBeEnabled();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("离开页面关闭本页会话，小屏控制台不撑宽页面", async ({ page }, testInfo) => {
  const fixture = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(consolePath);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已连接");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  if (process.env.E2E_SCREENSHOTS === "1") {
    await page.screenshot({ path: testInfo.outputPath("console-mobile.png"), fullPage: true });
  }
  await page.getByRole("link", { name: "返回实例", exact: true }).click();
  await expect.poll(() => fixture.closes).toBe(1);
  expect(fixture.writes).toContain("POST /api/console/sessions/console-session-1/close");
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("创建响应在离页后返回时仍回收会话，且不会领取连接票据", async ({ page }) => {
  let release = () => {};
  const holdCreate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fixture = await setup(page, { holdCreate });
  await page.goto(consolePath);
  await page.getByRole("button", { name: "连接", exact: true }).click();
  await expect.poll(() => fixture.creates).toBe(1);
  await page.getByRole("link", { name: "返回实例", exact: true }).click();
  release();
  await expect.poll(() => fixture.closes).toBe(1);
  expect(fixture.tickets).toBe(0);
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.errors).toEqual([]);
});
