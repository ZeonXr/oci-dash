import { expect, test as base, type Page, type TestInfo } from "@playwright/test";
import type { AccountSummary, InstanceSummary } from "../../src/lib/contracts";
import type {
  AnalyticsRange,
  CostReport,
  CostRow,
  TrafficReport,
} from "../../src/lib/analytics-contracts";

// The fixture intercepts every API and WebSocket before navigation. Only local
// document/assets load from the isolated server; no real credentials or OCI calls.
const now = "2026-11-07T12:30:00.000Z";
const giB = 1024 ** 3;
const accounts: AccountSummary[] = [
  {
    id: "analytics-a",
    name: "Analytics A",
    tenancyId: "ocid1.tenancy.oc1..analyticsa",
    userId: "ocid1.user.oc1..analyticsa",
    fingerprint: "aa:".repeat(15) + "aa",
    homeRegion: "ap-tokyo-1",
    regions: ["ap-tokyo-1"],
    status: "connected",
    lastSyncAt: now,
    lastError: null,
    createdAt: now,
  },
  {
    id: "analytics-b",
    name: "Analytics B",
    tenancyId: "ocid1.tenancy.oc1..analyticsb",
    userId: "ocid1.user.oc1..analyticsb",
    fingerprint: "bb:".repeat(15) + "bb",
    homeRegion: "us-phoenix-1",
    regions: ["us-phoenix-1"],
    status: "connected",
    lastSyncAt: now,
    lastError: null,
    createdAt: now,
  },
];
const instances: InstanceSummary[] = accounts.map((account, index) => ({
  id: `analytics-instance-${index + 1}`,
  accountId: account.id,
  accountName: account.name,
  displayName: index ? "Beta" : "Alpha",
  region: account.homeRegion,
  availabilityDomain: "fixture-ad",
  compartmentId: account.tenancyId,
  state: "RUNNING",
  shape: "VM.Standard.E2.1.Micro",
  ocpus: 1,
  memoryGb: 1,
  os: "Ubuntu",
  createdAt: now,
  vnics: (index ? [3] : [1, 2]).map((number) => ({
    id: `analytics-vnic-${number}`,
    name: `NIC-${number}`,
    primary: number !== 2,
    subnetId: "fixture-subnet",
    nsgIds: [],
    privateIps: [],
    ipv6: [],
  })),
  bootVolumes: index
    ? []
    : [
        {
          id: "analytics-boot-volume",
          accountId: account.id,
          region: account.homeRegion,
          name: "Boot disk",
          state: "AVAILABLE",
          sizeGb: 47,
          vpusPerGb: 10,
        },
      ],
  tags: {},
  syncedAt: now,
}));
type Record = { method: string; path: string; query: URLSearchParams };
type CostMode = "normal" | "zero" | "unknown" | "empty";
interface AnalyticsFixture {
  calls: Record[];
  unexpected: string[];
  trafficFactor: number;
  trafficPartial: boolean;
  failTrafficPost: boolean;
  failAccounts: boolean;
  costMode: CostMode;
  completedDelayed: number;
  accountsGate?: Promise<void>;
  delayedTraffic?: { accountId: string; gate: Promise<void> };
  count(path: string, method?: string): number;
  latest(path: string): Record | undefined;
}

function rangeOf(query: URLSearchParams): AnalyticsRange {
  const startDate = query.get("startDate") || "2026-11-01";
  const endDate = query.get("endDate") || "2026-11-07";
  const end = new Date(`${endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return {
    startDate,
    endDate,
    startTime: `${startDate}T00:00:00.000Z`,
    endTime: end.toISOString(),
    granularity: (query.get("granularity") || "daily") as AnalyticsRange["granularity"],
    timeZone: "UTC",
  };
}
function metadata(query: URLSearchParams) {
  return {
    range: rangeOf(query),
    generatedAt: now,
    cacheExpiresAt: "2026-11-07T12:40:00.000Z",
    cached: false,
    source: "oci" as const,
    accounts: accounts
      .filter((account) => !query.get("accountId") || account.id === query.get("accountId"))
      .map((account) => ({
        accountId: account.id,
        accountName: account.name,
        status: "ok" as const,
      })),
  };
}
function traffic(query: URLSearchParams, factor: number, partial = false): TrafficReport {
  const rows = instances
    .flatMap((instance) =>
      instance.vnics.map((vnic) => ({
        instanceId: instance.id,
        instanceName: instance.displayName,
        accountId: instance.accountId,
        accountName: instance.accountName,
        region: instance.region,
        vnicId: vnic.id,
        vnicName: vnic.name,
        receivedBytes: (vnic.id.endsWith("1") ? 1 : vnic.id.endsWith("2") ? 2 : 4) * factor * giB,
        sentBytes: factor * giB,
        coverage: partial ? ("partial" as const) : ("complete" as const),
      })),
    )
    .filter((row) =>
      ["accountId", "region", "instanceId", "vnicId"].every(
        (key) => !query.get(key) || row[key as keyof typeof row] === query.get(key),
      ),
    );
  const receivedBytes = rows.reduce((sum, row) => sum + row.receivedBytes, 0);
  const sentBytes = rows.reduce((sum, row) => sum + row.sentBytes, 0);
  return {
    ...metadata(query),
    rows,
    status: rows.length ? (partial ? "partial" : "ok") : "empty",
    warnings: ["仅统计当前库存网卡，不含已分离或删除的网卡。"],
    dataThrough: "2026-11-07T12:00:00.000Z",
    totals: { receivedBytes, sentBytes, totalBytes: receivedBytes + sentBytes },
    points: rows.length
      ? [
          {
            timestamp: `${query.get("startDate")}T00:00:00.000Z`,
            receivedBytes,
            sentBytes,
            coverage: partial ? "partial" : "complete",
          },
        ]
      : [],
  };
}
function costs(query: URLSearchParams, mode: CostMode): CostReport {
  const meta = metadata(query);
  const base: CostRow = {
    accountId: accounts[0].id,
    accountName: accounts[0].name,
    tenancyId: accounts[0].tenancyId,
    timestamp: meta.range.startTime,
    service: "Compute",
    region: accounts[0].homeRegion,
    resourceId: instances[0].id,
    resourceName: "Alpha",
    currency: "USD",
    amount: "0.1",
  };
  const second = new Date(meta.range.startTime);
  if (meta.range.granularity === "monthly") second.setUTCMonth(second.getUTCMonth() + 1);
  else second.setUTCDate(second.getUTCDate() + 1);
  const rows: CostRow[] =
    mode === "empty"
      ? []
      : mode === "zero" || mode === "unknown"
        ? [{ ...base, amount: mode === "zero" ? "0" : null }]
        : [
            base,
            { ...base, timestamp: second.toISOString(), amount: "0.2" },
            {
              ...base,
              service: "Storage",
              resourceId: "deleted-volume",
              resourceName: "Retired volume",
              amount: "1.25",
            },
            {
              ...base,
              service: "Storage",
              resourceId: "analytics-boot-volume",
              resourceName: null,
              amount: "0",
            },
            {
              ...base,
              service: "Networking",
              resourceId: "analytics-vnic-1",
              resourceName: null,
              amount: "0",
            },
            {
              ...base,
              accountId: accounts[1].id,
              accountName: accounts[1].name,
              tenancyId: accounts[1].tenancyId,
              region: accounts[1].homeRegion,
              resourceId: null,
              resourceName: null,
              currency: "CNY",
              amount: "2",
            },
          ];
  const selected = rows.filter(
    (row) => !query.get("accountId") || row.accountId === query.get("accountId"),
  );
  const totals =
    mode === "empty"
      ? []
      : mode === "zero" || mode === "unknown"
        ? [{ currency: "USD", amount: mode === "zero" ? "0" : null }]
        : [
            ...(selected.some((row) => row.currency === "USD")
              ? [{ currency: "USD", amount: "1.55" }]
              : []),
            ...(selected.some((row) => row.currency === "CNY")
              ? [{ currency: "CNY", amount: "2" }]
              : []),
          ];
  return {
    ...meta,
    rows: selected,
    totals,
    points: totals.map((item) => ({ ...item, timestamp: meta.range.startTime })),
    status: mode === "empty" ? "empty" : mode === "unknown" ? "partial" : "ok",
    warnings: mode === "unknown" ? ["模拟成本数据未完整返回"] : [],
  };
}

const test = base.extend<{ analyticsApi: AnalyticsFixture }>({
  analyticsApi: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL || "http://localhost:6240").origin;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
      throw new Error("Analytics UI tests require an isolated local server.");
    const errors: string[] = [];
    const state: AnalyticsFixture = {
      calls: [],
      unexpected: [],
      trafficFactor: 1,
      trafficPartial: false,
      failTrafficPost: false,
      failAccounts: false,
      costMode: "normal",
      completedDelayed: 0,
      count(path, method = "GET") {
        return state.calls.filter((call) => call.path === path && call.method === method).length;
      },
      latest(path) {
        return state.calls
          .slice()
          .reverse()
          .find((call) => call.path === path);
      },
    };
    const observe = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
    context.pages().forEach(observe);
    context.on("page", observe);
    await context.routeWebSocket("**/*", (socket) => {
      state.unexpected.push(`WS ${socket.url()}`);
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        method = request.method();
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (url.origin !== origin) {
        state.unexpected.push(`${method} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      if (!url.pathname.startsWith("/api/")) {
        if (request.headers()["rsc"] === "1") return route.abort();
        if (
          method === "GET" &&
          (url.pathname.startsWith("/_next/") ||
            /^\/flags\/[a-z]{2}\.svg$/.test(url.pathname) ||
            ["/traffic", "/costs", "/favicon.ico", "/oci-logo.png"].includes(url.pathname))
        )
          return route.continue();
      } else {
        state.calls.push({ method, path: url.pathname, query: url.searchParams });
        if (method === "GET" && url.pathname === "/api/auth/me")
          return json({
            user: { id: "analytics-user", username: "fixture", mfaEnabled: false },
          });
        if (method === "GET" && url.pathname === "/api/accounts") {
          if (state.accountsGate) await state.accountsGate;
          if (state.failAccounts) return json({ error: "模拟账号读取失败" }, 503);
          return json({ accounts, syncJobs: [] });
        }
        if (method === "GET" && url.pathname === "/api/instances") return json({ instances });
        if (["GET", "POST"].includes(method) && url.pathname === "/api/analytics/traffic") {
          if (method === "POST" && state.failTrafficPost)
            return json({ error: "模拟流量刷新失败" }, 503);
          const body = traffic(url.searchParams, state.trafficFactor, state.trafficPartial);
          if (state.delayedTraffic?.accountId === url.searchParams.get("accountId")) {
            await state.delayedTraffic.gate;
            await json(body);
            state.completedDelayed += 1;
            return;
          }
          return json(body);
        }
        if (["GET", "POST"].includes(method) && url.pathname === "/api/analytics/costs")
          return json(costs(url.searchParams, state.costMode));
      }
      state.unexpected.push(`${method} ${url.pathname}`);
      return json({ error: "Unmocked request blocked by analytics fixture" }, 501);
    });
    await use(state);
    expect(
      state.unexpected,
      "All unknown API, external and WebSocket requests must stay blocked",
    ).toEqual([]);
    expect(errors, "Analytics must not raise uncaught browser errors").toEqual([]);
  },
});
test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(now));
});

const metric = (page: Page, label: string) =>
  page
    .locator(".metric-card")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator(".metric-value");

for (const target of [
  { path: "/traffic", accountLabel: "流量账号", regionLabel: "流量区域" },
  { path: "/costs", accountLabel: "成本账号", regionLabel: "成本区域" },
]) {
  test(`${target.path} 日期预设在刷新和恢复可见时更新，自定义范围保持不变`, async ({
    page,
    analyticsApi,
  }) => {
    const apiPath = `/api/analytics${target.path}`;
    await page.goto(target.path);
    const refresh = page.getByRole("button", { name: "刷新数据", exact: true });
    await expect(refresh).toBeEnabled();
    await page.clock.setFixedTime(new Date("2026-11-08T12:30:00Z"));
    await refresh.click();
    await expect.poll(() => analyticsApi.latest(apiPath)?.query.get("endDate")).toBe("2026-11-08");
    await page.getByLabel("时间范围", { exact: true }).selectOption("last7");
    await expect
      .poll(() => analyticsApi.latest(apiPath)?.query.get("startDate"))
      .toBe("2026-11-02");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.clock.setFixedTime(new Date("2026-11-09T12:30:00Z"));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect
      .poll(() => analyticsApi.latest(apiPath)?.query.get("startDate"))
      .toBe("2026-11-03");
    await expect.poll(() => analyticsApi.latest(apiPath)?.query.get("endDate")).toBe("2026-11-09");
    await page.getByLabel("时间范围", { exact: true }).selectOption("custom");
    await page.getByLabel("开始日期（UTC）", { exact: true }).fill("2026-11-01");
    await page.getByLabel("结束日期（UTC）", { exact: true }).fill("2026-11-03");
    await page.getByRole("button", { name: "应用日期", exact: true }).click();
    await expect.poll(() => analyticsApi.latest(apiPath)?.query.get("endDate")).toBe("2026-11-03");
    await expect(refresh).toBeEnabled();
    await page.clock.setFixedTime(new Date("2026-11-10T12:30:00Z"));
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await refresh.click();
    await expect.poll(() => analyticsApi.count(apiPath, "POST")).toBe(1);
    expect(analyticsApi.latest(apiPath)?.query.get("startDate")).toBe("2026-11-01");
    expect(analyticsApi.latest(apiPath)?.query.get("endDate")).toBe("2026-11-03");
    await expect(page.getByLabel("时间范围", { exact: true })).toHaveValue("custom");
  });

  test(`${target.path} 常驻页面跨UTC日界时自动更新今天`, async ({ page, analyticsApi }) => {
    const apiPath = `/api/analytics${target.path}`;
    await page.clock.install({ time: new Date("2026-11-30T23:59:58Z") });
    await page.goto(target.path);
    await page.getByLabel("时间范围", { exact: true }).selectOption("today");
    await expect
      .poll(() => analyticsApi.latest(apiPath)?.query.get("startDate"))
      .toBe("2026-11-30");
    await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
    await page.clock.fastForward(3000);
    await expect
      .poll(() => analyticsApi.latest(apiPath)?.query.get("startDate"))
      .toBe("2026-12-01");
    expect(analyticsApi.latest(apiPath)?.query.get("endDate")).toBe("2026-12-01");
    expect(analyticsApi.count(apiPath, "POST")).toBe(0);
  });

  test(`${target.path} 首次账号读取失败保留账号链接并可原范围重试`, async ({
    page,
    analyticsApi,
  }) => {
    analyticsApi.failAccounts = true;
    await page.goto(`${target.path}?accountId=${accounts[0].id}`);
    await expect(page.locator("#main-content .alert-error")).toContainText("账号读取失败");
    await expect(page.getByRole("heading", { name: "先添加 OCI 账号", exact: true })).toHaveCount(
      0,
    );
    await expect(page).toHaveURL((url) => url.searchParams.get("accountId") === accounts[0].id);
    await expect(page.getByLabel(target.accountLabel, { exact: true })).toBeDisabled();
    expect(analyticsApi.count(`/api/analytics${target.path}`)).toBe(0);
    analyticsApi.failAccounts = false;
    await page.locator("#main-content .alert-error").getByRole("button", { name: "重试" }).click();
    await expect(page.getByLabel(target.accountLabel, { exact: true })).toHaveValue(accounts[0].id);
    await expect(page.locator("#main-content .alert-error")).toHaveCount(0);
    await expect
      .poll(() => analyticsApi.latest(`/api/analytics${target.path}`)?.query.get("accountId"))
      .toBe(accounts[0].id);
    await expect(page).toHaveURL((url) => url.searchParams.get("accountId") === accounts[0].id);
  });

  test(`${target.path} 总览账号链接等待校验，切换、前进后退和重载保留请求范围`, async ({
    page,
    analyticsApi,
  }) => {
    const apiPath = `/api/analytics${target.path}`;
    let release!: () => void;
    analyticsApi.accountsGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await page.goto(`${target.path}?accountId=${accounts[0].id}&keep=1#scope`);
      await expect.poll(() => analyticsApi.count("/api/accounts")).toBeGreaterThan(0);
      expect(analyticsApi.count(apiPath)).toBe(0);
      analyticsApi.accountsGate = undefined;
      release();
      const selector = page.getByLabel(target.accountLabel, { exact: true });
      await expect(selector).toHaveValue(accounts[0].id);
      await expect
        .poll(() => analyticsApi.latest(apiPath)?.query.get("accountId"))
        .toBe(accounts[0].id);
      expect(
        analyticsApi.calls
          .filter((call) => call.path === apiPath)
          .every((call) => call.query.get("accountId") === accounts[0].id),
      ).toBe(true);

      await selector.selectOption(accounts[1].id);
      await expect
        .poll(() => analyticsApi.latest(apiPath)?.query.get("accountId"))
        .toBe(accounts[1].id);
      await expect(page).toHaveURL(
        new RegExp(`${target.path}\\?accountId=${accounts[1].id}&keep=1#scope$`),
      );
      await page
        .getByLabel(target.regionLabel, { exact: true })
        .selectOption(accounts[1].homeRegion);
      if (target.path === "/traffic") {
        await page.getByLabel("流量实例", { exact: true }).selectOption(instances[1].id);
        await page.getByLabel("流量网卡", { exact: true }).selectOption("analytics-vnic-3");
        await expect
          .poll(() => analyticsApi.latest(apiPath)?.query.get("vnicId"))
          .toBe("analytics-vnic-3");
      }
      const beforeBack = analyticsApi.calls.length;
      await page.goBack();
      await expect(selector).toHaveValue(accounts[0].id);
      await expect(page.getByLabel(target.regionLabel, { exact: true })).toHaveValue("");
      await expect
        .poll(() => analyticsApi.latest(apiPath)?.query.get("accountId"))
        .toBe(accounts[0].id);
      expect(
        analyticsApi.calls
          .slice(beforeBack)
          .filter((call) => call.path === apiPath)
          .every(
            (call) =>
              call.query.get("accountId") === accounts[0].id &&
              !call.query.has("region") &&
              !call.query.has("instanceId") &&
              !call.query.has("vnicId"),
          ),
      ).toBe(true);
      await page.goForward();
      await expect(selector).toHaveValue(accounts[1].id);
      await expect
        .poll(() => analyticsApi.latest(apiPath)?.query.get("accountId"))
        .toBe(accounts[1].id);
      await page.reload();
      await expect(selector).toHaveValue(accounts[1].id);
      await expect
        .poll(() => analyticsApi.latest(apiPath)?.query.get("accountId"))
        .toBe(accounts[1].id);
    } finally {
      release();
      analyticsApi.accountsGate = undefined;
    }
  });

  test(`${target.path} 失效账号链接回到有效的全部账号范围`, async ({ page, analyticsApi }) => {
    const apiPath = `/api/analytics${target.path}`;
    await page.goto(`${target.path}?accountId=removed-account&keep=1#scope`);
    await expect(page.getByLabel(target.accountLabel, { exact: true })).toHaveValue("");
    await expect(page).toHaveURL(new RegExp(`${target.path}\\?keep=1#scope$`));
    await expect.poll(() => analyticsApi.count(apiPath)).toBeGreaterThan(0);
    expect(
      analyticsApi.calls
        .filter((call) => call.path === apiPath)
        .every((call) => !call.query.has("accountId")),
    ).toBe(true);
  });
}

async function capture(page: Page, info: TestInfo, name: string) {
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath(`${name}.png`),
      fullPage: true,
      animations: "disabled",
    });
}

test("流量按账号、区域、实例、网卡筛选并使用UTC日期范围", async ({ page, analyticsApi }) => {
  await page.goto("/traffic");
  await expect(page.locator(".analytics-table tbody tr")).toHaveCount(3);
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "统计说明", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("不含已分离或删除的网卡");
  await page.getByRole("dialog").getByRole("button", { name: "关闭对话框", exact: true }).click();
  expect(analyticsApi.latest("/api/analytics/traffic")?.query.get("startDate")).toBe("2026-11-01");
  await page.getByLabel("流量账号", { exact: true }).selectOption(accounts[0].id);
  await page.getByLabel("流量区域", { exact: true }).selectOption(accounts[0].homeRegion);
  await page.getByLabel("流量实例", { exact: true }).selectOption(instances[0].id);
  await page.getByLabel("流量网卡", { exact: true }).selectOption("analytics-vnic-2");
  await expect(page.locator(".analytics-table tbody tr")).toHaveCount(1);
  await expect(metric(page, "接收流量")).toHaveText("2 GiB");
  await page.getByLabel("时间范围", { exact: true }).selectOption("last7");
  await page.getByLabel("流量统计粒度", { exact: true }).selectOption("hourly");
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/traffic")?.query.get("granularity"))
    .toBe("hourly");
  const query = analyticsApi.latest("/api/analytics/traffic")!.query;
  expect(Object.fromEntries(query)).toMatchObject({
    accountId: accounts[0].id,
    region: accounts[0].homeRegion,
    instanceId: instances[0].id,
    vnicId: "analytics-vnic-2",
    startDate: "2026-11-01",
    endDate: "2026-11-07",
  });
  await expect(page.getByText("截至 2026/11/07 12:00 UTC", { exact: true })).toBeVisible();
});

test("部分流量区间显示已观测小计，图表和提示仍可见", async ({ page, analyticsApi }) => {
  analyticsApi.trafficPartial = true;
  await page.goto("/traffic");
  const chart = page.getByRole("img", { name: "网卡接收与发送流量趋势", exact: true });
  await expect(chart).toBeVisible();
  await expect(chart.locator(".recharts-line-dot")).toHaveCount(2);
  await expect(page.locator(".analytics-legend")).toContainText("接收（已获取）");
  await expect(page.locator(".analytics-legend")).toContainText("发送（已获取）");
  await expect(
    page.locator(".heading-actions").getByRole("button", { name: "部分数据", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".metric-note").first()).toHaveText("已获取小计");
  await expect(page.getByText("所选范围暂无流量数据", { exact: true })).toHaveCount(0);
  await chart.locator(".recharts-line-dot").first().hover();
  await expect(page.locator(".recharts-tooltip-label")).toContainText("部分数据（已观测小计）");
});

test("手动刷新使用POST，失败保留已显示流量", async ({ page, analyticsApi }) => {
  await page.goto("/traffic");
  await expect(metric(page, "接收流量")).toHaveText("7 GiB");
  analyticsApi.trafficFactor = 2;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(metric(page, "接收流量")).toHaveText("14 GiB");
  expect(analyticsApi.count("/api/analytics/traffic", "POST")).toBe(1);
  analyticsApi.failTrafficPost = true;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.getByText("模拟流量刷新失败", { exact: true })).toBeVisible();
  await expect(metric(page, "接收流量")).toHaveText("14 GiB");
  await expect(page.locator(".analytics-table tbody tr")).toHaveCount(3);
});

test("旧筛选的慢响应不覆盖新筛选数据", async ({ page, analyticsApi }) => {
  await page.goto("/traffic");
  await expect(metric(page, "接收流量")).toHaveText("7 GiB");
  let release!: () => void;
  analyticsApi.delayedTraffic = {
    accountId: accounts[0].id,
    gate: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await page.getByLabel("流量账号", { exact: true }).selectOption(accounts[0].id);
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/traffic")?.query.get("accountId"))
    .toBe(accounts[0].id);
  await page.getByLabel("流量账号", { exact: true }).selectOption(accounts[1].id);
  await expect(metric(page, "接收流量")).toHaveText("4 GiB");
  release();
  await expect.poll(() => analyticsApi.completedDelayed).toBe(1);
  await expect(page.locator(".analytics-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".analytics-table tbody")).toContainText("Beta");
  await expect(metric(page, "接收流量")).toHaveText("4 GiB");
});

test("成本按币种分开并在客户端筛选区域服务，保留库存外资源", async ({ page, analyticsApi }) => {
  await page.goto("/costs");
  await expect(metric(page, "USD · 已报告成本")).toHaveText("1.55");
  await expect(metric(page, "CNY · 已报告成本")).toHaveText("2.00");
  await expect(
    page.getByRole("img", { name: "USD 已报告成本时间趋势", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "CNY 已报告成本时间趋势", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".analytics-cost-table")).toContainText("Retired volume");
  await expect(page.locator(".analytics-cost-table")).toContainText("未归属资源");
  for (const name of ["Boot disk", "NIC-1"]) {
    const row = page
      .locator(".analytics-cost-table tbody tr")
      .filter({ has: page.getByRole("link", { name, exact: true }) });
    await expect(row).toContainText("关联实例 Alpha");
    await expect(row.getByRole("link", { name, exact: true })).toHaveAttribute(
      "href",
      `/instances/${instances[0].id}`,
    );
  }
  const before = analyticsApi.count("/api/analytics/costs");
  await page.getByLabel("成本区域", { exact: true }).selectOption("ap-tokyo-1");
  await page.getByLabel("成本服务", { exact: true }).selectOption("Compute");
  await expect(metric(page, "USD · 已获取小计")).toHaveText("0.30");
  await expect(page.locator(".analytics-cost-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".analytics-cost-table a")).toHaveAttribute(
    "href",
    `/instances/${instances[0].id}`,
  );
  expect(analyticsApi.count("/api/analytics/costs")).toBe(before);
});

test("零成本、缺失金额、部分返回与空记录保持不同状态", async ({ page, analyticsApi }) => {
  analyticsApi.costMode = "zero";
  await page.goto("/costs");
  await expect(metric(page, "USD · 已报告成本")).toHaveText("0.00");
  const zeroPoint = page
    .getByRole("img", { name: "USD 已报告成本时间趋势", exact: true })
    .locator(".recharts-line-dot");
  await expect(zeroPoint).toHaveCount(1);
  await expect(zeroPoint).toBeVisible();
  analyticsApi.costMode = "unknown";
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(metric(page, "USD · 已获取小计")).toHaveText("—");
  await page
    .locator(".heading-actions")
    .getByRole("button", { name: "部分数据", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("模拟成本数据未完整返回");
  await page.getByRole("dialog").getByRole("button", { name: "关闭对话框", exact: true }).click();
  await expect(page.getByText("暂无可绘制的成本数据", { exact: true })).toBeVisible();
  analyticsApi.costMode = "empty";
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect(page.getByText("暂无已报告成本", { exact: true })).toBeVisible();
  await expect(page.locator(".analytics-metrics .metric-card")).toHaveCount(0);
});

test("月成本默认过去12完整月，自定义拒绝非完整月", async ({ page, analyticsApi }) => {
  await page.goto("/costs");
  await expect(metric(page, "USD · 已报告成本")).toBeVisible();
  await page.getByLabel("成本统计粒度", { exact: true }).selectOption("monthly");
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/costs")?.query.get("granularity"))
    .toBe("monthly");
  expect(Object.fromEntries(analyticsApi.latest("/api/analytics/costs")!.query)).toMatchObject({
    startDate: "2025-11-01",
    endDate: "2026-10-31",
  });
  await page.getByLabel("时间范围", { exact: true }).selectOption("custom");
  await page.getByLabel("结束日期（UTC）", { exact: true }).fill("2026-09-30");
  await page.getByLabel("开始日期（UTC）", { exact: true }).fill("2026-09-02");
  await expect(page.getByRole("button", { name: "应用日期", exact: true })).toBeDisabled();
  await page.getByLabel("开始日期（UTC）", { exact: true }).fill("2026-09-01");
  await page.getByRole("button", { name: "应用日期", exact: true }).click();
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/costs")?.query.get("startDate"))
    .toBe("2026-09-01");
  expect(analyticsApi.latest("/api/analytics/costs")?.query.get("endDate")).toBe("2026-09-30");
});

test("月成本常驻跨月后滚动过去12个完整月", async ({ page, analyticsApi }) => {
  await page.clock.install({ time: new Date("2026-11-30T23:59:58Z") });
  await page.goto("/costs");
  await page.getByLabel("成本统计粒度", { exact: true }).selectOption("monthly");
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/costs")?.query.get("startDate"))
    .toBe("2025-11-01");
  expect(analyticsApi.latest("/api/analytics/costs")?.query.get("endDate")).toBe("2026-10-31");
  await expect(page.getByRole("button", { name: "刷新数据", exact: true })).toBeEnabled();
  await page.clock.fastForward(3000);
  await expect
    .poll(() => analyticsApi.latest("/api/analytics/costs")?.query.get("startDate"))
    .toBe("2025-12-01");
  expect(analyticsApi.latest("/api/analytics/costs")?.query.get("endDate")).toBe("2026-11-30");
  await expect(page.getByLabel("时间范围", { exact: true })).toHaveValue("last12Months");
});

for (const pageName of ["traffic", "costs"] as const) {
  test(`${pageName} 桌面和390px布局保持内容可读且不撑宽页面`, async ({
    page,
    analyticsApi,
  }, info) => {
    void analyticsApi;
    await page.goto(`/${pageName}`);
    await expect(page.locator(".analytics-table tbody tr").first()).toBeVisible();
    await expect(page.locator(".analytics-chart").first()).toBeVisible();
    await expect(page.locator(".heading-actions .updated-at time")).toHaveAttribute(
      "datetime",
      now,
    );
    await expect(page.getByRole("search")).toHaveCount(0);
    for (const width of [1440, 2191]) {
      await page.setViewportSize({ width, height: 1039 });
      const positions = await page
        .locator(".analytics-controls select")
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top));
      expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
    }
    await expect(page.locator(".topbar")).toHaveCount(0);
    await page.evaluate(() => window.scrollTo(0, 500));
    await expect
      .poll(() =>
        page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBe(0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.setViewportSize({ width: 1440, height: 1080 });
    await capture(page, info, `${pageName}-desktop`);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      .toBe(true);
    const scroll = await page
      .locator(".table-scroll")
      .first()
      .evaluate((element) => ({ visible: element.clientWidth, content: element.scrollWidth }));
    expect(scroll.content).toBeGreaterThan(scroll.visible);
    await capture(page, info, `${pageName}-mobile`);
    const menu = page.getByRole("button", { name: "展开导航", exact: true });
    const sidebar = page.locator(".sidebar");
    await expect(sidebar).toHaveAttribute("inert", "");
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await expect(sidebar).toHaveAttribute("aria-modal", "true");
    await expect(page.locator(".app-main")).toHaveAttribute("inert", "");
    await expect(page.locator(".toast-stack")).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "关闭导航", exact: true })).toBeFocused();
    const logout = sidebar.getByRole("button", { name: "退出登录", exact: true });
    await logout.focus();
    await page.keyboard.press("Tab");
    await expect(sidebar.getByRole("link", { name: "OCI Dash", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(logout).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(menu).toBeFocused();
    await expect(page.locator(".app-main")).not.toHaveAttribute("inert", "");
    await expect(page.locator(".toast-stack")).not.toHaveAttribute("inert", "");
    await menu.click();
    await page.locator(".sidebar-backdrop").click({ position: { x: 300, y: 100 } });
    await expect(sidebar).toHaveAttribute("inert", "");
    await expect(menu).toBeFocused();
    await menu.click();
    await sidebar.locator('a[aria-current="page"]').click();
    await expect(sidebar).toHaveAttribute("inert", "");
    await menu.click();
    await page.setViewportSize({ width: 1440, height: 1080 });
    await expect(sidebar).not.toHaveAttribute("inert", "");
    await expect(sidebar).not.toHaveAttribute("aria-modal", "true");
    await expect(sidebar.locator('a[aria-current="page"]')).toBeFocused();
  });
}
