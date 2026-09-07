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

- `pnpm dev`: runs `alchemy dev`.
- `pnpm dev:worker`: runs `wrangler dev` for the Worker package.
- `pnpm dev:plugin`: watches and rebuilds the Obsidian plugin with Vite.
- `pnpm build:plugin`: builds the installable plugin folder at `packages/plugin/dist`.
- `pnpm test`: runs Worker and plugin tests.
- `pnpm deploy`: deploys the Alchemy stack.

## TypeScript, linting, and formatting

The workspace uses TypeScript 7.0.2 (`tsc`), Oxlint 1.82.0, and Oxfmt 0.67.0
as direct dependencies. Vite Plus wrappers and the old TypeScript native
preview are no longer used. The root uses standard Vite 8 for Alchemy's peer
requirement; the plugin retains its existing Vite 6 build.

- `pnpm fmt`: format with Oxfmt; `.oxfmtrc.json` defines the configuration.
- `pnpm fmt:check`: check formatting without editing files.
- `pnpm lint`: run Oxlint using `oxlint.json`.
- `pnpm typecheck`: check the deployment code and every workspace package,
  including plugin tests, the simulated client, and Worker/E2E tests.
- `pnpm check`: run formatting checks, linting, and all typechecks.

Worker runtime code is checked with Workers globals. `tsconfig.test.json`
additionally includes browser types because the E2E suite runs browser-side
plugin code with simulated IndexedDB in the Workers test pool. Test bindings
are declared in `src/__tests__/env.d.ts`, derived from the Worker's `Env`.
The standalone Oxc dependencies exclude optional Vite Plus/type-aware lint
peers; TypeScript performs the full typecheck.

Effect 4.0.0-beta.70 supplies protocol schemas and the shared HTTP API contract.
Alchemy deployment uses `Effect.gen`; the plugin's sync coordinator and Worker
request handlers otherwise use ordinary async/await.

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
- Exact-version rejection, atomic rename, and rename idempotency.
- Two enrolled devices syncing create/delete changes through the same vault.
- Revoked devices being blocked from future sync.
- Auth rejection.
- HTTP upload/prepare/commit/changes flow.
- Vault-scoped chunk download authorization.
- Vault isolation by `vaultId`.

Plugin tests cover scoped local-state storage, durable pending-operation
snapshots, retrying an upload after its live file is unavailable, and WebSocket
lifecycle safety. They also cover remote-only and local-only first sync, the
both-populated safety pause, and rejection of remote writes to unknown local
files.

## Simulated-client end-to-end tests

Run `pnpm test:e2e` for `packages/worker/src/__tests__/sync-e2e.test.ts`.
The suite also runs as part of `pnpm test`.

Two real `SyncEngine` instances use independent in-memory Obsidian vaults,
real file event callbacks, and separate scoped databases backed by
`fake-indexeddb`. Requests go through `SELF.fetch` to the Worker entrypoint in
Cloudflare's Vitest Workers pool (Miniflare/workerd), with real local SQLite
Durable Objects and R2. Enrollment, authentication, prepare, chunk transfer,
commit, index, and changes responses are not mocked.

A delivery controller can hold a particular device's request before dispatch
or its response after the server has executed it. Each hold exposes a
`reached` promise and an explicit `release(drop)` control. This reproduces
latency, responses overtaken by newer commits, and lost acknowledgements
without arbitrary sleeps. Devices can also be taken offline independently.

Passing scenarios cover:

- Create, multi-chunk content, edit, atomic rename, delete, and recreation.
- Fresh remote import and offline edits retained across engine restart.
- Delayed downloads leaving the receive cursor unchanged until application.
- Lost commit acknowledgements without duplicate server mutations.
- Interrupted multi-chunk upload followed by restart and retry.
- Concurrent edits with a delayed commit, preserving both versions.
- An old change-page response arriving after a newer server commit.

Additional recovery and safety scenarios cover edits, deletions, and rename
chains following ambiguous commits; interrupted bootstrap and shutdown;
fresh-client tombstone reuse; corrupt chunk rejection; excluded incoming
configuration paths; plugin enable/disable; and idle file-read avoidance.
The original two expected failures are now ordinary passing regression tests.
Worker integration tests separately exercise a real WebSocket being closed
on device revocation, changed-payload operation-ID reuse, canonical paths,
CORS, and streaming body limits.

WebSocket delivery is deliberately unavailable, exercising HTTP catch-up
without notifications. Tests request coordinator passes explicitly rather
than waiting for polling/debounce timers. Restart creates a new engine over
retained local files and IndexedDB; it does not simulate process termination
at every filesystem/IndexedDB instruction. Real Obsidian desktop/mobile,
browser CORS, WebSocket transport, OS filesystem semantics, IndexedDB eviction,
and device background suspension still require separate validation.

## Plugin Development

Build the plugin:

```sh
pnpm build:plugin
```

Watch plugin builds:

```sh
pnpm dev:plugin
```

Build output goes to `packages/plugin/dist`. Production JavaScript is minified; source maps are separate files rather than embedded in `main.js`. The Vite build copies `manifest.json` and `styles.css` into that folder alongside `main.js`, so `dist` can be copied directly into an Obsidian vault plugin directory.

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

- Extend E2E coverage to actual WebSocket delivery, pagination, and process interruption during filesystem/IndexedDB writes.
- Add encryption before any production data use.
- Add a better approval UX for device enrollment and support token rotation.
- Add chunk reference count updates and garbage collection.
- Decide whether chunk downloads should remain proxied or move to signed URLs.
- Add release packaging for Obsidian community/manual installation.
