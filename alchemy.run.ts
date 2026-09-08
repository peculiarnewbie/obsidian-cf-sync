import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Config from "effect/Config";
import type { VaultDO } from "./packages/worker/src/worker.ts";

export default Alchemy.Stack(
  "obsidian-cf-sync",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const chunksBucket = yield* Cloudflare.R2.Bucket("vault-chunks");

    const site = yield* Cloudflare.Worker("obsidian-cf-sync", {
      main: "./packages/worker/src/worker.ts",
      compatibility: {
        date: "2025-01-01",
        flags: ["nodejs_compat"],
      },
      env: {
        CHUNKS_BUCKET: chunksBucket,
        SYNC_API_KEY: Config.redacted("SYNC_API_KEY"),
        VaultDO: Cloudflare.DurableObject<VaultDO>("VaultDO", {
          className: "VaultDO",
        }),
      },
      url: true,
    });

    return {
      url: site.url,
    };
  }),
);
