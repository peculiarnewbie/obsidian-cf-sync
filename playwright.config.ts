import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.browser.ts",
  fullyParallel: false,
  workers: 1,
  use: { baseURL: "http://127.0.0.1:8791", headless: true },
  webServer: {
    command:
      "pnpm exec wrangler dev --config tests/dashboard.wrangler.json --port 8791 --inspector-port 0 --local",
    url: "http://127.0.0.1:8791",
    reuseExistingServer: false,
    env: { CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" },
    timeout: 60_000,
  },
});
