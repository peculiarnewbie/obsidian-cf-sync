import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("../plugin/src/__tests__/obsidian.ts", import.meta.url)),
    },
  },
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      wrangler: { configPath: "../../wrangler.toml" },
      miniflare: { bindings: { SYNC_API_KEY: "e2e-bootstrap" } },
    }),
  ],
});
