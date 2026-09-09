# API

Sync and device-management HTTP endpoints require authentication and a vault ID.
The dashboard shell and pairing-key endpoint are public during testing.

Bootstrap authentication for device management:

- `Authorization: Bearer <SYNC_API_KEY>`.

Device authentication for sync:

- HTTP: `Authorization: Bearer <deviceToken>` and `X-Device-Id: <deviceId>`.
- WebSocket: `?token=<deviceToken>&deviceId=<deviceId>`.

Vault identity:

- Preferred: `X-Vault-Id: <vaultId>`.
- WebSocket fallback: `?vaultId=<vaultId>`.

Vault IDs must match `^[a-zA-Z0-9_-]{1,128}$`. File paths are canonical relative
paths (up to 2,048 characters): empty/dot/traversal segments, backslashes,
colons, and control characters are rejected. Device IDs are limited to 128
characters. JSON bodies are bounded to 512 KiB while streaming; malformed
JSON returns `400 INVALID_JSON`. CORS headers are returned on success and
error responses, as well as preflight.

## `POST /devices/enroll`

Enrolls or re-enrolls a device. Requires bootstrap authentication with `SYNC_API_KEY`.

Request:

```json
{
  "deviceId": "device-abc",
  "name": "Personal Vault",
  "platform": "desktop"
}
```

Response:

```json
{
  "success": true,
  "deviceId": "device-abc",
  "deviceToken": "64-byte-hex-token"
}
```

The Worker returns the raw device token once. The Durable Object stores only a SHA-256 hash. Re-enrollment rotates the token and closes that device's existing WebSockets.

## `POST /devices/revoke`

Revokes a device and closes its existing WebSockets with code 1008. Requires bootstrap authentication with `SYNC_API_KEY`.

Request:

```json
{
  "deviceId": "device-abc"
}
```

Response:

```json
{
  "success": true,
  "deviceId": "device-abc"
}
```

## Operations

The protocol supports three actions:

- `put`: create or update a file.
- `delete`: tombstone a file.
- `rename`: atomically tombstone `oldPath` and create or update `file`.

Every mutation is an exact compare-and-swap: `baseFileVersion` must equal the
current version at `file`, not merely be older than it. A rename also supplies
`oldBaseFileVersion`, which must exactly match the active source file's
version. An accepted manifest may contain at most 4,096 chunk hashes.

## `POST /sync/prepare`

Checks whether an operation can proceed and returns missing chunk hashes.

Example request:

```json
{
  "opId": "op-123",
  "action": "put",
  "file": "notes/example.md",
  "chunks": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  "mtime": 1710000000000,
  "size": 42,
  "baseFileVersion": 0,
  "deviceId": "device-abc"
}
```

Rename request example:

```json
{
  "opId": "op-rename-123",
  "action": "rename",
  "file": "notes/renamed.md",
  "oldPath": "notes/original.md",
  "chunks": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  "mtime": 1710000000000,
  "size": 42,
  "baseFileVersion": 0,
  "oldBaseFileVersion": 3,
  "deviceId": "device-abc"
}
```

Success response:

```json
{
  "success": true,
  "missing": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
  "currentVersion": 0
}
```

Already committed response:

```json
{
  "success": true,
  "alreadyCommitted": true,
  "globalVersion": 1,
  "fileVersion": 1
}
```

Conflict response:

```json
{
  "success": false,
  "conflict": true,
  "currentVersion": 2,
  "currentChunks": []
}
```

An operation ID is bound to its original payload and device. Reusing a
committed ID with changed content, paths, versions, timestamps, or device ID
returns `{ "success": false, "code": "OP_ID_REUSED", "error": "..." }` from
both prepare and commit. Such errors must not be treated as version conflicts.

## `PUT /sync/chunk/:hash`

Uploads a raw chunk body. The Worker computes SHA-256 over the body and rejects uploads where the computed hash does not match `:hash`. Chunk bodies may not exceed 512 KiB.

Response:

```json
{
  "success": true,
  "hash": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The Worker stores the body in R2 at `chunks/:hash` and registers the chunk in the vault Durable Object.

## `GET /sync/chunk/:hash`

Downloads a raw chunk body from R2. The authenticated device's vault must have
registered the hash; a global R2 object alone is not sufficient authorization.

Response content type is `application/octet-stream`.

## `POST /sync/commit`

Commits a prepared operation. The body shape is the same as `/sync/prepare`.

For `put` and `rename`, all chunks must already be registered. If a chunk is missing, the Durable Object returns:

```json
{
  "success": false,
  "error": "Chunk <hash> not registered. Upload it first.",
  "code": "CHUNK_NOT_REGISTERED"
}
```

Success response:

```json
{
  "success": true,
  "fileVersion": 1,
  "globalVersion": 1
}
```

## `GET /sync/changes?since=N&limit=100&through=M`

Returns an ordered, bounded page of changes after global version `N`.

- `limit` is optional, defaults to `100`, and may not exceed `100`.
- The first request omits `through`. Its `highWatermark` defines the stable
  window for that catch-up pass.
- Later pages send `through=<highWatermark>` and `since=<nextCursor>` until
  `hasMore` is `false`.
- A client may advance its durable receive cursor only after it has applied
  each returned change, in order.

Response:

```json
{
  "changes": [
    {
      "globalVersion": 1,
      "opId": "op-123",
      "path": "notes/example.md",
      "oldPath": null,
      "oldFileVersion": null,
      "action": "put",
      "fileVersion": 1,
      "deviceId": "device-abc",
      "chunks": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
      "mtime": 1710000000000,
      "size": 42,
      "timestamp": 1710000000100
    }
  ],
  "nextCursor": 1,
  "highWatermark": 1,
  "hasMore": false
}
```

## `GET /sync/index`

Returns the current non-deleted file index plus a `tombstones` array. Each
tombstone contains `path`, `mtime`, `fileVersion`, and `globalVersion`. A fresh
client must retain these versions before acknowledging the snapshot cursor,
so recreating a deleted path uses the correct compare-and-swap version.

Response:

```json
{
  "files": [
    {
      "path": "notes/example.md",
      "chunks": ["0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
      "mtime": 1710000000000,
      "size": 42,
      "fileVersion": 1,
      "globalVersion": 1
    }
  ],
  "globalVersion": 1
}
```

## `GET /sync/file?path=<encoded-path>`

Returns `{ "file": null }` for a path that never existed, or `{ "file": { ... } }`
with the file-index fields and a `deleted` boolean. Deleted entries carry an
empty chunk list and their current tombstone version. Conflict recovery uses
this endpoint rather than downloading the full index. A failed lookup must
leave the pending operation available for retry.

Deploy the updated Worker before updating clients that use this endpoint.

## `WS /sync/ws`

The Worker forwards WebSocket upgrades to the vault Durable Object.

The plugin connects with query parameters:

```text
wss://<worker-host>/sync/ws?token=<deviceToken>&vaultId=<vaultId>&deviceId=<deviceId>
```

Supported client message:

```json
{ "type": "ping" }
```

Response:

```json
{ "type": "pong" }
```

Broadcast message after successful commits:

```json
{
  "type": "file_changed",
  "action": "put",
  "file": "notes/example.md",
  "fileVersion": 1,
  "globalVersion": 1,
  "deviceId": "device-abc"
}
```

Ping/pong uses the Durable Object auto-response API to avoid waking a
hibernating object. Only `file_changed` notifications wake the plugin's sync
coordinator; pong messages do not initiate replication.

## Dashboard and device progress

`GET /` and `GET /dashboard` serve a dashboard shell that opens the default vault automatically.
`GET /admin/pairing-key` returns `{ "key": "<SYNC_API_KEY>" }` without authentication
or a vault ID during testing. Its response is marked `Cache-Control: no-store`.
`GET /admin/dashboard` requires the bootstrap key in `Authorization: Bearer …`
and a valid `X-Vault-Id`. Requests containing a `token` query parameter are
rejected, even with a valid header. Device tokens cannot access this endpoint. Responses
are marked `Cache-Control: no-store` and never include credentials or token hashes.

The response contains `globalVersion`, active `fileCount`, logical `fileBytes`,
`registeredChunkBytes`, `deviceCount`, `unresolvedConflictCount`, the latest 200
`devices` by server activity, and the latest 50 unresolved server `conflicts`.
Registered chunk bytes include retained/orphaned uploads for this vault and are
not physical account-wide R2 usage. Conflict records are not a complete inventory
of client-side conflict copies and are not automatically marked resolved when
users edit or delete those copies.

Each device includes identity, enrollment time, `lastSeen`, revocation and
WebSocket connection state, plus nullable `reportedAt`, `reportedVersion`,
`pendingOperations`, and `state`. `lastSeen` is server-observed authenticated
activity. A WebSocket connection does not imply synchronization. Report fields
remain null for clients that have not sent a report.

`POST /sync/status` accepts device authentication and this payload:

```json
{ "globalVersion": 12, "pendingOperations": 0, "state": "active" }
```

`globalVersion` is the last change applied locally, not merely downloaded.
Counts must be nonnegative safe integers; a cursor beyond the server version is
rejected. `state` is `active`, `initializing`, `needs-review`, or `error`.
The authenticated device identity is used; a caller cannot report another
device's progress. Reports are snapshots, not a guarantee that the device is
currently online or caught up. Reporting failures never advance the local
cursor or prevent content synchronization.

The dashboard's **Revoke** action uses the existing `POST /devices/revoke` route.
**Copy pairing key** copies the key fetched from `/admin/pairing-key`. Dashboard
authentication is deferred during testing; anyone with access to the Worker can
retrieve this key and use the admin APIs. The key is not stored in cookies,
local storage, session storage, or URLs. Deploy the Worker before upgrading
plugins to see progress; older Workers safely ignore failed progress requests.
