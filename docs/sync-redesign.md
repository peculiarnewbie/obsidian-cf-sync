# Synchronization Redesign

## Status

This document is the implementation plan for moving the prototype from
event-driven best-effort syncing to a recoverable, ordered file-sync system.
The existing Worker, per-vault Durable Object, and R2 chunk store remain the
foundation. The plugin synchronization model changes substantially.

## Design decisions

### The change log is authoritative

The vault Durable Object assigns a total order through `globalVersion`. A
client advances its receive cursor only after it has durably applied each
preceding change. A locally committed change never lets the client skip older
unapplied remote changes.

### WebSockets are wake-ups, not replication

A WebSocket notification only tells a client that it should run its normal
catch-up process. It does not directly write a file, delete a file, or advance
the cursor. Polling remains the fallback when WebSockets are unavailable.

### One client-side coordinator owns synchronization

Vault events, reconnects, timers, and the manual command only request work
from one serialized coordinator. No other code path may concurrently fetch
changes, mutate the vault, advance the cursor, or commit local operations.

### Local metadata is bound to one sync identity

Persistent metadata is namespaced by the normalized Worker URL, vault ID, and
device ID. Reconfiguring any of those identities creates a fresh local state;
the plugin must enter bootstrap/reconciliation rather than reuse an unrelated
cursor or file version.

The prototype's unscoped IndexedDB database is intentionally not reused. An
upgrade therefore starts a fresh local reconciliation, which is safer than
trusting an ambiguous legacy cursor. Until the explicit bootstrap flow exists,
the plugin blocks automatic sync for a fresh scope that already contains
syncable local files. The old browser-managed cache can be removed manually
after a successful migration if storage pressure becomes an issue.

### First sync is explicit reconciliation

A fresh local database does not prove that local files are safe to overwrite.
The plugin determines whether local and remote vaults are empty and compares
chunk hashes at shared paths. It safely imports a remote-only vault and safely
journals a local-only vault. When both contain files, it pauses and reports a
non-destructive reconciliation summary rather than choosing a winner.

## Target synchronization pass

```text
requestSync()
  -> pull ordered server changes after acknowledged cursor
  -> apply and persist each change sequentially
  -> reconcile local vault events into durable outgoing operations
  -> commit outgoing operations with exact file-version checks
  -> pull again to observe canonical ordering
```

WebSockets and periodic timers only invoke `requestSync()`.

## Protocol direction

Every mutation will use an exact expected file version. The Durable Object will
return a discriminated result: committed, already committed, conflict,
rejected, or retry later. Rename becomes a first-class atomic operation instead
of a delete followed by a later create.

Changes will be paginated with a high-water mark so clients can apply a stable,
bounded sequence. R2 downloads will be authorized against the requested
vault's chunk membership, even if physical deduplication remains global.

## Migration stages

1. **Safety foundation**
   - Namespace IndexedDB by sync identity.
   - Make engine and WebSocket lifecycle idempotent and disposable.
   - Install vault listeners only after layout readiness.
   - Serialize sync triggers through one coordinator.
   - Use Obsidian trash for remote deletes during the transition.

2. **Ordered receive path**
   - [x] Make WebSockets wake-only.
   - [x] Apply changes one at a time and advance the cursor contiguously.
   - [x] Add polling and paginated change retrieval.

3. **Durable outgoing journal**
   - [x] Persist puts, deletes, and renames with the content needed to retry them.
   - [x] Keep required chunk data in IndexedDB until commit.
   - [x] Reconcile periodic scans with journal state.
   - [x] Send renames as one atomic operation once the Worker supports it.

4. **Bootstrap and conflict safety**
   - [x] Implement explicit empty/local/remote/both-populated classification.
   - [x] Never overwrite an unknown local file.
   - [x] Recheck a file before destructive remote application.
   - [ ] Add the user-directed reconciliation UI for both-populated vaults.

5. **Worker hardening**
   - [x] Require `baseFileVersion === currentFileVersion`.
   - [x] Add atomic, idempotent rename with an explicit Durable Object SQLite
         transaction.
   - [x] Bound chunk manifests and upload bodies, return structured internal
         failures, and authorize downloads by per-vault chunk membership.

6. **End-to-end validation and mobile support**
   - Test two real simulated clients against one local Worker/DO/R2 instance.
   - Cover restart, reconnect, concurrent edits, deletes, renames, and fresh
     bootstrap.
   - Use Obsidian mobile-safe request APIs and verify Android/iOS lifecycle
     behavior.

## Non-goals

This redesign does not introduce CRDTs, Git, or a generic replicated database.
The Durable Object remains the per-vault coordination point. End-to-end
encryption is a separate milestone, but storage and authorization APIs should
continue to treat chunk bodies as opaque data so encryption can fit cleanly.
