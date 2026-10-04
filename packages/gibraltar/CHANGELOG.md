# Changelog

## [Unreleased]

### Changed

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

- Design-document links in the README now point at the in-repo `docs/` files instead of upstream
  GitHub URLs.

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@OnePanda-TgSec/tg-gibraltar`, a durable agent harness, adopted from
  `@earendil-works/pi-durable`. See the [README](README.md) and the
  [design document](docs/spec.md).