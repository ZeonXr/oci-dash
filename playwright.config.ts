import { defineConfig } from "@playwright/test";
import { join } from "node:path";

const requestedBaseURL = process.env.E2E_BASE_URL || "http://localhost:3000";
const parsed = new URL(requestedBaseURL);
if (
  !["http:", "https:"].includes(parsed.protocol) ||
  !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
  parsed.username ||
  parsed.password ||
  parsed.pathname !== "/" ||
  parsed.search ||
  parsed.hash
) {
  throw new Error("E2E_BASE_URL must be the origin of a local isolated OCI Dash test server.");
}

const outputDirectory = process.env.E2E_OUTPUT_DIR || "./test-results";

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: join(outputDirectory, "playwright"),
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["html", { outputFolder: join(outputDirectory, "report"), open: "never" }]],
  use: {
    baseURL: parsed.origin,
    browserName: "chromium",
    channel:
      process.env.E2E_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    headless: true,
    viewport: { width: 1440, height: 1080 },
    locale: "zh-CN",
    navigationTimeout: 45_000,
    actionTimeout: 20_000,
    // Traces contain login request bodies. Keep them off even when a test fails.
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
