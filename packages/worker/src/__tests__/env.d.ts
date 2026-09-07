import type { Env as WorkerEnv } from "../worker";

// Bindings provided by vitest.config.ts and wrangler.toml in the test runtime.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
