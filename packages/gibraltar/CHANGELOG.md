# Changelog

## [Unreleased]

### Added

- `projectUsage(storage, context)` sums every conversation's `tg.usage` ledger in the storage's
  project and returns `{ conversations, usage }`. The fold happens at read time on purpose: the
  per-conversation ledger stays the only write path, so no second ledger can drift from it. A storage
  instance is one project's view (`scanConversations` filters on its `project_id`), so the project is
  not a parameter. `conversations` counts only conversations that recorded spend, because
  `createConversation` materializes an empty ledger.
- `Storage.deleteConversation(id, context)` removes a conversation's rows in one transaction: its
  conversation record, entries, tasks, submissions, and conversation- and task-scoped document
  incarnations with their revisions. It returns a `ConversationDeletion` summary and appends the same
  event to the durable deletion audit. The reserved root conversation is rejected; IDs are never
  reclaimed, so recreating a deleted ID is rejected by `commit`. Callers own liveness: no live task may
  still write the conversation, and no Session may hold its documents loaded.
- `Storage.exportConversation(id, context)` serializes a conversation's own rows as JSONL lines read
  from one consistent snapshot: a header carrying the conversation record, then entry, task,
  submission, and document lines in ascending ID order. The payload covers exactly what
  `deleteConversation` removes, so export-before-delete loses nothing.
- `Storage.backup(path, context)` writes a consistent snapshot of the whole database file with SQLite
  `VACUUM INTO`, including committed WAL content and every project in the file. The target must not
  exist and parent directories are not created. `MemoryStorage` has no file backend and rejects with an
  unsupported-capability error, which keeps the package root free of Node imports.

### Changed

- SQLite schema version 3 adds `durable_metadata.deleted_conversations`, an append-only JSON array
  holding one audit event per `deleteConversation` (`{v, conversationId, projectId, deletedAt,
  counts}`). The migration is a single `ALTER TABLE` on `durable_metadata`; no data table changes.
  `health()` reports `schemaVersion: 3`, and a version-2 file upgrades in place when opened. The column
  never joins the commit path: `commit`'s metadata read keeps listing `next_id` and `next_seq`.
- Rebranded from `@earendil-works/pi-durable` to `@OnePanda-TgSec/tg-gibraltar`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- Cross-package imports now use `@OnePanda-TgSec/chord` and `@OnePanda-TgSec/tg-ai`.
- `repository.directory` corrected from `packages/durable` to `packages/gibraltar`.

### Changed: persisted identifiers

Entry kinds (`pi.user`, `pi.assistant`, `pi.system`, `pi.reset`, `pi.tool-result`, `pi.compaction`),
document kinds (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`), and task kinds (`pi.generation`,
`pi.tool`) are now their `tg.*` equivalents.

These are persisted strings written into transcripts, document tables, and SQLite migrations. This is
a rename with no alias and no migration shim, because there is no existing storage to stay compatible
with. Storage written by an upstream `@earendil-works/pi-durable` release must have its kind strings
rewritten in place before it can be opened.

### Fixed

- Fork-history reads treat a missing ancestor conversation as the end of visible history instead of
  faulting. The ancestor walks asserted the parent row existed; deleting a fork parent would have made
  `scanEntries`, the two-argument `entry()`, and `findLatestHeadMarker` throw `TypeError` once the
  parent's rows were gone.
- Design-document links in the README now point at the in-repo `docs/` files instead of upstream
  GitHub URLs.

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@OnePanda-TgSec/tg-gibraltar`, a durable agent harness, adopted from
  `@earendil-works/pi-durable`. See the [README](README.md) and the
  [design document](docs/spec.md).