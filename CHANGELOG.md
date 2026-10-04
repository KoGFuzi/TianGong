# Changelog

Workspace-level history. Package-level history lives in `packages/*/CHANGELOG.md`.

## [Unreleased]

### Added

- Root framework for the all-in-Bun workspace: Bun workspace `package.json`,
  `tsconfig.base.json`, root `tsconfig.json` path map, shared `vitest.base.ts`, `bunfig.toml`,
  `biome.json`, `.editorconfig`, `.gitattributes`, `.gitignore`, and `LICENSE`.
- Bun orchestration scripts: `scripts/build.ts`, `scripts/test.ts`, `scripts/clean.ts`,
  `scripts/version.ts`, `scripts/install-hooks.ts`.
- House-standard enforcement: `scripts/check-house-standard.ts` and
  `scripts/check-relative-imports.ts`. The former now also rejects any `pi`-prefixed identifier in
  house code outside a fixed, documented allow-list.
- `AGENTS.md` declaring the house standard, and `docs/provenance.md` declaring package origins,
  including the verbatim migration of `codemode` and `mcp` from the pi agent project.
- `.githooks/pre-commit` and `test.sh`.

### Changed

- Adopted packages moved under the `@OnePanda-TgSec` scope on one shared `2.0.1` version line:
  `pi-ai` → `tg-ai`, `chord` → `@OnePanda-TgSec/chord`, `pi-durable` → `tg-gibraltar`,
  `pi-tui` → `tg-tui`, `pi-telemetry` → `tg-telemetry`, `pi-agent-core` → `tg-agent-core`.
- Every intra-workspace import specifier, `tsconfig` path, and Vitest alias rewritten to the new
  names. Module layout and public APIs are unchanged.
- The `tg` prefix carried past package names through every identifier a house package owns:
  persisted kinds `pi.*` → `tg.*`, types `PiMessages*` / `PiAnthropic` → `TgMessages*` /
  `TgAnthropic`, the `pi-messages` API id → `tg-messages`, environment variables `PI_*` → `TG_*`,
  the `getPiUserAgent()` helper → `getTgUserAgent()`, and the `pi (...)` User-Agent product token →
  `tg (...)`.
- Config directory resolved against five XDG roots instead of one, following the layout `opencode`
  uses. `tg-ai` exposes `tiangongDir()`, `tiangongConfigPath()`, `tiangongDataPath()`,
  `tiangongSessionDbPath()`, and friends; `tg-ai login` writes credentials under the data root.
- `@OnePanda-TgSec/tg-gibraltar` converged on SQLite as its only production storage backend, and the
  append-only JSONL backend was removed along with its `/storage/jsonl` export subpaths.
- `packages/gibraltar` `repository.directory` corrected from `packages/durable` to
  `packages/gibraltar`.
- `packages/chord/test/boundary.test.ts` now rejects `@OnePanda-TgSec/*` and `@earendil-works/*`
  dependencies instead of only `@earendil-works/pi-*`.

### Added

- `openDefaultSqliteStorage()`, opening `~/.local/share/TianGong/session.sqlite` with no argument.
- `project` isolation on SQLite storage: every row carries `project_id` and every read is filtered by
  it, so one database file can hold several projects. A schema version 2 migration assigns rows
  written before isolation to the default project and rebuilds the secondary indexes with a project
  prefix.
- `storage.health()`, reporting `integrity_check`, the recorded schema version, and the connection
  settings read back from the connection, and `storage.checkpoint()` for an explicit
  `wal_checkpoint(TRUNCATE)`.
- `ApiKeyAuthenticator`, `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`, and `bearerToken()` for
  bearer-key authentication on a session service.
- `PRAGMA foreign_keys = ON` and a startup `PRAGMA wal_checkpoint(PASSIVE)`, matching what `opencode`
  runs on its own database.

### Fixed

- Design-document links in the README now point at the in-repo `docs/` files instead of upstream
  GitHub URLs.

### Unchanged

- `packages/codemode` and `packages/mcp`, vendored verbatim from the pi agent project, and
  `packages/tui/native/`, the C/Objective-C addon, whose `PI_NAPI_*` and `PI_CLIPBOARD_*` macros are
  preprocessor-internal and matched by `packages/tui/test/fixtures/*.c`.

### Unchanged

- `packages/codemode` and `packages/mcp`, vendored verbatim from the pi agent project, and
  `packages/tui/native/`, the C/Objective-C addon, whose `PI_NAPI_*` and `PI_CLIPBOARD_*` macros are
  preprocessor-internal and matched by `packages/tui/test/fixtures/*.c`.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong workspace, adopted from the pi agent project. See `docs/provenance.md`.