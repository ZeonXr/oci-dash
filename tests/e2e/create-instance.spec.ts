import { expectSelectOptions, selectOption } from "./helpers/ui";
import { expect, test as base } from "@playwright/test";
import type { AccountSummary, CreateOptions, OperationRequest } from "../../src/lib/contracts";

const account: AccountSummary = {
  id: "create-fixture",
  name: "Create fixture",
  tenancyId: "ocid1.tenancy.oc1..createfixture",
  userId: "ocid1.user.oc1..createfixture",
  fingerprint: "aa:".repeat(15) + "aa",
  homeRegion: "ap-tokyo-1",
  regions: ["ap-tokyo-1", "ap-singapore-1"],
  status: "connected",
  lastSyncAt: new Date().toISOString(),
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const MICRO = "VM.Standard.E2.1.Micro",
  ARM = "VM.Standard.A1.Flex";
interface Fixture {
  queries: URL[];
  completedQueries: URL[];
  operations: OperationRequest[];
  gate?: { shape: string; promise: Promise<void> };
}
const test = base.extend<{ createApi: Fixture }>({
  createApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [],
        errors: string[] = [];
      const state: Fixture = { queries: [], completedQueries: [], operations: [] };
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push(socket.url());
        socket.close();
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) {
          unexpected.push(request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const json = (body: unknown) => route.fulfill({ json: body });
        if (url.pathname === "/api/auth/me")
          return json({ user: { id: "fixture", username: "admin", mfaEnabled: false } });
        if (url.pathname === "/api/accounts") return json({ accounts: [account], syncJobs: [] });
        if (url.pathname === "/api/instances") return json({ instances: [] });
        if (url.pathname === "/api/jobs") return json({ jobs: [], recentJobs: [] });
        if (url.pathname === "/api/inventory/refresh")
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
        if (url.pathname.endsWith("/create-options")) {
          state.queries.push(url);
          const availabilityDomain = url.searchParams.get("availabilityDomain") || "AD-1";
          const shape = url.searchParams.get("shape") || MICRO;
          const region = url.searchParams.get("region")!;
          const data: CreateOptions = {
            selection: { compartmentId: account.tenancyId, availabilityDomain, shape },
            compartments: [{ id: account.tenancyId, name: "Root" }],
            availabilityDomains: ["AD-1", "AD-2"],
            shapes: (availabilityDomain === "AD-1" ? [MICRO, ARM] : [MICRO]).map((name) => ({
              name,
              ocpus: 1,
              memoryGb: name === ARM ? 6 : 1,
              flexible: name === ARM,
            })),
            images: [
              {
                id: `${region}-${shape === ARM ? "arm" : "x86"}`,
                name: shape === ARM ? "Ubuntu ARM" : "Ubuntu x86",
              },
            ],
            subnets: [
              { id: `${region}-${availabilityDomain}`, name: availabilityDomain + " subnet" },
            ],
          };
          if (state.gate?.shape === shape) await state.gate.promise;
          await json(data);
          state.completedQueries.push(url);
          return;
        }
        if (url.pathname === "/api/operations" && request.method() === "POST") {
          state.operations.push(request.postDataJSON());
          return json({ job: { id: "create-fixture-job" } });
        }
        unexpected.push(request.method() + " " + url.pathname);
        return route.abort();
      });
      await use(state);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
    { auto: true },
  ],
});

test("创建实例联动规格、兼容镜像及可用域子网", async ({ page, createApi }) => {
  await page.goto("/instances");
  await page.getByRole("button", { name: "创建实例", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expectSelectOptions(dialog.getByLabel(/^区域/), account.regions);
  await expect(dialog.getByLabel(/^实例规格/)).toHaveAttribute("data-value", MICRO);
  await selectOption(dialog.getByLabel(/^实例规格/), ARM);
  await expectSelectOptions(dialog.getByLabel(/^系统镜像/), ["Ubuntu ARM"]);
  await expect(dialog.getByLabel(/^内存\ \(GiB\)/)).toHaveValue("6");
  await selectOption(dialog.getByLabel(/^可用域/), "AD-2");
  await expectSelectOptions(dialog.getByLabel(/^实例规格/), [MICRO]);
  await expectSelectOptions(dialog.getByLabel(/^系统镜像/), ["Ubuntu x86"]);
  await expect(dialog.getByLabel(/^子网/)).toHaveAttribute("data-value", "ap-tokyo-1-AD-2");
  await dialog.getByLabel(/^实例名称/).fill("fixture-server");
  await dialog.getByLabel(/^SSH\ 公钥/).fill("ssh-ed25519 AAAATESTPUBLICKEY fixture");
  await dialog.getByRole("checkbox", { name: "确认使用上述配置创建实例" }).check();
  await dialog.getByRole("button", { name: "创建实例", exact: true }).click();
  await expect.poll(() => createApi.operations.length).toBe(1);
  expect(createApi.operations[0].payload).toMatchObject({
    compartmentId: account.tenancyId,
    availabilityDomain: "AD-2",
    shape: MICRO,
    imageId: "ap-tokyo-1-x86",
    subnetId: "ap-tokyo-1-AD-2",
  });
});

test("切换区域会取消旧请求并保留新区域的兼容配置", async ({ page, createApi }) => {
  await page.goto("/instances");
  await page.getByRole("button", { name: "创建实例", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(/^实例规格/)).toHaveAttribute("data-value", MICRO);
  let release!: () => void;
  createApi.gate = {
    shape: ARM,
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
  };
  try {
    await selectOption(dialog.getByLabel(/^实例规格/), ARM);
    await expect.poll(() => createApi.queries.at(-1)?.searchParams.get("shape")).toBe(ARM);
    await expect(dialog.getByRole("button", { name: "创建实例", exact: true })).toBeDisabled();
    const oldFailure = page.waitForEvent("requestfailed", {
      predicate: (request) => new URL(request.url()).searchParams.get("shape") === ARM,
    });
    await selectOption(dialog.getByLabel(/^区域/), "ap-singapore-1");
    expect((await oldFailure).failure()).not.toBeNull();
    await expect(dialog.getByLabel(/^系统镜像/)).toHaveAttribute(
      "data-value",
      "ap-singapore-1-x86",
    );
    expect(createApi.queries.at(-1)?.searchParams.has("shape")).toBe(false);
    expect(createApi.queries.at(-1)?.searchParams.has("availabilityDomain")).toBe(false);
    release();
    await expect
      .poll(() => createApi.completedQueries.some((url) => url.searchParams.get("shape") === ARM))
      .toBe(true);
    await expect(dialog.getByLabel(/^实例规格/)).toHaveAttribute("data-value", MICRO);
    await expect(dialog.getByLabel(/^系统镜像/)).toHaveAttribute(
      "data-value",
      "ap-singapore-1-x86",
    );
    await expect(dialog.getByLabel(/^子网/)).toHaveAttribute("data-value", "ap-singapore-1-AD-1");
    expect(createApi.operations).toEqual([]);
  } finally {
    release();
  }
});
