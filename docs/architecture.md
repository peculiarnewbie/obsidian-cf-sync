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
- Request types for atomic `put`, `delete`, and `rename` operations.
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
- Chunk hash and size validation before writing to R2.
- Vault-membership authorization before proxying R2 chunk downloads.
- Durable Object routing by `vaultId`.

The Durable Object handles:

- Schema creation for `files`, `changes`, `devices`, `chunks`, `conflicts`, and `vault_meta`.
- Device enrollment, token hash storage, validation, and revocation.
- Idempotency by `opId`.
- Exact per-file version compare-and-swap conflict detection.
- Atomic metadata, change-log, and global-version updates through a Durable
  Object SQLite transaction.
- Global version assignment.
- Change log queries.
- Full active-file index queries with tombstones, plus individual file-state lookup.
- WebSocket accept, ping/pong, and change broadcasts.

### `packages/plugin`

Contains the Obsidian plugin:

- `main.ts`: plugin lifecycle, commands, and settings wiring.
- `settings.ts`: Obsidian settings tab.
- `sync-engine.ts`: file watching, chunking, prepare/upload/commit, catch-up, pull, delete, conflict copy handling.
- `connection.ts`: WebSocket connect/reconnect/ping logic.
- `local-state.ts`: IndexedDB persistence for sync metadata and chunk cache.

The plugin ignores files under Obsidian's configured vault configuration directory for automatic syncing.

## Data Model

The Durable Object owns canonical metadata:

- `files`: current file state, including path, chunks, file version, global version, tombstone flag, and last device.
- `changes`: append-only sync log keyed by global version; rename records carry
  both the old path and its resulting tombstone version.
- `chunks`: registered chunk hashes and sizes.
- `conflicts`: records losing writes when a stale base file version is committed.
- `vault_meta`: stores global metadata such as current `globalVersion`.
- `devices`: enrolled device records, token hashes, revocation state, and last-seen timestamps.

The plugin owns local metadata in IndexedDB:

- `files`: last known local file metadata, including deletion tombstones so a
  later recreation can use the exact current file version.
- `syncState`: last seen global version.
- `pendingOps`: a durable, ordered journal of `put`, `delete`, and atomic
  `rename` operations, including operation IDs and exact base versions.
- `chunkCache`: cached chunk bodies plus the immutable chunk snapshots needed
  to retry pending puts after a restart or while the live file is unavailable.

Device credentials are stored in Obsidian plugin settings:

- `deviceId`: generated locally on first plugin load.
- `deviceToken`: returned by `/devices/enroll` and used for sync authentication.
- `apiKey`: bootstrap key entered for pairing and cleared after a successful enrollment.

## Enrollment Flow

1. User configures Worker URL, vault ID, and bootstrap API key in the plugin settings.
2. User clicks `Pair device`.
3. Plugin sends `POST /devices/enroll` with `deviceId`, vault name, and platform.
4. Worker authenticates the request with `SYNC_API_KEY`.
5. Worker generates a device token, hashes it with SHA-256, and asks the vault Durable Object to store the device.
6. Plugin stores the returned device token in plugin settings.
7. Future sync calls use `Authorization: Bearer <deviceToken>` plus `X-Device-Id`.

## Initial Reconciliation

On a new local sync identity, the plugin fetches the remote index before it
installs file listeners or writes to the vault.

- Empty local + empty remote: records the current cursor and starts normally.
- Empty local + remote files: persists the index snapshot, resumes imports from
  that snapshot after interruptions, then records the index cursor. Matching
  files written before their metadata acknowledgement can be adopted on resume.
- Local files + empty remote: snapshots the local files into the durable
  journal before recording the cursor.
- Local files + remote files: hashes shared local paths, logs a count of
  matching, local-only, remote-only, and conflicting paths, then pauses. It
  does not overwrite or upload either side until a user-directed reconciliation
  flow exists.

During normal receives, an existing local file without a corresponding local
metadata record is treated the same way: the remote operation stops rather
than overwriting that untracked file.

## Sync Flow

For a file write:

1. The plugin receives an Obsidian create, modify, delete, or rename event.
2. It snapshots a put's fixed 256 KB chunk bodies into IndexedDB, then stores a
   durable pending operation before attempting network work.
3. The serialized coordinator reconciles periodic scans with that journal.
4. It durably marks the operation attempted before sending it. Attempted
   payloads are immutable; later edits/deletes/renames become ordered successors.
   It calls `POST /sync/prepare` with the operation's path, chunk hashes, exact
   base file version, and device ID. A rename includes exact source and
   destination versions.
5. The Worker validates the device token against the vault Durable Object.
6. The Durable Object checks idempotency, conflict state, and which chunks are registered.
7. The plugin uploads missing chunks with `PUT /sync/chunk/:hash` from the
   stored snapshot, not the live file.
8. The Worker verifies each uploaded body matches `:hash`, stores it in R2, and registers the chunk in the Durable Object.
9. The plugin calls `POST /sync/commit` and removes the journal record only
   after a committed, already-committed, or conflict-resolved outcome.
10. The Durable Object atomically writes file metadata (both source tombstone
    and destination for a rename), one change record, and `globalVersion`, then
    broadcasts a WebSocket change message.

For remote changes:

1. Connected plugins receive a `file_changed` WebSocket message.
2. The message only wakes the serialized sync coordinator; it does not directly mutate the vault.
3. The coordinator reads bounded `/sync/changes` pages, holding the server's first `highWatermark` for the whole pass.
4. It applies each change in global-version order and persists the receive cursor after each successful application.
5. Periodic polling provides the same catch-up path when the WebSocket is unavailable.

## Conflict Behavior

The Durable Object uses per-file monotonic `fileVersion` values. A client must
commit with the exact `baseFileVersion`; either stale or future values return a
conflict response. On commit conflicts, it also stores a row in `conflicts`.

The plugin responds by creating a local conflict copy and looking up the
canonical path state (including tombstones). Lookup errors leave the operation
pending. Protocol errors are retried/reported rather than classified as conflicts.
This still needs product polish before production use.

The engine snapshots its configuration. Settings changes shut down and drain
the previous engine before creating another; disabling sync stops it. Startup
waits for layout readiness before inspecting the vault. Remote application
checks cancellation before filesystem mutations and skips already-acknowledged versions, including an equal version echoed after
a local commit. This preserves edits made while that commit was in flight.
An echoed pending operation acknowledges its snapshot without replacing newer
local edits. Configuration paths are excluded in both directions.

Periodic reconciliation compares file size and modification time before
reading unchanged bodies, with a full hash audit every five minutes while
active. This reduces idle work while retaining a fallback for missed events.
