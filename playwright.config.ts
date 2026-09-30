import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT || 47819);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: process.env.E2E_OUTPUT_DIR || "test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 12000 },
  use: {
    baseURL: origin,
    browserName: "chromium",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox"],
    },
    viewport: { width: 393, height: 852 },
    isMobile: true,
    hasTouch: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `bun run preview --port ${port}`,
    url: origin,
    reuseExistingServer: false,
    timeout: 30000,
  },
});
