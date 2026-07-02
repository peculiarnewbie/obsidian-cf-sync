# Development

## Workspace

This repo is a pnpm workspace with packages under `packages/*`.

Useful commands from the repo root:

```sh
pnpm install
pnpm dev
pnpm dev:worker
pnpm dev:plugin
pnpm build:plugin
pnpm test
pnpm lint
pnpm fmt
pnpm check
pnpm typecheck
pnpm deploy
pnpm plan
pnpm destroy
```

Command meanings:

- `pnpm dev`: runs `vp exec alchemy dev`.
- `pnpm dev:worker`: runs `wrangler dev` for the Worker package.
- `pnpm dev:plugin`: watches and rebuilds the Obsidian plugin with Vite.
- `pnpm build:plugin`: builds the installable plugin folder at `packages/plugin/dist`.
- `pnpm test`: runs Worker tests.
- `pnpm deploy`: deploys the Alchemy stack.

## Worker Development

The Worker entrypoint is `packages/worker/src/worker.ts`.

Local Wrangler config is `wrangler.toml`:

- Worker name: `obsidian-cf-sync`.
- Main module: `packages/worker/src/worker.ts`.
- R2 binding: `CHUNKS_BUCKET`.
- Durable Object binding: `VaultDO`.
- Migration: `new_sqlite_classes = ["VaultDO"]`.

Run the Worker locally:

```sh
pnpm dev:worker
```

Run Worker tests:

```sh
pnpm test
```

Tests live in `packages/worker/src/__tests__/vault-do.test.ts` and cover:

- DO sync lifecycle.
- Conflict detection.
- Unknown chunk rejection.
- Empty files.
- Delete tombstones.
- Two enrolled devices syncing create/delete changes through the same vault.
- Revoked devices being blocked from future sync.
- Auth rejection.
- HTTP upload/prepare/commit/changes flow.
- Vault isolation by `vaultId`.

## Plugin Development

Build the plugin:

```sh
pnpm build:plugin
```

Watch plugin builds:

```sh
pnpm dev:plugin
```

Build output goes to `packages/plugin/dist`. The Vite build copies `manifest.json` and `styles.css` into that folder alongside `main.js`, so `dist` can be copied directly into an Obsidian vault plugin directory.

Manual install into a vault:

```sh
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-cf-sync
cp packages/plugin/dist/main.js /path/to/vault/.obsidian/plugins/obsidian-cf-sync/main.js
cp packages/plugin/dist/manifest.json /path/to/vault/.obsidian/plugins/obsidian-cf-sync/manifest.json
cp packages/plugin/dist/styles.css /path/to/vault/.obsidian/plugins/obsidian-cf-sync/styles.css
```

Then enable `Obsidian CF Sync` in Obsidian settings, configure Worker URL, vault ID, and API key, and click `Pair device`.

The plugin is marked `isDesktopOnly: false`, and the implementation avoids Node/Electron APIs in runtime sync code. Local state uses IndexedDB.

## Deployment

Alchemy is the primary deployment path in this repo.

`alchemy.run.ts` provisions:

- `SYNC_API_KEY` secret.
- `vault-chunks` R2 bucket.
- Worker named `obsidian-cf-sync`.
- `CHUNKS_BUCKET`, `SYNC_API_KEY`, and `VaultDO` bindings.
- Public Worker URL.

Plan deployment:

```sh
pnpm plan
```

Deploy:

```sh
pnpm deploy
```

Destroy:

```sh
pnpm destroy
```

## Manual API Smoke Test

Set environment variables:

```sh
export WORKER_URL="http://localhost:8787"
export SYNC_API_KEY="your-key"
export VAULT_ID="dev-vault"
export DEVICE_ID="smoke-device"
```

Enroll a device:

```sh
export DEVICE_TOKEN=$(curl -s -X POST "$WORKER_URL/devices/enroll" \
  -H "Authorization: Bearer $SYNC_API_KEY" \
  -H "X-Vault-Id: $VAULT_ID" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"smoke-device","name":"Smoke Device","platform":"test"}' | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.parse(data).deviceToken));')
```

Check index:

```sh
curl -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Vault-Id: $VAULT_ID" -H "X-Device-Id: $DEVICE_ID" "$WORKER_URL/sync/index"
```

Prepare an empty file commit:

```sh
curl -X POST "$WORKER_URL/sync/prepare" \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "X-Vault-Id: $VAULT_ID" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"opId":"smoke-1","action":"put","file":"smoke.md","chunks":[],"mtime":1,"size":0,"baseFileVersion":0,"deviceId":"smoke-device"}'
```

Commit it:

```sh
curl -X POST "$WORKER_URL/sync/commit" \
  -H "Authorization: Bearer $DEVICE_TOKEN" \
  -H "X-Vault-Id: $VAULT_ID" \
  -H "X-Device-Id: $DEVICE_ID" \
  -H "Content-Type: application/json" \
  -d '{"opId":"smoke-1","action":"put","file":"smoke.md","chunks":[],"mtime":1,"size":0,"baseFileVersion":0,"deviceId":"smoke-device"}'
```

Fetch changes:

```sh
curl -H "Authorization: Bearer $DEVICE_TOKEN" -H "X-Vault-Id: $VAULT_ID" -H "X-Device-Id: $DEVICE_ID" "$WORKER_URL/sync/changes?since=0"
```

## Known Development Gaps

- Add plugin tests around file watching, local state, chunking, conflict copies, and reconnect catch-up.
- Add end-to-end tests that drive two simulated clients against one vault.
- Add encryption before any production data use.
- Add a better approval UX for device enrollment and support token rotation.
- Add first-class rename protocol support.
- Add chunk reference count updates and garbage collection.
- Decide whether chunk downloads should remain proxied or move to signed URLs.
- Add release packaging for Obsidian community/manual installation.
