# TODO

Priorities, in order. These are planned improvements, not current capabilities.

## 1. Worker frontend / dashboard

- [ ] Add an authenticated dashboard served by the Worker.
- [ ] List paired devices and allow revoking access.
- [ ] Show last activity and sync progress, distinguishing device-reported progress from server activity.
- [ ] Show vault file counts, storage usage, and unresolved conflicts.
- [ ] Add the device-listing and status endpoints needed by the UI.

## 2. Conflict merge heuristics

Current behavior preserves the losing edit in a conflict copy; it does not detect
whether edits can be merged automatically.

**Research prerequisite:** Before choosing or implementing merge heuristics,
study how other sync implementations handle conflicts. Do not assume a generic
text merge or a CRDT is the right solution for vault files.

- [ ] Research Obsidian Sync, Syncthing, CouchDB/PouchDB-based sync, and relevant
      text-merge/CRDT implementations. Use documentation and source where
      available; distinguish documented behavior from assumptions.
- [ ] Compare common-base retention, offline edits, conflict detection, merge
      granularity, and behavior for renames, deletions, and binary files.
- [ ] Write a design decision with sources, tradeoffs, and failure cases before
      implementing automatic merging.
- [ ] Evaluate retaining the exact base content for each pending edit and using
      a three-way merge of base, local, and server versions.
- [ ] Define which changes can merge safely, which require review, and how to
      preserve originals and recover from a bad merge. Include Markdown and
      frontmatter semantics.
- [ ] Ensure merged results still use version checks and retry safely if the
      server changes again during resolution.
- [ ] Add delayed-client E2E tests for disjoint edits, overlapping edits, repeated
      retries, offline handoffs, and rename/delete conflicts. Verify convergence
      and preservation of all edits.
- [ ] Add a review flow for conflicts that cannot be merged safely; retain
      conflict copies as the fallback.

## 3. Post-pairing initial-sync pause

Pairing succeeds, but first sync currently pauses whenever both sides contain
files—even when every local file matches the server and only additional remote
files need downloading. This affected the test vault containing a Welcome file.

- [ ] Adopt matching files as the shared baseline and download remote-only files
      without requiring the user to empty their local vault.
- [ ] Define a safe initial reconciliation flow for local-only files and actual
      content differences; do not infer deletion from an initial absence.
- [ ] Clearly distinguish pairing success, sync readiness, and reconciliation
      required in the UI. Avoid repeated pause notices.
- [ ] Add E2E coverage for matching files plus remote-only files, identical
      populated vaults, genuinely conflicting content, and interrupted recovery.

The launch deadlock after pairing was a separate bug, fixed in 0.1.1.
