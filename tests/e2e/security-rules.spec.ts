import { expect, test as base, type Page } from "@playwright/test";
import type {
  JobSummary,
  OperationRequest,
  SecurityGroup,
  SecurityRule,
} from "../../src/lib/contracts";
import { fixtureAccounts, fixtureInstances } from "../fixtures/seed-data";
import { jobPageFixture } from "../fixtures/job-page";

const account = fixtureAccounts()[0]!;
const instance = fixtureInstances()[0]!;
const securityPath = `/api/instances/${instance.id}/security`;
const rule = (id: string, description: string): SecurityRule => ({
  id,
  description,
  direction: "INGRESS",
  protocol: "6",
  peer: "203.0.113.0/24",
  peerType: "CIDR_BLOCK",
  stateless: false,
  portMin: 22,
  portMax: 22,
});
const initialRule = rule("initial-rule", "Initial SSH");
const addedRule = rule("added-rule", "Added HTTPS");
type TerminalState = "succeeded" | "failed" | "cancelled";

interface SecurityFixture {
  group: SecurityGroup;
  jobs: JobSummary[];
  operations: OperationRequest[];
  securityReads: number;
  holdSecurity?: Promise<void>;
  nextState: "queued" | TerminalState;
  onSubmit?: () => void;
  finish(state: TerminalState): void;
}

const test = base.extend<{ securityApi: SecurityFixture }>({
  securityApi: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const unexpected: string[] = [];
      const errors: string[] = [];
      const state: SecurityFixture = {
        group: {
          id: "security-list-fixture",
          name: "Fixture security list",
          kind: "security-list",
          etag: "security-etag-1",
          rules: [initialRule],
        },
        jobs: [],
        operations: [],
        securityReads: 0,
        nextState: "queued",
        finish(status) {
          const job = state.jobs.at(-1)!;
          Object.assign(job, {
            state: status,
            attempt: job.attempt + 1,
            finishedAt: new Date().toISOString(),
            lastError: status === "failed" ? "Fixture cloud failure" : null,
          });
        },
      };
      context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
      await context.routeWebSocket("**/*", (socket) => {
        unexpected.push("WS " + socket.url());
        socket.close();
      });
      // Every API, external request and WebSocket is intercepted before navigation.
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (url.origin !== origin) {
          unexpected.push(method + " " + request.url());
          return route.abort();
        }
        if (!url.pathname.startsWith("/api/")) return route.continue();
        const json = (body: unknown) => route.fulfill({ json: body });
        if (method === "GET" && url.pathname === "/api/auth/me")
          return json({ user: { id: "security-user", username: "admin", mfaEnabled: false } });
        if (method === "GET" && url.pathname === "/api/accounts")
          return json({ accounts: [account], syncJobs: [] });
        if (method === "GET" && url.pathname === `/api/instances/${instance.id}`)
          return json({ instance });
        if (method === "GET" && url.pathname === `/api/instances/${instance.id}/metrics`)
          return json({ points: [], intervalSeconds: 60, available: false, source: "oci" });
        if (method === "GET" && url.pathname === securityPath) {
          const snapshot = structuredClone(state.group);
          state.securityReads++;
          if (state.holdSecurity) await state.holdSecurity;
          return json({ groups: [snapshot] });
        }
        if (method === "GET" && url.pathname === "/api/jobs")
          return json(jobPageFixture(state.jobs, url.searchParams));
        const job = state.jobs.find((item) => url.pathname === `/api/jobs/${item.id}`);
        if (method === "GET" && job) return json({ job, events: [] });
        if (method === "POST" && url.pathname === "/api/inventory/refresh")
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
        if (method === "POST" && url.pathname === "/api/operations") {
          const operation = request.postDataJSON() as OperationRequest;
          state.operations.push(operation);
          const job: JobSummary = {
            id: `security-job-${state.operations.length}`,
            kind: operation.kind,
            accountId: operation.accountId,
            accountName: account.name,
            region: operation.region,
            resourceId: operation.resourceId ?? null,
            state: state.nextState,
            attempt: 0,
            maxAttempts: 4,
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: state.nextState === "queued" ? null : new Date().toISOString(),
            nextRunAt: null,
            lastError: null,
            result: null,
          };
          state.jobs.push(job);
          state.onSubmit?.();
          return json({ job });
        }
        unexpected.push(method + " " + url.pathname);
        return route.abort();
      });
      await use(state);
      expect(unexpected, "All API, external and WebSocket requests must be mocked").toEqual([]);
      expect(errors, "Security rule interactions must not raise browser errors").toEqual([]);
    },
    { auto: true },
  ],
});

test.use({ trace: "off", video: "off", screenshot: "off", serviceWorkers: "block" });

async function openSecurity(page: Page) {
  await page.clock.install({ time: new Date("2026-11-13T12:00:00Z") });
  await page.goto(`/instances/${instance.id}`);
  await page.getByRole("tab", { name: "安全规则", exact: true }).click();
  await expect(page.getByText(initialRule.description, { exact: true })).toBeVisible();
}

async function openAdd(page: Page, description = addedRule.description) {
  await page.getByRole("button", { name: "添加规则", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "添加安全规则", exact: true });
  await dialog.getByLabel(/^来源/).fill("203.0.113.0/24");
  await dialog.getByLabel(/^说明/).fill(description);
  return dialog;
}

test("安全规则任务完成后刷新旧请求之后的规则，保留编辑内容并使用新 ETag", async ({
  page,
  securityApi,
}) => {
  await openSecurity(page);
  const first = await openAdd(page);
  await first.getByRole("button", { name: "添加规则", exact: true }).click();
  await expect(first).not.toBeVisible();
  expect(securityApi.operations[0]?.payload.etag).toBe("security-etag-1");
  expect(securityApi.securityReads).toBe(1);
  await expect(page.getByText(addedRule.description, { exact: true })).toHaveCount(0);

  let release!: () => void;
  securityApi.holdSecurity = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await page.getByRole("button", { name: "刷新规则", exact: true }).click();
    await expect.poll(() => securityApi.securityReads).toBe(2);
    const draft = await openAdd(page, "Keep this draft");
    securityApi.group.etag = "security-etag-2";
    securityApi.group.rules.push(addedRule);
    securityApi.finish("succeeded");
    await page.clock.runFor(5000);
    // A read started before completion must finish before the new read can publish.
    expect(securityApi.securityReads).toBe(2);
    securityApi.holdSecurity = undefined;
    release();
    await expect.poll(() => securityApi.securityReads).toBe(3);
    await expect(page.getByText(addedRule.description, { exact: true })).toBeVisible();
    await expect(draft.getByLabel(/^说明/)).toHaveValue("Keep this draft");
    await draft.getByRole("button", { name: "添加规则", exact: true }).click();
    await expect(draft).not.toBeVisible();
    await expect(page.getByText(addedRule.description, { exact: true })).toBeVisible();
    expect(securityApi.operations[1]?.payload.etag).toBe("security-etag-2");
  } finally {
    securityApi.holdSecurity = undefined;
    release();
  }
});

for (const terminal of ["succeeded", "failed", "cancelled"] as const) {
  test(`删除规则在 ${terminal} 后重新读取规则和 ETag`, async ({ page, securityApi }) => {
    await openSecurity(page);
    await page
      .getByRole("row")
      .filter({ hasText: initialRule.description })
      .getByRole("button", { name: "删除", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "删除安全规则", exact: true });
    await dialog.getByRole("button", { name: "确认删除安全规则", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(securityApi.operations[0]).toMatchObject({
      kind: "security-rule-delete",
      payload: { etag: "security-etag-1", ruleId: initialRule.id },
    });
    await expect(page.getByText(initialRule.description, { exact: true })).toBeVisible();
    expect(securityApi.securityReads).toBe(1);
    securityApi.group.etag = "security-etag-2";
    if (terminal === "succeeded") securityApi.group.rules = [];
    securityApi.finish(terminal);
    await page.clock.runFor(5000);
    await expect.poll(() => securityApi.securityReads).toBe(2);
    await expect(page.getByText(initialRule.description, { exact: true })).toHaveCount(
      terminal === "succeeded" ? 0 : 1,
    );

    if (terminal === "failed") {
      // A retry can finish between polls: the same ID goes straight from the
      // previous failure to a new success without an observed pending state.
      securityApi.group.etag = "security-etag-3";
      securityApi.group.rules = [];
      securityApi.finish("succeeded");
      await page.clock.runFor(5000);
      await expect.poll(() => securityApi.securityReads).toBe(3);
      await expect(page.getByText(initialRule.description, { exact: true })).toHaveCount(0);
    }
    const reads = securityApi.securityReads;
    const finished = securityApi.jobs[0]!;
    securityApi.jobs.push(
      { ...finished, id: "other-instance-job", resourceId: "another-instance", state: "queued" },
      { ...finished, id: "rename-job", kind: "instance-rename", state: "queued" },
    );
    await page.clock.runFor(5000);
    for (const unrelated of securityApi.jobs.slice(1)) unrelated.state = "succeeded";
    await page.clock.runFor(5000);
    expect(securityApi.securityReads).toBe(reads);

    const next = await openAdd(page);
    await next.getByRole("button", { name: "添加规则", exact: true }).click();
    await expect(next).not.toBeVisible();
    expect(securityApi.operations[1]?.payload.etag).toBe(
      terminal === "failed" ? "security-etag-3" : "security-etag-2",
    );
  });
}

test("幂等提交直接返回终态时也重新读取安全规则", async ({ page, securityApi }) => {
  await openSecurity(page);
  securityApi.nextState = "succeeded";
  securityApi.onSubmit = () => {
    securityApi.group.etag = "security-etag-2";
    securityApi.group.rules.push(addedRule);
  };
  const dialog = await openAdd(page);
  await dialog.getByRole("button", { name: "添加规则", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText(addedRule.description, { exact: true })).toBeVisible();
  expect(securityApi.securityReads).toBe(2);
});
