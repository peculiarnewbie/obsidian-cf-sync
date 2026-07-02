# Architecture

## Runtime Shape

Obsidian CF Sync has three runtime pieces:

- Obsidian plugin: observes local vault changes, chunks file content, keeps local IndexedDB metadata, and talks to the Worker.
- Cloudflare Worker: authenticates requests, validates vault identity, proxies chunk upload/download, and routes metadata operations to the right Durable Object.
- `VaultDO`: one Durable Object instance per `vaultId`, storing canonical file metadata and change history in DO SQLite.

R2 stores raw chunk bodies at `chunks/{sha256}`. Metadata lives in the Durable Object, not in R2.

## Packages

### `packages/protocol`

Defines the shared protocol using Effect Schema:

- Branded types for vault IDs, device IDs, operation IDs, file paths, chunk hashes, file versions, and global versions.
- Request types for `put` and `delete` operations.
- Response schemas for prepare, commit, changes, index, and chunk upload.
- An Effect HTTP API contract in `src/http-api.ts`.

Both the Worker tests and plugin use these schemas to validate payloads.

### `packages/worker`

Contains `src/worker.ts`, which exports:

- The Worker `fetch` handler.
- The `VaultDO` Durable Object class.

The Worker handles:

- Device authentication through `Authorization: Bearer <deviceToken>` and `X-Device-Id` for sync requests.
- Bootstrap authentication through `Authorization: Bearer <SYNC_API_KEY>` for enrollment and revocation.
- Vault selection through `X-Vault-Id` or `?vaultId=<id>`.
- JSON request validation through shared schemas.
- Chunk hash validation before writing to R2.
- R2 chunk download proxying.
- Durable Object routing by `vaultId`.

The Durable Object handles:

- Schema creation for `files`, `changes`, `devices`, `chunks`, `conflicts`, and `vault_meta`.
- Device enrollment, token hash storage, validation, and revocation.
- Idempotency by `opId`.
- Per-file version conflict detection.
- Global version assignment.
- Change log queries.
- Full active-file index queries.
- WebSocket accept, ping/pong, and change broadcasts.

### `packages/plugin`

Contains the Obsidian plugin:

- `main.ts`: plugin lifecycle, commands, and settings wiring.
- `settings.ts`: Obsidian settings tab.
- `sync-engine.ts`: file watching, chunking, prepare/upload/commit, catch-up, pull, delete, conflict copy handling.
- `connection.ts`: WebSocket connect/reconnect/ping logic.
- `local-state.ts`: IndexedDB persistence for sync metadata and chunk cache.

The plugin ignores files under `.obsidian/` for automatic syncing.

## Data Model

The Durable Object owns canonical metadata:

- `files`: current file state, including path, chunks, file version, global version, tombstone flag, and last device.
- `changes`: append-only sync log keyed by global version.
- `chunks`: registered chunk hashes and sizes.
- `conflicts`: records losing writes when a stale base file version is committed.
- `vault_meta`: stores global metadata such as current `globalVersion`.
- `devices`: enrolled device records, token hashes, revocation state, and last-seen timestamps.

The plugin owns local metadata in IndexedDB:

- `files`: last known local file metadata.
- `syncState`: last seen global version.
- `pendingOps`: queued offline operations.
- `chunkCache`: cached chunk bodies and metadata.

Device credentials are stored in Obsidian plugin settings:

- `deviceId`: generated locally on first plugin load.
- `deviceToken`: returned by `/devices/enroll` and used for sync authentication.
- `apiKey`: bootstrap key used only to pair/re-pair the device.

## Enrollment Flow

1. User configures Worker URL, vault ID, and bootstrap API key in the plugin settings.
2. User clicks `Pair device`.
3. Plugin sends `POST /devices/enroll` with `deviceId`, vault name, and platform.
4. Worker authenticates the request with `SYNC_API_KEY`.
5. Worker generates a device token, hashes it with SHA-256, and asks the vault Durable Object to store the device.
6. Plugin stores the returned device token in plugin settings.
7. Future sync calls use `Authorization: Bearer <deviceToken>` plus `X-Device-Id`.

## Sync Flow

For a file write:

1. The plugin receives an Obsidian create or modify event.
2. The plugin debounces changes, reads the file, and splits it into fixed 256 KB chunks.
3. Each chunk is hashed with SHA-256.
4. The plugin calls `POST /sync/prepare` with the file path, chunk hashes, base file version, and device ID.
5. The Worker validates the device token against the vault Durable Object.
6. The Durable Object checks idempotency, conflict state, and which chunks are registered.
7. The plugin uploads missing chunks with `PUT /sync/chunk/:hash`.
8. The Worker verifies each uploaded body matches `:hash`, stores it in R2, and registers the chunk in the Durable Object.
9. The plugin calls `POST /sync/commit`.
10. The Durable Object writes file metadata and a change record, bumps `globalVersion`, and broadcasts a WebSocket change message.

For remote changes:

1. Connected plugins receive a `file_changed` WebSocket message.
2. The origin device ignores its own message.
3. Other devices fetch `/sync/index`, locate the file entry, download any missing chunks, assemble the file, and write it to the vault.
4. On reconnect, the plugin calls `/sync/changes?since=<lastGlobalVersion>` and applies missed changes.

## Conflict Behavior

The Durable Object uses per-file monotonic `fileVersion` values. If a client commits with a stale `baseFileVersion`, the DO returns a conflict response. On commit conflicts, it also stores a row in `conflicts`.

The plugin currently responds by creating a local conflict copy and pulling the server version. This is intentionally simple and needs product polish before production use.
