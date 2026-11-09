import { expect, test as base, type Locator, type Page } from "@playwright/test";
import { jobContextFixture, jobPageFixture } from "../fixtures/job-page";
import type {
  AccountSummary,
  InstanceSummary,
  InventoryRefreshResult,
  JobSummary,
  OperationRequest,
  PublicIpBinding,
  VnicSummary,
} from "../../src/lib/contracts";

// This suite loads only an isolated local UI. All API/WS traffic is intercepted;
// no authentication credentials, OCI keys or real cloud requests are used.
const account: AccountSummary = {
  id: "rotation-fixture-account",
  name: "Rotation account",
  tenancyId: "ocid1.tenancy.oc1..rotationfixture",
  userId: "ocid1.user.oc1..rotationfixture",
  fingerprint: "aa:".repeat(15) + "aa",
  homeRegion: "ap-tokyo-1",
  regions: ["ap-tokyo-1", "us-phoenix-1"],
  status: "connected",
  lastSyncAt: "2026-11-01T00:00:00.000Z",
  lastError: null,
  createdAt: "2026-11-01T00:00:00.000Z",
};
const ids = {
  main: "rotation-instance-main",
  stopped: "rotation-instance-stopped",
  starting: "rotation-instance-starting",
  primaryVnic: "rotation-vnic-primary",
  secondaryVnic: "rotation-vnic-secondary",
  targetPrivate: "rotation-private-target",
  targetPublic: "rotation-public-target",
};
const addresses = {
  fixed: "203.0.113.10",
  protected: "203.0.113.11",
  first: "198.51.100.10",
  target: "198.51.100.20",
  incomplete: "198.51.100.21",
  unknownLifetime: "198.51.100.22",
  stopped: "198.51.100.30",
  starting: "198.51.100.40",
  replacement: "198.51.100.120",
  ipv6: "2001:db8::20",
};
function binding(
  vnicId: string,
  key: string,
  privateIp: string,
  publicIp: string | undefined,
  overrides: Partial<PublicIpBinding> = {},
): PublicIpBinding {
  return {
    privateIpId: "rotation-private-" + key,
    privateIp,
    isPrimary: false,
    vnicId,
    publicIpId: "rotation-public-" + key,
    publicIp,
    lifetime: "EPHEMERAL",
    protected: false,
    ...overrides,
  };
}
function vnic(
  id: string,
  name: string,
  privateIps: PublicIpBinding[],
  primary = false,
): VnicSummary {
  return { id, name, primary, subnetId: "rotation-subnet", nsgIds: [], privateIps, ipv6: [] };
}
function instance(
  id: string,
  displayName: string,
  state: string,
  vnics: VnicSummary[],
  region = account.homeRegion,
): InstanceSummary {
  return {
    id,
    displayName,
    state,
    vnics,
    region,
    accountId: account.id,
    accountName: account.name,
    availabilityDomain: "FIXTURE-AD",
    compartmentId: account.tenancyId,
    shape: "VM.Standard.E2.1.Micro",
    ocpus: 1,
    memoryGb: 1,
    os: "Ubuntu",
    createdAt: account.createdAt,
    syncedAt: account.lastSyncAt!,
    bootVolumes: [],
    tags: {},
  };
}
function fixtureInstances(): InstanceSummary[] {
  const instances = [
    instance(ids.main, "Rotation primary", "RUNNING", [
      vnic(
        ids.primaryVnic,
        "Primary interface",
        [
          binding(ids.primaryVnic, "fixed", "10.0.0.2", addresses.fixed, { lifetime: "RESERVED" }),
          binding(ids.primaryVnic, "first", "10.0.0.10", addresses.first, { isPrimary: true }),
          binding(ids.primaryVnic, "protected", "10.0.0.3", addresses.protected, {
            protected: true,
          }),
        ],
        true,
      ),
      vnic(ids.secondaryVnic, "Secondary egress", [
        binding(ids.secondaryVnic, "target", "10.1.0.20", addresses.target, { isPrimary: true }),
        binding(ids.secondaryVnic, "no-id", "10.1.0.21", addresses.incomplete, {
          publicIpId: undefined,
        }),
        binding(ids.secondaryVnic, "no-address", "10.1.0.22", undefined),
        binding(ids.secondaryVnic, "unknown", "10.1.0.23", addresses.unknownLifetime, {
          lifetime: undefined,
        }),
      ]),
    ]),
    instance(
      ids.stopped,
      "Rotation stopped",
      "STOPPED",
      [
        vnic(
          "rotation-vnic-stopped",
          "Stopped interface",
          [
            binding("rotation-vnic-stopped", "stopped", "10.2.0.30", addresses.stopped, {
              isPrimary: true,
            }),
          ],
          true,
        ),
      ],
      "us-phoenix-1",
    ),
    instance(ids.starting, "Rotation starting", "STARTING", [
      vnic(
        "rotation-vnic-starting",
        "Starting interface",
        [
          binding("rotation-vnic-starting", "starting", "10.3.0.40", addresses.starting, {
            isPrimary: true,
          }),
        ],
        true,
      ),
    ]),
  ];
  instances[0].vnics[1].ipv6 = [addresses.ipv6];
  return instances;
}
type Submission = OperationRequest & { idempotencyKey: string };
interface RotationFixture {
  now: number;
  instances: InstanceSummary[];
  jobs: JobSummary[];
  jobDetails: Map<string, JobSummary>;
  omittedFromList: Set<string>;
  instancesGate?: Promise<void>;
  detailsGate?: Promise<void>;
  listResponses: string[][];
  contextResponses: { jobs: string[]; recentJobs: string[] }[];
  submissions: Submission[];
  requests: { method: string; path: string }[];
  unexpected: string[];
  submitFailures: number;
  submitGate?: Promise<void>;
  finish(id: string, state: "succeeded" | "failed", replacement?: string): void;
  queueSync(parentId: string, syncId: string): JobSummary;
  count(path: string, method?: string): number;
}
const test = base.extend<{ rotationApi: RotationFixture }>({
  rotationApi: async ({ context, baseURL }, use) => {
    const origin = new URL(baseURL || "http://localhost:6240").origin;
    if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname))
      throw new Error("IP rotation UI tests require an isolated localhost server.");
    const errors: string[] = [];
    const accepted = new Map<string, JobSummary>();
    const submittedByJob = new Map<string, Submission>();
    const fixture: RotationFixture = {
      now: Date.now(),
      instances: fixtureInstances(),
      jobs: [],
      jobDetails: new Map(),
      omittedFromList: new Set(),
      listResponses: [],
      contextResponses: [],
      submissions: [],
      requests: [],
      unexpected: [],
      submitFailures: 0,
      count(path, method = "GET") {
        return fixture.requests.filter(
          (request) => request.path === path && request.method === method,
        ).length;
      },
      finish(id, state, replacement) {
        const job = fixture.jobDetails.get(id);
        const operation = submittedByJob.get(id);
        if (!job || !operation) throw new Error("Fixture job was not submitted.");
        job.state = state;
        job.attempt = 1;
        job.finishedAt = new Date(fixture.now + 1000).toISOString();
        job.lastError = state === "failed" ? "模拟 OCI 更换失败：地址已被其他操作修改" : null;
        const target = fixture.instances.find(
          (candidate) => candidate.id === operation.resourceId,
        )!;
        target.syncedAt = job.finishedAt;
        if (state === "succeeded" && replacement) {
          const chosen = target.vnics
            .find((item) => item.id === operation.payload.vnicId)!
            .privateIps.find((item) => item.privateIpId === operation.payload.privateIpId)!;
          chosen.publicIp = replacement;
          chosen.publicIpId = "rotation-public-replacement";
        }
      },
      queueSync(parentId, syncId) {
        const parent = fixture.jobDetails.get(parentId);
        const operation = submittedByJob.get(parentId);
        if (!parent || !operation) throw new Error("Fixture parent operation was not submitted.");
        const sync: JobSummary = {
          ...parent,
          id: syncId,
          kind: "sync-account",
          resourceId: null,
          state: "queued",
          attempt: 0,
          createdAt: new Date(fixture.now).toISOString(),
          startedAt: null,
          finishedAt: null,
          lastError: null,
          result: null,
        };
        parent.result = { synchronization: { status: "queued", jobId: syncId } };
        fixture.jobDetails.set(sync.id, sync);
        submittedByJob.set(sync.id, operation);
        fixture.jobs.unshift(sync);
        return sync;
      },
    };
    const observe = (page: Page) => page.on("pageerror", (error) => errors.push(error.message));
    context.pages().forEach(observe);
    context.on("page", observe);
    await context.routeWebSocket(/.*/, (socket) => {
      const path = new URL(socket.url()).pathname;
      if (!path.includes("webpack-hmr")) fixture.unexpected.push("WS " + socket.url());
      socket.close();
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method(),
        path = url.pathname;
      if (url.origin !== origin) {
        fixture.unexpected.push(method + " " + url.origin + path);
        return route.abort();
      }
      if (!path.startsWith("/api/")) {
        // Link prefetch is irrelevant to these card interactions and never reaches a server.
        if (request.headers()["rsc"] === "1") return route.abort();
        if (
          method === "GET" &&
          (path.startsWith("/_next/") ||
            /^\/flags\/[a-z]{2}\.svg$/.test(path) ||
            ["/instances", "/favicon.ico", "/icon.svg"].includes(path) ||
            /^\/instances\/[^/]+$/.test(path))
        )
          return route.continue();
        fixture.unexpected.push(method + " " + path);
        return route.abort();
      }
      fixture.requests.push({ method, path });
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (method === "GET" && path === "/api/auth/me")
        return json({
          user: { id: "rotation-user", username: "fixture", mfaEnabled: false },
        });
      if (method === "GET" && path === "/api/accounts")
        return json({ accounts: [account], syncJobs: [] });
      if (method === "GET" && path === "/api/instances") {
        if (fixture.instancesGate) await fixture.instancesGate;
        return json({ instances: fixture.instances });
      }
      const instanceMatch = /^\/api\/instances\/([^/]+)(?:\/(metrics|security))?$/.exec(path);
      if (method === "GET" && instanceMatch) {
        const found = fixture.instances.find(
          (item) => item.id === decodeURIComponent(instanceMatch[1]),
        );
        if (!found) return json({ error: "Unknown fixture instance" }, 404);
        if (instanceMatch[2] === "metrics")
          return json({ points: [], available: false, intervalSeconds: 60, source: "oci" });
        if (instanceMatch[2] === "security") return json({ groups: [] });
        return json({ instance: found });
      }
      if (method === "GET" && path === "/api/jobs") {
        if (url.searchParams.get("active") !== "true")
          return json(jobPageFixture(fixture.jobs, url.searchParams));
        const syncIds = new Set(
          fixture.jobs.flatMap((job) => {
            const sync = job.result?.synchronization as { jobId?: string } | undefined;
            return sync?.jobId ? [sync.jobId] : [];
          }),
        );
        const jobs = fixture.jobs.filter(
          (job) => !fixture.omittedFromList.has(job.id) && !syncIds.has(job.id),
        );
        const context = jobContextFixture(jobs, [...fixture.jobDetails.values()]);
        fixture.contextResponses.push({
          jobs: context.jobs.map((job) => job.id),
          recentJobs: context.recentJobs.map((job) => job.id),
        });
        await json(context);
        fixture.listResponses.push(jobs.map((job) => job.id));
        return;
      }
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        if (fixture.detailsGate) await fixture.detailsGate;
        const job = fixture.jobDetails.get(decodeURIComponent(jobMatch[1]));
        return job ? json({ job, events: [] }) : json({ error: "Unknown fixture job" }, 404);
      }
      if (method === "POST" && path === "/api/inventory/refresh") {
        const body = request.postDataJSON() as { mode?: string };
        expect(["auto", "manual"]).toContain(body.mode);
        const result: InventoryRefreshResult = {
          jobs: [],
          accounts: [
            {
              accountId: account.id,
              status: "fresh",
              jobId: null,
              lastSyncedAt: account.lastSyncAt,
              nextRefreshAt: new Date(fixture.now + 60_000).toISOString(),
            },
          ],
        };
        return json(result);
      }
      if (method === "POST" && path === "/api/operations") {
        const body = request.postDataJSON() as Submission;
        fixture.submissions.push(body);
        if (body.kind !== "public-ip-rotate" || typeof body.idempotencyKey !== "string") {
          fixture.unexpected.push("Unexpected operation or missing idempotency key");
          return json({ error: "Invalid fixture operation" }, 400);
        }
        if (fixture.submitFailures > 0) {
          fixture.submitFailures -= 1;
          return json({ error: "模拟提交失败，请重试", code: "TEST_SUBMIT_FAILED" }, 503);
        }
        if (fixture.submitGate) await fixture.submitGate;
        let job = accepted.get(body.idempotencyKey);
        if (!job) {
          job = {
            id: "rotation-job-" + (accepted.size + 1),
            kind: "public-ip-rotate",
            accountId: body.accountId,
            accountName: account.name,
            region: body.region,
            resourceId: body.resourceId ?? null,
            state: "queued",
            attempt: 0,
            maxAttempts: 4,
            createdAt: new Date(fixture.now).toISOString(),
            startedAt: null,
            finishedAt: null,
            nextRunAt: null,
            lastError: null,
            result: null,
          };
          accepted.set(body.idempotencyKey, job);
          submittedByJob.set(job.id, body);
          fixture.jobDetails.set(job.id, job);
          fixture.jobs.unshift(job);
        }
        return json({ job }, 202);
      }
      fixture.unexpected.push(method + " " + path);
      return json({ error: "Unmocked API blocked by IP rotation fixture" }, 501);
    });
    await use(fixture);
    expect(fixture.unexpected, "All API/external/WS traffic must be mocked or blocked").toEqual([]);
    expect(errors, "Card rotation must not throw uncaught browser errors").toEqual([]);
  },
});
test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

const card = (page: Page, name = "Rotation primary") =>
  page.locator("article.instance-card").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
const addressButton = (container: Locator | Page, address: string) =>
  container.getByRole("button", { name: `查看 IP ${address} 详情`, exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "IP 详情", exact: true });
const confirm = (page: Page) =>
  dialog(page).getByRole("button", { name: "更换公网 IP", exact: true });
const closeDetails = async (page: Page) => {
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog(page)).toHaveCount(0);
};
async function expectReplacement(
  page: Page,
  container: Locator | Page,
  address: string,
  enabled: boolean,
) {
  const entry = addressButton(container, address);
  await expect(entry).toBeEnabled();
  await entry.click();
  await expect(dialog(page)).toBeVisible();
  if (enabled) await expect(confirm(page)).toBeEnabled();
  else {
    await expect(confirm(page)).toBeDisabled();
    await expect(dialog(page).getByRole("status")).toContainText(
      /不支持|不能|未确认|不完整|不可|读取|处理|变化/,
    );
  }
  await closeDetails(page);
}
async function openCards(page: Page, hasRotationAction = true) {
  await page.goto("/instances");
  await expect(page.getByRole("button", { name: "卡片视图", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator("article.instance-card")).toHaveCount(3);
  if (hasRotationAction) await expect(addressButton(card(page), addresses.target)).toBeVisible();
}
async function advanceJobPoll(page: Page, fixture: RotationFixture) {
  fixture.now += 5001;
  await page.clock.fastForward(5001);
}
function expectTarget(operation: Submission) {
  expect(operation).toMatchObject({
    kind: "public-ip-rotate",
    accountId: account.id,
    region: "ap-tokyo-1",
    resourceId: ids.main,
  });
  expect(operation.payload).toEqual({
    vnicId: ids.secondaryVnic,
    privateIpId: ids.targetPrivate,
    expectedPublicIpId: ids.targetPublic,
    expectedPublicIp: addresses.target,
  });
  expect(operation.idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
}

function terminalRotation(id: string, state: "failed" | "succeeded"): JobSummary {
  return {
    id,
    kind: "public-ip-rotate",
    accountId: account.id,
    accountName: account.name,
    region: account.homeRegion,
    resourceId: ids.main,
    state,
    attempt: 1,
    maxAttempts: 4,
    createdAt: account.createdAt,
    startedAt: account.createdAt,
    finishedAt: account.createdAt,
    nextRunAt: null,
    lastError: state === "failed" ? "模拟历史轮换失败" : null,
    result: null,
  };
}

test("重载后从最近历史恢复失败轮换提示，不把完成任务混入活动列表", async ({
  page,
  rotationApi,
}) => {
  const history = terminalRotation("rotation-history-failed", "failed");
  rotationApi.jobs.push(history);
  rotationApi.jobDetails.set(history.id, history);
  await openCards(page);
  const failure = () =>
    card(page).getByRole("link", { name: "更换未完成 · 查看任务", exact: true });
  await expect(failure()).toBeVisible();
  await expectReplacement(page, card(page), addresses.target, true);
  await page.reload();
  await expect(failure()).toBeVisible();
  await expect(failure()).toHaveAttribute("href", "/tasks/" + history.id);
  await expectReplacement(page, card(page), addresses.target, true);
  expect(rotationApi.contextResponses.at(-1)).toEqual({ jobs: [], recentJobs: [history.id] });
  expect(rotationApi.submissions).toEqual([]);
});

for (const synchronization of ["completed-with-warnings", "failed-child"] as const) {
  test(`重载后保留同步未确认的成功轮换保护：${synchronization}`, async ({ page, rotationApi }) => {
    const history = terminalRotation("rotation-history-unconfirmed", "succeeded");
    const syncId = "rotation-history-sync-failed";
    history.result = {
      details: {
        privateIpId: ids.targetPrivate,
        publicIpId: "rotation-public-replacement",
        publicIp: addresses.replacement,
      },
      synchronization:
        synchronization === "failed-child"
          ? { status: "queued", jobId: syncId }
          : { status: "completed-with-warnings", warnings: ["模拟库存未能确认新地址"] },
    };
    rotationApi.jobs.push(history);
    rotationApi.jobDetails.set(history.id, history);
    if (synchronization === "failed-child") {
      const sync: JobSummary = {
        ...history,
        id: syncId,
        kind: "sync-account",
        resourceId: null,
        state: "failed",
        result: null,
        lastError: "模拟后台同步失败",
      };
      rotationApi.jobs.push(sync);
      rotationApi.jobDetails.set(sync.id, sync);
    }
    await openCards(page);
    const warning = () =>
      card(page).getByRole("link", { name: "地址同步不完整 · 查看任务", exact: true });
    await expect(warning()).toBeVisible();
    await expectReplacement(page, card(page), addresses.target, false);
    await page.reload();
    await expect(warning()).toBeVisible();
    await expectReplacement(page, card(page), addresses.first, false);
    await expectReplacement(page, card(page), addresses.target, false);
    await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);
    expect(rotationApi.contextResponses.at(-1)).toEqual({ jobs: [], recentJobs: [history.id] });
    if (synchronization === "failed-child")
      expect(rotationApi.count("/api/jobs/" + syncId)).toBeGreaterThan(0);
    expect(rotationApi.submissions).toEqual([]);
  });
}

test("卡片所有公网地址共用详情，只有完整且未保护的临时绑定可以更换", async ({
  page,
  rotationApi,
}) => {
  await openCards(page);
  const primary = card(page);
  await expect(primary.getByText("固定 IP", { exact: true })).toHaveCount(2);
  for (const address of [
    addresses.fixed,
    addresses.protected,
    addresses.incomplete,
    addresses.unknownLifetime,
  ])
    await expectReplacement(page, primary, address, false);
  await expect(primary.getByRole("button", { name: /^更换/ })).toHaveCount(0);
  await expect(primary.getByRole("button", { name: /^查看 IP .* 详情$/ })).toHaveCount(6);
  await expect(addressButton(primary, addresses.first)).toHaveText(addresses.first);
  await expectReplacement(page, primary, addresses.first, true);
  await expectReplacement(page, primary, addresses.target, true);
  await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);
  await expectReplacement(page, card(page, "Rotation starting"), addresses.starting, false);
  expect(rotationApi.submissions).toEqual([]);
});

test("选择第二张网卡时预览精确绑定，取消不提交任何更换操作", async ({ page, rotationApi }) => {
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await expect(dialog(page)).toBeVisible();
  const summary = dialog(page).locator(".confirm-summary");
  await expect(summary).toContainText("Rotation primary");
  await expect(summary).toContainText("Secondary egress");
  await expect(summary).toContainText("网卡名称");
  await expect(summary).toContainText("附加网卡");
  await expect(summary).toContainText("10.1.0.20");
  await expect(summary).toContainText(addresses.target);
  await expect(summary).not.toContainText(addresses.first);
  await expect(summary).not.toContainText(addresses.fixed);
  await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(dialog(page)).not.toBeVisible();
  await expectReplacement(page, card(page), addresses.target, true);
  expect(rotationApi.submissions).toEqual([]);
  expect(rotationApi.count("/api/operations", "POST")).toBe(0);
});

test("详情打开后绑定变化会禁用更换，重新选择当前地址才恢复", async ({ page, rotationApi }) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await expect(confirm(page)).toBeEnabled();
  const reads = rotationApi.count("/api/instances");
  const target = rotationApi.instances[0].vnics[1].privateIps[0];
  target.publicIp = addresses.replacement;
  target.publicIpId = "rotation-public-replacement";
  await page.clock.fastForward(30001);
  await expect.poll(() => rotationApi.count("/api/instances")).toBeGreaterThan(reads);
  await expect(confirm(page)).toBeDisabled();
  await expect(
    dialog(page).getByText("地址绑定已变化，请关闭详情并重新打开当前地址。", { exact: true }),
  ).toBeVisible();
  await expect(dialog(page).locator(".confirm-summary")).toContainText(addresses.target);
  await expect(dialog(page).locator(".confirm-summary")).toContainText(addresses.replacement);
  await closeDetails(page);
  await expect(addressButton(card(page), addresses.target)).toHaveCount(0);
  await expectReplacement(page, card(page), addresses.replacement, true);
  expect(rotationApi.submissions).toEqual([]);
});

test("表格与网络详情共用 IP 弹窗，固定、私网和 IPv6 均可查看但不能更换", async ({
  page,
  rotationApi,
}) => {
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
  await openCards(page);
  await page.getByRole("button", { name: "表格视图", exact: true }).click();
  await expectReplacement(page, page.locator(".resource-table"), addresses.fixed, false);
  await page.goto(`/instances/${ids.main}`);
  await page.getByRole("tab", { name: "网络", exact: true }).click();
  await expectReplacement(page, page, addresses.fixed, false);
  await expectReplacement(page, page, "10.1.0.20", false);
  await page.setViewportSize({ width: 390, height: 844 });
  await addressButton(page, addresses.ipv6).click();
  await expect(dialog(page)).toContainText("IPv6");
  await expect(dialog(page)).toContainText("Secondary egress");
  await expect(confirm(page)).toBeDisabled();
  await dialog(page).getByText("资源标识", { exact: true }).click();
  await dialog(page).getByRole("button", { name: "复制网卡 OCID", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { copied: string }).copied))
    .toBe(ids.secondaryVnic);
  const dimensions = await dialog(page).evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    viewport: innerWidth,
    bounds: element.getBoundingClientRect().width,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
  expect(dimensions.bounds).toBeLessThanOrEqual(dimensions.viewport);
  await closeDetails(page);
  expect(rotationApi.submissions).toEqual([]);
});

test("没有公网 IPv4 时卡片仍可查看私网及 IPv6 地址详情", async ({ page, rotationApi }) => {
  const selected = rotationApi.instances[0];
  for (const item of selected.vnics)
    for (const entry of item.privateIps) {
      entry.publicIp = undefined;
      entry.publicIpId = undefined;
    }
  await openCards(page, false);
  await expectReplacement(page, card(page), "10.0.0.2", false);
  for (const item of selected.vnics) item.privateIps = [];
  await page.reload();
  await expectReplacement(page, card(page), addresses.ipv6, false);
  expect(rotationApi.submissions).toEqual([]);
});

test("提交精确绑定且防重复点击，等待期间锁定本实例，完成后刷新出口并保留固定 IP", async ({
  page,
  rotationApi,
}) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  let release!: () => void;
  rotationApi.submitGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await addressButton(card(page), addresses.target).click();
    await confirm(page).dblclick();
    await expect.poll(() => rotationApi.submissions.length).toBe(1);
    expectTarget(rotationApi.submissions[0]);
    await expect(confirm(page)).toBeDisabled();
    await expect(dialog(page).getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
    release();
    rotationApi.submitGate = undefined;
    await expect(dialog(page)).not.toBeVisible();
    await expectReplacement(page, card(page), addresses.first, false);
    await expectReplacement(page, card(page), addresses.target, false);
    await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);
    const job = rotationApi.jobs[0];
    await expect(card(page).locator('a[href="/tasks/' + job.id + '"]')).toBeVisible();
    const reads = rotationApi.count("/api/instances");
    const polls = rotationApi.count("/api/jobs");
    rotationApi.finish(job.id, "succeeded", addresses.replacement);
    await advanceJobPoll(page, rotationApi);
    await expectReplacement(page, card(page), addresses.replacement, true);
    await expect(addressButton(card(page), addresses.target)).toHaveCount(0);
    await expectReplacement(page, card(page), addresses.first, true);
    await expect(card(page).getByText(addresses.fixed, { exact: true })).toBeVisible();
    await expect(card(page).getByText(addresses.protected, { exact: true })).toBeVisible();
    await expectReplacement(page, card(page), addresses.fixed, false);
    await expect(card(page).getByText("固定 IP", { exact: true })).toHaveCount(2);
    expect(rotationApi.count("/api/jobs")).toBeGreaterThan(polls);
    expect(rotationApi.count("/api/instances")).toBeGreaterThan(reads);
    expect(rotationApi.submissions).toHaveLength(1);
  } finally {
    release();
    rotationApi.submitGate = undefined;
  }
});

test("提交失败保留确认弹窗和原 IP，再试使用同一个幂等键", async ({ page, rotationApi }) => {
  rotationApi.submitFailures = 1;
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await confirm(page).click();
  await expect(dialog(page).getByText("模拟提交失败，请重试", { exact: true })).toBeVisible();
  await expect(confirm(page)).toBeEnabled();
  expect(rotationApi.submissions).toHaveLength(1);
  expect(rotationApi.jobs).toEqual([]);
  const first = rotationApi.submissions[0];
  expectTarget(first);
  await expect(card(page).getByText(addresses.target, { exact: true })).toBeVisible();
  await confirm(page).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(rotationApi.submissions).toHaveLength(2);
  expectTarget(rotationApi.submissions[1]);
  expect(rotationApi.submissions[1].idempotencyKey).toBe(first.idempotencyKey);
  expect(rotationApi.jobs).toHaveLength(1);
});

test("后台任务失败显示错误入口并刷新卡片，重新发起操作使用新的幂等键", async ({
  page,
  rotationApi,
}) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await confirm(page).click();
  await expect(dialog(page)).not.toBeVisible();
  const first = rotationApi.submissions[0];
  const job = rotationApi.jobs[0];
  await expectReplacement(page, card(page), addresses.target, false);
  const reads = rotationApi.count("/api/instances");
  rotationApi.finish(job.id, "failed");
  await advanceJobPoll(page, rotationApi);
  await expect(card(page)).toContainText(/失败|未完成/);
  await expect(card(page).locator('a[href="/tasks/' + job.id + '"]')).toBeVisible();
  await expectReplacement(page, card(page), addresses.target, true);
  await expect(card(page).getByText(addresses.fixed, { exact: true })).toBeVisible();
  expect(rotationApi.count("/api/instances")).toBeGreaterThan(reads);
  await addressButton(card(page), addresses.target).click();
  await confirm(page).click();
  await expect(dialog(page)).not.toBeVisible();
  expect(rotationApi.submissions).toHaveLength(2);
  expectTarget(rotationApi.submissions[1]);
  expect(rotationApi.submissions[1].idempotencyKey).not.toBe(first.idempotencyKey);
  expect(rotationApi.jobs).toHaveLength(2);
});

test("已终止和正在终止的实例仍可查看地址详情，但不能更换公网 IP", async ({ page, rotationApi }) => {
  rotationApi.instances.find((item) => item.id === ids.main)!.state = "TERMINATED";
  rotationApi.instances.find((item) => item.id === ids.stopped)!.state = "TERMINATING";
  await openCards(page, false);
  await expect(card(page).getByText(addresses.target, { exact: true })).toBeVisible();
  await expect(
    card(page, "Rotation stopped").getByText(addresses.stopped, { exact: true }),
  ).toBeVisible();
  await expectReplacement(page, card(page), addresses.first, false);
  await expectReplacement(page, card(page), addresses.target, false);
  await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, false);
  await expectReplacement(page, card(page), addresses.fixed, false);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(rotationApi.submissions).toEqual([]);
  expect(rotationApi.count("/api/operations", "POST")).toBe(0);
});

test("待执行轮换掉出列表仍按任务详情保持锁定，详情终态后更新卡片", async ({
  page,
  rotationApi,
}) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  let releaseInitial!: () => void;
  rotationApi.detailsGate = new Promise<void>((resolve) => {
    releaseInitial = resolve;
  });
  try {
    await addressButton(card(page), addresses.target).click();
    await confirm(page).click();
    await expect(dialog(page)).not.toBeVisible();
    const job = rotationApi.jobs[0];
    const detailPath = "/api/jobs/" + job.id;
    const taskLink = card(page).locator('a[href="/tasks/' + job.id + '"]');
    await expectReplacement(page, card(page), addresses.target, false);

    // Wait for track()'s immediate list/detail cycle to consume a distinct detail
    // snapshot. A request counter alone cannot tell whether that cycle has ended.
    await expect.poll(() => rotationApi.count(detailPath)).toBeGreaterThan(0);
    const initialMarker = "模拟首次任务详情已确认";
    rotationApi.jobDetails.get(job.id)!.lastError = initialMarker;
    releaseInitial();
    rotationApi.detailsGate = undefined;
    await expect(taskLink).toHaveAttribute("title", initialMarker);

    rotationApi.omittedFromList.add(job.id);
    rotationApi.jobDetails.get(job.id)!.state = "running";
    rotationApi.jobDetails.get(job.id)!.lastError = null;
    const detailReads = rotationApi.count(detailPath);
    const listReads = rotationApi.count("/api/jobs");
    const listResponses = rotationApi.listResponses.length;
    await advanceJobPoll(page, rotationApi);
    await expect.poll(() => rotationApi.listResponses.length).toBeGreaterThan(listResponses);
    expect(rotationApi.listResponses.at(-1)).toEqual([]);
    await expect.poll(() => rotationApi.count(detailPath)).toBeGreaterThan(detailReads);
    expect(rotationApi.count("/api/jobs")).toBeGreaterThan(listReads);
    // Only the new detail response can clear this marker: the new list is empty.
    await expect(taskLink).not.toHaveAttribute("title", initialMarker);
    await expectReplacement(page, card(page), addresses.first, false);
    await expectReplacement(page, card(page), addresses.target, false);
    await expect(taskLink).toBeVisible();
    await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);

    const snapshotReads = rotationApi.count("/api/instances");
    const terminalReads = rotationApi.count(detailPath);
    rotationApi.finish(job.id, "succeeded", addresses.replacement);
    await advanceJobPoll(page, rotationApi);
    await expectReplacement(page, card(page), addresses.replacement, true);
    await expect(addressButton(card(page), addresses.target)).toHaveCount(0);
    await expect(card(page).getByText(addresses.fixed, { exact: true })).toBeVisible();
    expect(rotationApi.count(detailPath)).toBeGreaterThan(terminalReads);
    expect(rotationApi.count("/api/instances")).toBeGreaterThan(snapshotReads);
    expect(rotationApi.omittedFromList.has(job.id)).toBe(true);
    expect(rotationApi.submissions).toHaveLength(1);
  } finally {
    releaseInitial();
    rotationApi.detailsGate = undefined;
  }
});

test("轮换成功后继续等待隐藏的库存同步，取得新快照后才解除锁定", async ({ page, rotationApi }) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await confirm(page).click();
  await expect(dialog(page)).not.toBeVisible();
  const parent = rotationApi.jobs[0];
  await expectReplacement(page, card(page), addresses.target, false);
  const sync = rotationApi.queueSync(parent.id, "inventory-followup-fixture-1");
  rotationApi.omittedFromList.add(sync.id);
  rotationApi.finish(parent.id, "succeeded");
  await advanceJobPoll(page, rotationApi);
  await expect.poll(() => rotationApi.count("/api/jobs/" + sync.id)).toBeGreaterThan(0);
  await expectReplacement(page, card(page), addresses.first, false);
  await expectReplacement(page, card(page), addresses.target, false);
  await expect(card(page).getByText(addresses.target, { exact: true })).toBeVisible();
  await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);
  await expect(
    page.locator(".page-heading").getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();

  let release!: () => void;
  rotationApi.instancesGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshotReads = rotationApi.count("/api/instances");
  try {
    rotationApi.finish(sync.id, "succeeded", addresses.replacement);
    await advanceJobPoll(page, rotationApi);
    await expect.poll(() => rotationApi.count("/api/instances")).toBeGreaterThan(snapshotReads);
    await expectReplacement(page, card(page), addresses.first, false);
    await expectReplacement(page, card(page), addresses.target, false);
    await expect(addressButton(card(page), addresses.replacement)).toHaveCount(0);
    release();
    rotationApi.instancesGate = undefined;
    await expectReplacement(page, card(page), addresses.replacement, true);
    await expectReplacement(page, card(page), addresses.first, true);
    await expect(card(page).getByText(addresses.fixed, { exact: true })).toBeVisible();
    await expectReplacement(page, card(page), addresses.fixed, false);
    expect(rotationApi.count("/api/jobs/" + sync.id)).toBeGreaterThanOrEqual(2);
    expect(rotationApi.omittedFromList.has(sync.id)).toBe(true);
    expect(rotationApi.submissions).toHaveLength(1);
  } finally {
    release();
    rotationApi.instancesGate = undefined;
  }
});

test("轮换完成但地址同步不完整时保持保护，手动刷新确认新绑定后才可再次更换", async ({
  page,
  rotationApi,
}) => {
  await page.clock.install({ time: new Date(rotationApi.now) });
  await openCards(page);
  await addressButton(card(page), addresses.target).click();
  await confirm(page).click();
  await expect(dialog(page)).not.toBeVisible();
  const job = rotationApi.jobs[0];
  await expectReplacement(page, card(page), addresses.target, false);
  rotationApi.finish(job.id, "succeeded");
  rotationApi.jobDetails.get(job.id)!.result = {
    details: {
      privateIpId: ids.targetPrivate,
      publicIpId: "rotation-public-replacement",
      publicIp: addresses.replacement,
    },
    synchronization: {
      status: "completed-with-warnings",
      warnings: ["模拟网络绑定快照尚未更新"],
    },
  };
  await advanceJobPoll(page, rotationApi);
  const warning = card(page).getByRole("link", {
    name: "地址同步不完整 · 查看任务",
    exact: true,
  });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute("href", "/tasks/" + job.id);
  await expectReplacement(page, card(page), addresses.first, false);
  await expectReplacement(page, card(page), addresses.target, false);
  await expect(card(page).getByText(addresses.target, { exact: true })).toBeVisible();
  await expectReplacement(page, card(page, "Rotation stopped"), addresses.stopped, true);
  const refresh = page.locator(".page-heading").getByRole("button", { name: "刷新", exact: true });
  await expect(refresh).toBeEnabled();
  const reads = rotationApi.count("/api/instances");
  const refreshes = rotationApi.count("/api/inventory/refresh", "POST");
  const target = rotationApi.instances
    .find((instance) => instance.id === ids.main)!
    .vnics.find((vnic) => vnic.id === ids.secondaryVnic)!
    .privateIps.find((binding) => binding.privateIpId === ids.targetPrivate)!;
  // Only the inventory snapshot changes. The completed task remains unchanged.
  target.publicIp = addresses.replacement;
  target.publicIpId = "rotation-public-replacement";
  await refresh.click();
  await expectReplacement(page, card(page), addresses.replacement, true);
  await expectReplacement(page, card(page), addresses.first, true);
  await expect(warning).toHaveCount(0);
  await expect(card(page).getByText(addresses.fixed, { exact: true })).toBeVisible();
  await expectReplacement(page, card(page), addresses.fixed, false);
  expect(rotationApi.count("/api/instances")).toBeGreaterThan(reads);
  expect(rotationApi.count("/api/inventory/refresh", "POST")).toBeGreaterThan(refreshes);
  expect(rotationApi.submissions).toHaveLength(1);
});
