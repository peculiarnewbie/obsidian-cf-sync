# API

All current HTTP endpoints require authentication and a vault ID.

Bootstrap authentication for device management:

- `Authorization: Bearer <SYNC_API_KEY>`.

Device authentication for sync:

- HTTP: `Authorization: Bearer <deviceToken>` and `X-Device-Id: <deviceId>`.
- WebSocket: `?token=<deviceToken>&deviceId=<deviceId>`.

Vault identity:

- Preferred: `X-Vault-Id: <vaultId>`.
- WebSocket fallback: `?vaultId=<vaultId>`.

Vault IDs must match `^[a-zA-Z0-9_-]{1,128}$`.

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

The Worker returns the raw device token once. The Durable Object stores only a SHA-256 hash.

## `POST /devices/revoke`

Revokes a device. Requires bootstrap authentication with `SYNC_API_KEY`.

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

Returns the current non-deleted file index.

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
