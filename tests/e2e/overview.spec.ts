import { expect, test as base, type Page } from "@playwright/test";
import type { AccountSummary } from "../../src/lib/contracts";
import type { CostReport, TrafficReport } from "../../src/lib/analytics-contracts";
import type { CpuReport } from "../../src/lib/cpu-contracts";

const NOW = Date.parse("2026-11-08T00:10:00Z");
const DAY = 86_400_000;
const GIB = 1024 ** 3;
const accounts: AccountSummary[] = ["a", "b"].map((id, index) => ({
  id,
  name: "Account " + id.toUpperCase(),
  tenancyId: "fixture-tenancy-" + id,
  userId: "fixture-user-" + id,
  fingerprint: "aa:".repeat(15) + "aa",
  homeRegion: index ? "ap-tokyo-1" : "ap-singapore-1",
  regions: [index ? "ap-tokyo-1" : "ap-singapore-1"],
  status: "connected",
  lastSyncAt: new Date(NOW).toISOString(),
  lastError: null,
  createdAt: new Date(NOW).toISOString(),
}));
const resources = [
  { id: "sg", name: "SG-Oracle-01", account: accounts[0], fraction: 0.64, vnics: 2 },
  { id: "jp", name: "JP-Oracle-01", account: accounts[1], fraction: 0.26, vnics: 1 },
  { id: "standby", name: "JP-Standby", account: accounts[1], fraction: 0.1, vnics: 1 },
];
interface Fixture {
  calls: { path: string; method: string; params: URLSearchParams }[];
  failTraffic: boolean;
  missingTrafficDirection: boolean;
  emptyCpu: boolean;
  zeroCost: boolean;
  expiryMs: number;
  now: number;
  costGate?: Promise<void>;
  trafficGate?: { account: string; promise: Promise<void> };
  count(path: string, method?: string): number;
}
const test = base.extend<{ overview: Fixture }>({
  overview: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [],
        errors: string[] = [];
      const state: Fixture = {
        calls: [],
        failTraffic: false,
        missingTrafficDirection: false,
        emptyCpu: false,
        zeroCost: false,
        now: NOW,
        expiryMs: 300_000,
        count(path, method = "GET") {
          return this.calls.filter((call) => call.path === path && call.method === method).length;
        },
      };
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
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
        if (!url.pathname.startsWith("/api/")) {
          if (request.headers()["rsc"] === "1") return route.abort();
          return route.continue();
        }
        const params = url.searchParams;
        state.calls.push({ path: url.pathname, method: request.method(), params });
        const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
        if (url.pathname === "/api/auth/me")
          return json({
            user: { id: "fixture", username: "admin", mfaEnabled: false },
          });
        if (url.pathname === "/api/accounts") return json({ accounts, syncJobs: [] });
        const selected = resources.filter(
          (resource) => !params.get("accountId") || resource.account.id === params.get("accountId"),
        );
        const startDate = params.get("startDate") || "2026-11-01",
          endDate = params.get("endDate") || "2026-11-07";
        const start = Date.parse(startDate + "T00:00:00Z"),
          end = Date.parse(endDate + "T00:00:00Z") + DAY;
        const days = Array.from({ length: (end - start) / DAY }, (_, day) =>
          new Date(start + day * DAY).toISOString(),
        );
        const metadata = {
          range: {
            startDate,
            endDate,
            startTime: new Date(start).toISOString(),
            endTime: new Date(end).toISOString(),
            granularity: "daily" as const,
            timeZone: "UTC" as const,
          },
          generatedAt: new Date(state.now).toISOString(),
          cacheExpiresAt: new Date(state.now + state.expiryMs).toISOString(),
          cached: false,
          source: "oci" as const,
          accounts: accounts
            .filter((account) => !params.get("accountId") || account.id === params.get("accountId"))
            .map((account) => ({
              accountId: account.id,
              accountName: account.name,
              status: "ok" as const,
            })),
        };
        if (url.pathname === "/api/analytics/traffic") {
          if (state.failTraffic) return json({ error: "Fixture traffic unavailable" }, 503);
          const rows: TrafficReport["rows"] = selected.flatMap((resource) =>
            Array.from({ length: resource.vnics }, (_, nic) => ({
              instanceId: resource.id,
              instanceName: resource.name,
              accountId: resource.account.id,
              accountName: resource.account.name,
              region: resource.account.homeRegion,
              vnicId: resource.id + "-" + nic,
              vnicName: "NIC " + nic,
              sentBytes: Math.round((269.8 * GIB * resource.fraction) / resource.vnics),
              receivedBytes: Math.round((158.8 * GIB * resource.fraction) / resource.vnics),
              coverage: "complete" as const,
            })),
          );
          if (state.missingTrafficDirection) {
            const unavailable = rows.find((row) => row.instanceId === "standby");
            if (unavailable) {
              unavailable.sentBytes = null;
              unavailable.coverage = "partial";
            }
          }
          const sum = (field: "sentBytes" | "receivedBytes") =>
            rows.reduce((total, row) => total + (row[field] ?? 0), 0);
          const body: TrafficReport = {
            ...metadata,
            rows,
            status: state.missingTrafficDirection ? "partial" : "ok",
            warnings: [],
            dataThrough: new Date(end).toISOString(),
            totals: {
              sentBytes: sum("sentBytes"),
              receivedBytes: sum("receivedBytes"),
              totalBytes: sum("sentBytes") + sum("receivedBytes"),
            },
            points: days.map((timestamp, index) => ({
              timestamp,
              sentBytes: Math.round(
                (sum("sentBytes") * (index + 1)) / ((days.length * (days.length + 1)) / 2),
              ),
              receivedBytes: Math.round(
                (sum("receivedBytes") * (index + 1)) / ((days.length * (days.length + 1)) / 2),
              ),
              coverage: state.missingTrafficDirection ? "partial" : "complete",
            })),
          };
          if (state.trafficGate?.account === params.get("accountId"))
            await state.trafficGate.promise;
          return json(body);
        }
        if (url.pathname === "/api/analytics/costs") {
          if (state.costGate) await state.costGate;
          const rows = days
            .flatMap((timestamp) => [
              {
                accountId: "a",
                accountName: "Account A",
                tenancyId: "fixture-a",
                timestamp,
                service: "计算",
                region: "ap-singapore-1",
                resourceId: "sg",
                resourceName: "SG",
                currency: "EUR",
                amount: state.zeroCost ? "0" : "0.10",
              },
              {
                accountId: "a",
                accountName: "Account A",
                tenancyId: "fixture-a",
                timestamp,
                service: "存储",
                region: "ap-singapore-1",
                resourceId: "disk",
                resourceName: "Disk",
                currency: "EUR",
                amount: state.zeroCost ? "0" : "0.05",
              },
              {
                accountId: "b",
                accountName: "Account B",
                tenancyId: "fixture-b",
                timestamp,
                service: "网络",
                region: "ap-tokyo-1",
                resourceId: "jp",
                resourceName: "JP",
                currency: "USD",
                amount: "0.20",
              },
            ])
            .filter((row) => !params.get("accountId") || params.get("accountId") === row.accountId);
          const currencies = [...new Set(rows.map((row) => row.currency))];
          const body: CostReport = {
            ...metadata,
            status: "ok",
            warnings: [],
            rows,
            totals: currencies.map((currency) => ({
              currency,
              amount: rows
                .filter((row) => row.currency === currency)
                .reduce((sum, row) => sum + Number(row.amount), 0)
                .toFixed(2),
            })),
            points: days.flatMap((timestamp) =>
              currencies.map((currency) => ({
                timestamp,
                currency,
                amount: rows
                  .filter((row) => row.timestamp === timestamp && row.currency === currency)
                  .reduce((sum, row) => sum + Number(row.amount), 0)
                  .toFixed(2),
              })),
            ),
          };
          return json(body);
        }
        if (url.pathname === "/api/analytics/cpu") {
          const cpuEnd = Math.floor(state.now / 3_600_000) * 3_600_000,
            cpuStart = cpuEnd - DAY;
          const rows = selected.map((resource, index) => {
            const points = Array.from({ length: 24 }, (_, hour) => {
              const value =
                state.emptyCpu || resource.id === "standby" || (index === 1 && hour === 5)
                  ? null
                  : index === 0 && hour === 0
                    ? 0
                    : (hour + 2) * (index + 1);
              return {
                timestamp: new Date(cpuStart + hour * 3_600_000).toISOString(),
                cpuPercent: value,
                sampleCount: value === null ? 0 : 12,
                expectedSamples: 12 as const,
                coverage: value === null ? ("unavailable" as const) : ("complete" as const),
              };
            });
            const values = points.flatMap((point) =>
              point.cpuPercent === null ? [] : [point.cpuPercent],
            );
            return {
              instanceId: resource.id,
              instanceName: resource.name,
              accountId: resource.account.id,
              accountName: resource.account.name,
              region: resource.account.homeRegion,
              state: resource.id === "standby" ? "STOPPED" : "RUNNING",
              points,
              averageCpuPercent: values.length
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null,
              peakCpuPercent: values.length ? Math.max(...values) : null,
              sampleCount: values.length * 12,
              coverage:
                values.length === 24
                  ? ("complete" as const)
                  : values.length
                    ? ("partial" as const)
                    : ("unavailable" as const),
            };
          });
          const points = Array.from({ length: 24 }, (_, hour) => {
            const values = rows.flatMap((row) =>
              row.points[hour].cpuPercent === null ? [] : [row.points[hour].cpuPercent!],
            );
            return {
              timestamp: new Date(cpuStart + hour * 3_600_000).toISOString(),
              cpuPercent: values.length
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null,
              instanceCount: values.length,
              totalInstances: rows.length,
              sampleCount: values.length * 12,
              coverage: values.length ? ("partial" as const) : ("unavailable" as const),
            };
          });
          const values = points.flatMap((point) =>
            point.cpuPercent === null ? [] : [point.cpuPercent],
          );
          const body: CpuReport = {
            ...metadata,
            range: {
              startTime: new Date(cpuStart).toISOString(),
              endTime: new Date(cpuEnd).toISOString(),
              granularity: "hourly",
              timeZone: "UTC",
            },
            rows,
            points,
            status: values.length ? "partial" : "empty",
            warnings: ["CPU 缺失样本为空"],
            summary: {
              averageCpuPercent: values.length
                ? values.reduce((sum, value) => sum + value, 0) / values.length
                : null,
              peakCpuPercent: values.length
                ? Math.max(
                    ...rows.flatMap((row) =>
                      row.peakCpuPercent === null ? [] : [row.peakCpuPercent],
                    ),
                  )
                : null,
              instancesWithSamples: rows.filter((row) => row.sampleCount).length,
              totalInstances: rows.length,
              observedHours: values.length,
              totalSamples: rows.reduce((sum, row) => sum + row.sampleCount, 0),
            },
          };
          return json(body);
        }
        unexpected.push(request.method() + " " + url.pathname);
        return json({ error: "Unmocked overview request" }, 501);
      });
      await use(state);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});
test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date(NOW));
});
const summary = (page: Page, label: string) =>
  page
    .locator(".overview-summary")
    .filter({ has: page.getByRole("heading", { name: label, exact: true }) })
    .locator("strong");

test("四类图表读取真实契约，双网卡按实例合并，日期为完整UTC七天", async ({ page, overview }) => {
  await page.goto("/overview");
  await expect(page.getByRole("heading", { name: "数据总览", exact: true })).toBeVisible();
  await expect(summary(page, "发送流量")).toHaveText("269.8");
  await expect(summary(page, "接收流量")).toHaveText("158.8");
  await expect(page.locator(".overview-ranking li")).toHaveCount(3);
  await expect(page.locator(".overview-ranking li").first()).toContainText("274.3 GiB");
  await expect(page.locator(".overview-cost-summary strong")).toHaveText("1.05");
  await expect(page.locator(".topbar")).toHaveCount(0);
  await expect(page.getByRole("img", { name: "每日发送与接收流量，单位 GiB" })).toBeVisible();
  expect(overview.count("/api/analytics/traffic")).toBe(1);
  expect(overview.count("/api/analytics/cpu")).toBe(1);
  const query = overview.calls.find((call) => call.path === "/api/analytics/traffic")!.params;
  expect(query.get("startDate")).toBe("2026-11-01");
  expect(query.get("endDate")).toBe("2026-11-07");
  await expect
    .poll(() =>
      page
        .locator(".overview-ranking img")
        .first()
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  const flag = await page.locator(".overview-ranking img").first().boundingBox();
  expect(flag?.width).toBe(16);
  expect(flag?.height).toBe(12);
});

test("部分实例缺少一个方向时排行占比仍使用全部已观测流量", async ({ page, overview }) => {
  overview.missingTrafficDirection = true;
  await page.goto("/overview");
  await expect(page.locator(".overview-chart-total")).toHaveText("已获取 401.6 GiB");
  await expect(page.locator(".overview-ranking li").first()).toContainText("占已获取流量 68.3%");
  await expect(page.locator(".overview-ranking li").last()).toContainText("— GiB");
  await expect(page.locator(".overview-chart-caption")).not.toContainText("流量最高");
});

test("费用慢请求不阻塞流量，筛选与分币种统计独立更新", async ({ page, overview }) => {
  let release!: () => void;
  overview.costGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.goto("/overview");
    await expect(summary(page, "发送流量")).toHaveText("269.8");
    await expect(page.locator(".overview-cost").getByText("正在读取统计…")).toBeVisible();
    const refresh = page.getByRole("button", { name: "刷新总览", exact: true });
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute("aria-busy", "true");
    await expect(refresh.locator("svg")).toHaveCount(1);
    await expect(refresh.locator("svg")).toHaveCSS("animation-name", "spin");
    await expect(refresh.locator("svg")).toHaveCSS("animation-duration", "1s");
    await expect(refresh.locator("svg")).toHaveCSS("animation-timing-function", "linear");
  } finally {
    release();
    overview.costGate = undefined;
  }
  await page.getByLabel("总览费用币种").selectOption("USD");
  await expect(page.locator(".overview-cost-summary strong")).toHaveText("1.40");
  const cpuCalls = overview.count("/api/analytics/cpu");
  await page.getByLabel("总览时间范围").selectOption("30d");
  await expect(page.locator(".overview-cost-summary strong")).toHaveText("6.00");
  expect(overview.count("/api/analytics/cpu")).toBe(cpuCalls);
  await page.getByLabel("总览账号").selectOption("a");
  await expect(page.locator(".overview-ranking li")).toHaveCount(1);
  await expect(summary(page, "发送流量")).toHaveText("172.7");
  await expect(page.locator(".overview-cost-summary strong")).toHaveText("4.50");
});

test("刷新失败保留已加载统计，恢复后可重试", async ({ page, overview }) => {
  await page.goto("/overview");
  await expect(page.getByRole("button", { name: "刷新总览" })).toBeEnabled();
  await expect(summary(page, "发送流量")).toHaveText("269.8");
  overview.failTraffic = true;
  await page.getByRole("button", { name: "刷新总览" }).click();
  await expect(
    page.locator(".overview-flow").getByRole("button", { name: "更新失败 · 重试" }),
  ).toBeVisible();
  await expect(summary(page, "发送流量")).toHaveText("269.8");
  expect(overview.count("/api/analytics/traffic", "POST")).toBe(1);
  overview.failTraffic = false;
  await page.locator(".overview-flow").getByRole("button", { name: "更新失败 · 重试" }).click();
  await expect(page.locator(".overview-flow .overview-retry")).toHaveCount(0);
});

test("缺失CPU与零费用有不同的显示状态", async ({ page, overview }) => {
  overview.emptyCpu = true;
  overview.zeroCost = true;
  await page.goto("/overview");
  await expect(summary(page, "平均 CPU")).toHaveText("—");
  await expect(page.locator(".overview-cost-summary strong")).toHaveText("0.00");
  await expect(page.getByText("本期已报告费用为 0")).toBeVisible();
  await expect(page.locator(".overview-load")).toContainText("无样本");
});

test("CPU热图区分零与缺失，并支持键盘查看小时明细", async ({ page }) => {
  await page.goto("/overview");
  const zero = page.getByRole("button", { name: /^SG-Oracle-01，.*CPU 0%/ });
  await zero.focus();
  await expect(page.getByRole("tooltip")).toContainText("0%");
  await expect(zero).toHaveAttribute("data-level", "0");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tooltip")).toContainText("01:00");
  await expect(page.getByRole("tooltip")).toContainText("3%");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: /^SG-Oracle-01，.*CPU 3%/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toHaveCount(0);
  const missing = page.getByRole("button", { name: /^JP-Standby，.*无样本/ }).first();
  await missing.click();
  await expect(missing).toHaveAttribute("data-level", "5");
  await expect(page.getByRole("tooltip")).toContainText("无数据");
});

test("快速切换账号时旧请求不能覆盖新筛选结果", async ({ page, overview }) => {
  await page.goto("/overview");
  await expect(page.locator(".overview-ranking li")).toHaveCount(3);
  let release!: () => void;
  overview.trafficGate = {
    account: "a",
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  await page.getByLabel("总览账号").selectOption("a");
  await expect
    .poll(() =>
      overview.calls.some(
        (call) => call.path === "/api/analytics/traffic" && call.params.get("accountId") === "a",
      ),
    )
    .toBe(true);
  await page.getByLabel("总览账号").selectOption("b");
  await expect(page.locator(".overview-ranking li")).toHaveCount(2);
  release();
  await expect(summary(page, "发送流量")).toHaveText("97.1");
  await expect(page.locator(".overview-ranking")).not.toContainText("SG-Oracle-01");
});

test("按缓存期限刷新且隐藏页面暂停统计查询", async ({ page, overview }) => {
  await page.clock.install({ time: NOW });
  overview.expiryMs = 5000;
  await page.goto("/overview");
  await expect(page.locator(".overview-ranking li")).toHaveCount(3);
  const before = overview.count("/api/analytics/traffic");
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  overview.now += 10_000;
  await page.clock.fastForward(10_000);
  expect(overview.count("/api/analytics/traffic")).toBe(before);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  overview.now += 1001;
  await page.clock.fastForward(1001);
  await expect.poll(() => overview.count("/api/analytics/traffic")).toBe(before + 1);
  expect(overview.count("/api/analytics/traffic", "POST")).toBe(0);
});

test("常驻页面跨UTC月份后本月统计自动切换到新月份", async ({ page, overview }) => {
  const monthEnd = Date.parse("2026-11-30T23:59:58Z");
  overview.now = monthEnd;
  await page.clock.install({ time: monthEnd });
  await page.goto("/overview");
  await page.getByLabel("总览时间范围").selectOption("month");
  await expect
    .poll(() =>
      overview.calls
        .filter((call) => call.path === "/api/analytics/traffic")
        .at(-1)
        ?.params.get("endDate"),
    )
    .toBe("2026-11-30");
  await expect(page.getByRole("button", { name: "刷新总览" })).toBeEnabled();
  overview.now += 3000;
  await page.clock.fastForward(3000);
  await expect
    .poll(() =>
      overview.calls
        .filter((call) => call.path === "/api/analytics/traffic")
        .at(-1)
        ?.params.get("startDate"),
    )
    .toBe("2026-12-01");
  await expect(page.locator(".data-overview .page-heading p")).toContainText(
    "2026.12.01 — 2026.12.01",
  );
});

test("客户端时钟超前时不会每秒重复查询旧缓存", async ({ page, overview }) => {
  await page.clock.install({ time: NOW });
  overview.now = NOW - 600_000;
  await page.goto("/overview");
  await expect(page.locator(".overview-ranking li")).toHaveCount(3);
  const before = overview.count("/api/analytics/traffic");
  await page.clock.fastForward(5000);
  expect(overview.count("/api/analytics/traffic")).toBe(before);
  await page.clock.fastForward(25_001);
  await expect.poll(() => overview.count("/api/analytics/traffic")).toBe(before + 1);
  await page.clock.fastForward(5000);
  expect(overview.count("/api/analytics/traffic")).toBe(before + 1);
});

test("桌面图表布局与390px窄屏、深色主题均无页面横向溢出", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/overview");
  await expect(summary(page, "发送流量")).toHaveText("269.8");
  await expect(page.locator(".overview-load")).toContainText("SG-Oracle-01");
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath("overview-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath("overview-dark.png"),
      fullPage: true,
      animations: "disabled",
    });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
  await expect(page.getByRole("button", { name: "展开导航" })).toBeVisible();
  if (process.env.E2E_SCREENSHOTS === "1")
    await page.screenshot({
      path: info.outputPath("overview-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
});
