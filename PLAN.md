# Obsidian Cloudflare Sync

An Obsidian vault sync solution built on Cloudflare Workers, Durable Objects, DO SQLite, and R2. Replaces Obsidian Sync while exposing a queryable API surface for trusted apps to read and mutate the vault.

## Goals

1. **Automatic, real-time sync** across all Obsidian devices (desktop, mobile)
2. **Persistent state in Cloudflare** — vault metadata is queryable from any Worker
3. **API surface** — trusted clients/apps can read/mutate the vault via the same infrastructure
4. **End-to-end encryption** — content encrypted before leaving the device
5. **Conflict resolution** — concurrent edits handled gracefully

## Non-Goals (v1)

- Obsidian settings/theme/plugin sync (future)
- Shared vaults / multi-user (future)
- Content-aware merge (future — v1 is last-write-wins on conflicts)
- Publish / public sharing (future)

---

## System Overview

```
┌──────────────────┐         HTTP/WS          ┌───────────────────────────┐
│  Obsidian Plugin │◄────────────────────────►│  Cloudflare Worker        │
│                  │                          │  (entrypoint + auth)      │
│  - file watcher  │                          │                           │
│  - chunker       │                          │  Routes to DO by vault ID │
│  - local index   │                          │  Upload/download routing  │
│  - WS client     │                          │  Read endpoints (DO/R2)   │
└────────┬─────────┘                          └─────────────┬─────────────┘
         │                                                  │
         │  verified upload                                 │ RPC
         │  (chunk upload)                                  │
         ▼                                                  ▼
  ┌─────────────┐                               ┌───────────────────────┐
  │     R2      │                               │  Durable Object       │
  │             │                               │  (one per vault)      │
  │ chunks/     │                               │                       │
  │  {sha256}   │                               │  DO SQLite            │
  │             │                               │  - files table        │
  │ (immutable, │                               │  - devices table      │
  │  content-   │                               │  - changes table      │
  │  addressable│                               │                       │
  └─────────────┘                               │  Responsibilities:    │
                                                │  - validate commits   │
                                                │  - write metadata     │
                                                │  - detect conflicts   │
                                                │  - broadcast to       │
                                                │    connected devices  │
                                                │                       │
                                                │  Storage:             │
                                                │  - SQLite (DO native) │
                                                │  - explicit schema    │
                                                └───────────────────────┘
```

### Why This Split?

- **Worker** = stateless routing, auth, request validation, upload/download routing. No canonical metadata writes.
- **DO** = single coordination point for all mutations. Serializes writes, validates commits, handles conflicts, broadcasts change notifications. One per vault.
- **R2** = immutable blob storage for file content (chunks). Content-addressable.
- **DO SQLite** = canonical vault metadata and sync log. We use an explicit schema instead of a generic replicated store because file sync needs domain-specific commit validation and conflict handling.
- **TinyBase** = not in the critical path. It remains a useful reference for hibernating Durable Object WebSocket patterns, but the sync protocol is custom.
- **D1** = optional future read replica if we need cross-vault relational queries outside a single Durable Object.

---

## Data Model

### DO SQLite Schema

```sql
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  chunks_json TEXT NOT NULL,      -- ordered JSON array of chunk hashes
  mtime INTEGER NOT NULL,         -- client-reported file mtime
  size INTEGER NOT NULL,
  file_version INTEGER NOT NULL,  -- per-file monotonic version
  global_version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  last_device_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL     -- server timestamp
);

CREATE TABLE changes (
  global_version INTEGER PRIMARY KEY,
  op_id TEXT NOT NULL UNIQUE,     -- idempotency key from the client
  path TEXT NOT NULL,
  old_path TEXT,
  action TEXT NOT NULL,           -- 'update' | 'delete' | 'rename'
  file_version INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  chunks_json TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  last_sync_version INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE chunks (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at INTEGER NOT NULL
);

CREATE TABLE conflicts (
  conflict_id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  winning_global_version INTEGER NOT NULL,
  losing_device_id TEXT NOT NULL,
  losing_chunks_json TEXT NOT NULL,
  losing_mtime INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE vault_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

The DO is the only writer to these tables. All mutations happen inside one Durable Object turn so the `global_version` counter and conflict checks stay serialized.

### R2 Layout

```
{bucket}/
  chunks/
    {sha256}           # Raw chunk data. Immutable. Content-addressable.
```

No journal files. No metadata in R2. Just raw content blobs.

### Local State (Plugin, IndexedDB)

```typescript
// Local file index (mirrors the DO files table)
interface LocalFileIndex {
  [path: string]: {
    chunks: string[]      // chunk hashes
    mtime: number
    fileVersion: number
    globalVersion: number
  }
}

// Sync state
interface SyncState {
  globalVersion: number         // last version seen from DO
  lastFullSync: number          // timestamp
  pendingOps: SyncOperation[]   // idempotent local edits not yet committed
}

interface SyncOperation {
  opId: string
  action: 'update' | 'delete' | 'rename'
  path: string
  oldPath?: string
  baseFileVersion: number
  chunks: string[]
  mtime: number
  size: number
}
```

On Obsidian mobile, avoid Node/Electron APIs. Use browser-safe storage such as IndexedDB/IDB or Obsidian plugin data/files. TinyBase's built-in `IndexedDbPersister` does not support `MergeableStore`, but IndexedDB itself is viable in Obsidian mobile, as demonstrated by `obsidian-livesync`.

---

## Sync Protocol

### Phase 1: File Change Detected

```
Obsidian fires vault.on('modify', file)
  │
  ├─ 1. Read file content
  ├─ 2. Chunk into content-addressable pieces
  │     - fixed-size for v1 prototype
  │     - Rabin-Karp/content-defined chunking later if useful
  │     - Output: ordered array of { hash, data } pairs
  ├─ 3. Check local index: which chunks are new?
  ├─ 4. Store new chunks in local cache
  └─ 5. Queue sync operation for this file
```

### Phase 2: Sync Push

```
Plugin sends sync request
  │
  ├─ 6. POST /sync/prepare
  │     Body: { opId, file: "notes/todo.md", chunks: ["sha256_a","sha256_b"],
  │             mtime, size, baseFileVersion }
  │
  │     Worker routes to DO by vault ID
  │
  │     DO checks:
  │       - opId has not already committed
  │       - baseFileVersion vs current file version
  │       - if conflict → return conflict response
  │       - if OK → return { missing: ["sha256_b"], currentFileVersion }
  │
  ├─ 7. Upload missing chunks
  │     v1: upload through Worker so it can verify sha256 before writing R2
  │     later: use presigned URLs plus commit-time HEAD/hash validation
  │
  ├─ 8. POST /sync/commit
  │     Body: { opId, file: "notes/todo.md", chunks: [...], mtime, size,
  │             baseFileVersion }
  │
  │     DO:
  │       - Verify all referenced chunks exist in R2 / chunks table
  │       - Re-check baseFileVersion vs current file version
  │       - Insert changes row, update files row, bump globalVersion
  │       - Broadcast change notification via WebSocket to connected devices
  │
  └─ 9. Plugin receives { success: true, fileVersion: 42, globalVersion: 1247 }
        Update local index
```

### Phase 3: Sync Pull (Receive)

```
DO broadcasts via WebSocket
  │
  ├─ { type: 'file_changed', file: 'notes/todo.md', fileVersion: 42,
  │    globalVersion: 1247, deviceId: 'device-def' }
  │
  Plugin receives broadcast
  │
  ├─ 10. Fetch change/file metadata if needed, then compare chunks with local cache
  │       Identify missing chunks
  │
  ├─ 11. GET presigned download URLs for missing chunks
  │       POST /sync/download-urls { chunks: ["sha2"] }
  │       Worker returns presigned GET URLs
  │
  ├─ 12. Download missing chunks from R2
  │
  ├─ 13. Assemble file from chunks (ordered by chunk array)
  │
  ├─ 14. Write to local vault
  │
  └─ 15. Update local index
```

### Phase 4: Offline Catch-up

```
Plugin reconnects (WebSocket reconnected)
  │
  ├─ 16. GET /sync/changes?since={lastGlobalVersion}
  │       Worker queries the vault DO via RPC
  │       Returns: list of file changes since last known version
  │
  ├─ 17. For each changed file: execute Phase 3 (pull)
  │
  └─ 18. Send any queued local changes (Phase 2)
```

### Conflict Handling

```
Device A edits note.md (baseFileVersion: 41)
Device B edits note.md (baseFileVersion: 41)
  │
  Device A commits first → version becomes 42
  │
  Device B commits → DO sees baseFileVersion 41 < currentVersion 42
  │
  ├─ DO stores both versions in conflicts table
  ├─ Returns { success: false, conflict: true, currentVersion: 42 }
  ├─ Broadcasts conflict to both devices
  │
  Plugin receives conflict:
  ├─ Keep local version as "note (conflict copy).md"
  ├─ Download winning version as "note.md"
  └─ Show notice to user: "Conflict detected on note.md"
```

---

## Worker API Endpoints

```
POST   /sync/prepare          → DO RPC: check versions/idempotency, return missing chunks
PUT    /sync/chunk/:hash      → v1 upload path; Worker verifies sha256 then writes R2
POST   /sync/commit           → DO RPC: validate chunks + write metadata, broadcast
POST   /sync/download-urls    → Generate presigned GET URLs for chunks, or proxy download in v1
GET    /sync/index            → Get full file index (read-only, can hit DO or cached)
GET    /sync/changes?since=N  → Get changes since version N (read-only)
WS     /sync/ws               → WebSocket upgrade → DO (real-time push)

# Future API surface
GET    /api/vault/files       → List all files
GET    /api/vault/file/:path  → Read encrypted chunks / plaintext only for trusted clients with keys
PUT    /api/vault/file/:path  → Write a file through the same prepare/upload/commit protocol
```

---

## Durable Object Implementation

```typescript
import { DurableObject } from 'cloudflare:workers'

export class VaultDO extends DurableObject {
  sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    ctx.blockConcurrencyWhile(() => this.migrate())
  }

  async fetch(request: Request): Promise<Response> {
    // WebSocket upgrade for real-time sync
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      this.ctx.acceptWebSocket(pair[1])
      return new Response(null, { status: 101, webSocket: pair[0] })
    }

    // HTTP RPC calls
    const url = new URL(request.url)

    if (url.pathname === '/prepare') {
      return this.handlePrepare(await request.json())
    }
    if (url.pathname === '/commit') {
      return this.handleCommit(await request.json())
    }
    if (url.pathname === '/changes') {
      return this.handleChanges(url.searchParams.get('since'))
    }

    return new Response('Not found', { status: 404 })
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS files (...);
      CREATE TABLE IF NOT EXISTS changes (...);
      CREATE TABLE IF NOT EXISTS devices (...);
      CREATE TABLE IF NOT EXISTS chunks (...);
      CREATE TABLE IF NOT EXISTS conflicts (...);
      CREATE TABLE IF NOT EXISTS vault_meta (...);
    `)
  }

  async handlePrepare(body: PrepareRequest) {
    const { opId, file, chunks, baseFileVersion } = body

    const existingOp = this.sql
      .exec('SELECT global_version FROM changes WHERE op_id = ?', opId)
      .one()
    if (existingOp) {
      return Response.json({ success: true, alreadyCommitted: true, ...existingOp })
    }

    const current = this.sql
      .exec('SELECT file_version, chunks_json FROM files WHERE path = ?', file)
      .one()
    const currentVersion = Number(current?.file_version ?? 0)

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      return Response.json({
        success: false,
        conflict: true,
        currentVersion,
        currentChunks: JSON.parse(String(current.chunks_json)),
      })
    }

    const known = new Set(
      this.sql
        .exec(`SELECT hash FROM chunks WHERE hash IN (${chunks.map(() => '?').join(',')})`, ...chunks)
        .toArray()
        .map((row) => String(row.hash)),
    )
    const missing = chunks.filter((hash) => !known.has(hash))

    return Response.json({
      success: true,
      missing,
      currentVersion,
    })
  }

  async handleCommit(body: CommitRequest) {
    const { opId, file, chunks, mtime, size, baseFileVersion, deviceId } = body

    const existingOp = this.sql
      .exec('SELECT global_version FROM changes WHERE op_id = ?', opId)
      .one()
    if (existingOp) {
      return Response.json({ success: true, alreadyCommitted: true, ...existingOp })
    }

    const current = this.sql
      .exec('SELECT file_version FROM files WHERE path = ?', file)
      .one()
    const currentVersion = Number(current?.file_version ?? 0)

    if (currentVersion > 0 && baseFileVersion < currentVersion) {
      return Response.json({
        success: false,
        conflict: true,
        currentVersion,
      })
    }

    // Commit must only reference chunks already verified into R2/chunks.
    this.assertChunksKnown(chunks)

    const nextGlobalVersion = this.nextGlobalVersion()
    const nextFileVersion = currentVersion + 1
    const now = Date.now()
    const chunksJson = JSON.stringify(chunks)

    this.sql.exec(
      `INSERT OR REPLACE INTO files
       (path, chunks_json, mtime, size, file_version, global_version, deleted, last_device_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      file, chunksJson, mtime, size, nextFileVersion, nextGlobalVersion, deviceId, now,
    )
    this.sql.exec(
      `INSERT INTO changes
       (global_version, op_id, path, action, file_version, device_id, chunks_json, mtime, size, timestamp)
       VALUES (?, ?, ?, 'update', ?, ?, ?, ?, ?, ?)`,
      nextGlobalVersion, opId, file, nextFileVersion, deviceId, chunksJson, mtime, size, now,
    )
    this.sql.exec(
      `INSERT OR REPLACE INTO vault_meta (key, value) VALUES ('globalVersion', ?)`,
      String(nextGlobalVersion),
    )

    this.broadcast({ type: 'file_changed', file, fileVersion: nextFileVersion, globalVersion: nextGlobalVersion })

    return Response.json({
      success: true,
      fileVersion: nextFileVersion,
      globalVersion: nextGlobalVersion,
    })
  }

  async handleChanges(since: string | null) {
    const sinceVersion = parseInt(since ?? '0')

    const globalVersion = this.getGlobalVersion()
    const changes = this.sql
      .exec('SELECT * FROM changes WHERE global_version > ? ORDER BY global_version ASC', sinceVersion)
      .toArray()

    return Response.json({ changes, globalVersion })
  }

  // WebSocket handlers
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    // Device heartbeats, auth refresh, or explicit pull requests.
  }

  async webSocketClose(ws: WebSocket) {
    // Clean up device tracking if needed
  }
}
```

---

## Obsidian Plugin Architecture

```
main.ts (plugin entry point)
├── SyncEngine
│   ├── FileWatcher          — hooks into vault.on('create'/'modify'/'delete'/'rename')
│   ├── Chunker              — file → content-addressable chunks
│   │   └── RabinKarpChunker — rolling hash chunking (can adapt from livesync)
│   ├── SyncPush             — prepare → upload missing chunks → commit
│   ├── SyncPull             — receive broadcast → download URLs → fetch → assemble
│   └── ConflictHandler      — detect conflicts, create conflict copies
│
├── LocalState
│   ├── LocalIndex           — file → chunks mapping (IndexedDB or JSON file)
│   ├── ChunkCache           — hash → content cache (avoids re-downloading)
│   └── SyncState            — last synced version, pending changes queue
│
├── ConnectionManager
│   ├── WSClient             — WebSocket connection to DO
│   ├── ReconnectLogic       — exponential backoff, offline detection
│   └── AuthManager          — API key / token management
│
└── Settings
    ├── Vault ID             — which vault this device belongs to
    ├── Worker URL           — Cloudflare Worker endpoint
    ├── Encryption key       — E2EE passphrase (optional)
    └── Sync interval        — debounce for rapid edits
```

### Key Plugin Behaviors

1. **Debounced sync**: When user saves rapidly, batch changes and sync after 2s idle
2. **Chunk cache**: Keep a local hash → content cache to avoid redundant R2 reads
3. **Offline queue**: When offline, queue changes. Push all on reconnect.
4. **Conflict copies**: On conflict, keep local as `filename (conflict).md`, download winning version
5. **Startup sync**: On plugin load, fetch changes since last known version

### Mobile Constraints

- Obsidian mobile plugins run in a webview. Node.js and Electron APIs are unavailable.
- Use Obsidian `Platform.isIosApp` / `Platform.isAndroidApp` checks for platform-specific paths.
- Use Obsidian `requestUrl` or browser-safe `fetch` for HTTP. Verify WebSocket behavior on both Android and iOS.
- Local persistence should use IndexedDB/IDB or Obsidian plugin storage/files. `obsidian-livesync` demonstrates that IndexedDB/IDB-backed storage is viable in a mobile-compatible plugin.
- Mobile backgrounding can kill timers and sockets. Treat WebSocket messages as hints; correctness comes from `GET /sync/changes?since=N` on resume/reconnect.

### Chunking Strategy

For v1 prototype: **fixed-size chunks** (e.g., 256KB). Simple, no dependencies, and avoids creating excessive R2 objects.

For production: **Rabin-Karp rolling hash** (adapting from livesync's MIT-licensed code). Better deduplication — inserting one line doesn't invalidate all subsequent chunks.

```
Rabin-Karp parameters:
- Text files: avg chunk size = 64KB, min = 16KB, max = 256KB
- Binary files: avg chunk size = 1MB, min = 256KB, max = 4MB
- Rolling hash window: 48 bytes, prime = 31
- Boundary when: hash % avgChunkSize == 1 AND size in [min, max]
```

---

## End-to-End Encryption

### Approach

```
Plugin chunks BEFORE encrypting:
  plaintext file → chunk → encrypt each chunk(AES-256-GCM, key) → R2

Plugin decrypts AFTER download:
  R2 encrypted chunks → decrypt chunks → assemble plaintext file
```

Encrypting the whole file before chunking would make most edits rewrite all ciphertext chunks, defeating deduplication. V1 may skip E2EE entirely until the sync protocol is proven.

The DO and Worker never see plaintext. The DO only sees:
- Encrypted chunk hashes / object IDs
- File paths (can be obfuscated)
- Timestamps and version numbers

### Key Derivation

```
passphrase → PBKDF2(salt, 100000 iterations, SHA-256) → 256-bit encryption key
salt stored in DO (vault_meta table) — unique per vault
```

### What the DO Knows

- File paths (unless obfuscated)
- File sizes
- Chunk hashes (but not content)
- Edit timestamps
- Device IDs

It does NOT know file contents.

---

## Implementation Phases

### Phase 1: Core Sync (Prototype)

**Goal**: One file syncs between two Obsidian instances via Cloudflare.

- [ ] Worker + DO skeleton with explicit DO SQLite schema
- [ ] R2 bucket with verified Worker upload path
- [ ] Simple Obsidian plugin:
  - [ ] File watcher (vault.on('modify'))
  - [ ] Fixed-size chunker (256KB)
  - [ ] HTTP client for prepare/commit flow
  - [ ] Local file index (JSON file in vault)
  - [ ] File assembler (chunks → file)
- [ ] End-to-end test: edit file on Device A → see it appear on Device B

### Phase 2: Real-time Sync

**Goal**: Changes appear on other devices within seconds, automatically.

- [ ] WebSocket connection from plugin to DO
- [ ] DO broadcasts file changes to connected devices
- [ ] Plugin pulls missing chunks on broadcast
- [ ] Offline queue: changes buffered when disconnected, pushed on reconnect
- [ ] Change-since-version endpoint for catch-up sync
- [ ] Mobile smoke test: Android/iOS WebSocket reconnect and local queue persistence

### Phase 3: Conflict Handling

**Goal**: Concurrent edits don't lose data.

- [ ] DO detects version conflicts on commit
- [ ] Plugin creates conflict copies
- [ ] User notification in Obsidian
- [ ] Soft deletes (file deletion = set deleted flag, don't remove from R2 immediately)

### Phase 4: Robustness

**Goal**: Production-quality reliability.

- [ ] Rabin-Karp chunking (adapt from livesync)
- [ ] Chunk deduplication across files
- [ ] Debounced sync (batch rapid edits)
- [ ] Startup full-index sync
- [ ] Chunk garbage collection (R2 cleanup of unreferenced chunks)
- [ ] Error handling and retry logic

### Phase 5: Encryption

**Goal**: E2EE so Cloudflare can't read vault contents.

- [ ] AES-256-GCM encryption of chunks
- [ ] PBKDF2 key derivation
- [ ] Optional path obfuscation
- [ ] Salt management in DO

### Phase 6: API Surface

**Goal**: Trusted apps can read/mutate the vault.

- [ ] GET /api/vault/files — list files with metadata
- [ ] GET /api/vault/file/:path — read encrypted chunks, or plaintext only in a trusted client that has the key
- [ ] PUT /api/vault/file/:path — write file (same sync protocol)
- [ ] Auth: API keys with scoped permissions (read-only, read-write)
- [ ] Rate limiting
- [ ] Webhooks: notify external apps on file changes

### Phase 7: Polish

- [ ] Obsidian settings tab (vault ID, worker URL, encryption toggle)
- [ ] Status bar indicator (sync state, last sync time)
- [ ] Command palette commands (force sync, show sync status)
- [ ] Full mobile hardening (background/resume, reconnects, storage pressure)
- [ ] Plugin settings sync (hotkeys, themes — future)

---

## Cost Estimate

### Free Tier (single user, single vault)

| Resource | Free tier | Estimated usage |
|----------|-----------|-----------------|
| Worker requests | 100K/day | ~2-5K/day depending on chunk uploads/downloads |
| DO requests | 100K/day | ~1K/day metadata calls + WebSocket activity |
| DO duration | 13,000 GB-s/day | With hibernation: ~0 |
| DO SQLite reads | 5M/day | ~10K/day |
| DO SQLite writes | 100K/day | ~1K/day |
| R2 storage | 10GB | ~100MB (typical vault) |
| R2 Class A (writes) | 1M/month | ~1K/month |
| R2 Class B (reads) | 10M/month | ~5K/month |

**Verdict**: Comfortably within free tier for a personal vault.

### Paid Tier (scaling to multiple users)

- DO requests: $0.15/million
- DO duration: $12.50/million GB-s
- R2 storage: $0.015/GB/month
- R2 writes: $4.50/million
- R2 reads: $0.36/million

For 100 users with active vaults: ~$5-15/month total.

---

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| DO vs D1 for metadata | DO SQLite | Per-vault serialized writes, conflict checks, WebSocket fan-out. D1 can become a future read replica. |
| Chunking | Content-addressable (SHA-256) | Deduplication, integrity verification, immutable blobs. Use larger chunks to avoid excessive R2 objects. |
| Upload path | Worker-verified in v1 | Simpler integrity and abuse control. Presigned URLs can come later once commit validation is solid. |
| Conflict strategy | Last-write-wins + conflict copies | Simple for v1. Content-aware merge later. |
| Encryption | AES-256-GCM client-side | DO never sees plaintext. Trustless. |
| TinyBase | Not core | Good reference for DO WebSocket hibernation, but file sync needs custom domain protocol. |
| DO hibernation | Yes, if WebSocket code remains hibernation-compatible | Cost savings. Correctness cannot depend on in-memory state surviving. |
| Local persistence | IndexedDB/IDB or Obsidian plugin storage | Offline support. Survives Obsidian restart and mobile app suspension. |

---

## References

- [TinyBase + Cloudflare DO integration](https://tinybase.org/guides/integrations/cloudflare-durable-objects/) — reference for hibernating DO WebSockets
- [TinyBase MergeableStore persistence notes](https://tinybase.org/guides/synchronization/using-a-mergeablestore/) — confirms built-in IndexedDbPersister does not persist MergeableStore
- [Cloudflare DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Obsidian mobile development](https://docs.obsidian.md/Plugins/Getting+started/Mobile+development)
- [Obsidian Plugin API](https://docs.obsidian.md/Reference/TypeScript/App)
- [obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync) — mobile-compatible sync/plugin reference and chunking ideas (MIT license)
