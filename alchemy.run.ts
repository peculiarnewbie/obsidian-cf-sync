import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import type { VaultDO } from "./packages/worker/src/worker.ts";

export default Alchemy.Stack(
  "obsidian-cf-sync",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const apiKey = yield* Alchemy.Secret("SYNC_API_KEY");

    const chunksBucket = yield* Cloudflare.R2Bucket("vault-chunks");

    const site = yield* Cloudflare.Worker("obsidian-cf-sync", {
      main: "./packages/worker/src/worker.ts",
      compatibility: {
        date: "2025-01-01",
        flags: ["nodejs_compat"],
      },
      bindings: {
        CHUNKS_BUCKET: chunksBucket,
        SYNC_API_KEY: apiKey,
        VaultDO: Cloudflare.DurableObjectNamespace<VaultDO>("VaultDO", {
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
