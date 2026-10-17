# Changelog

## [Unreleased]

### Breaking Changes

- Adopted the upstream pi 1.3.0 chord wholesale: the facet/service runtime
  (defineService, createFacetHost, the bundler and bundle loaders) is replaced
  by the typed host runtime (contracts, createHost/defineFacet/defineRegistry,
  memory/IPC/WebSocket links, hot reload). The replicated-state surface kept by
  house consumers is unchanged: the root export still carries replicatedState,
  copyJson, isJsonValue, Context, JsonValue, JsonRepresentation, and Draft, and
  ./context and ./delta are unchanged.
- The ./bundler export is gone; ./node now exports the child host manager and
  the facet module loader. New ./output export (OutputBuffer, Progress,
  boundOutput, sanitizeOutput, characterEnd, utf8ByteLength).
- Depends on typebox instead of esbuild.

## [Unreleased]

### Changed

- Rebranded from `@earendil-works/chord` to `@OnePanda-TgSec/chord`. The package was adopted from
  the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer changed. No
  module was added, removed, or restructured, and the public API is unchanged.
- The name keeps no `tg-` prefix. The prefix marks packages owned end to end; `chord` was adopted
  whole. Recorded in `AGENTS.md` so the exception is not treated as an oversight.
- `test/boundary.test.ts` now rejects `@OnePanda-TgSec/*` and `@earendil-works/*` dependencies,
  not only `@earendil-works/pi-*`. The intent is the same: Chord stays standalone.

### Added

- README documenting services, replicated state, facets, remote services, contexts, and the delta
  engine.
- `vitest.config.ts`, resolving sibling packages through the shared `vitest.base.ts` aliases.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of Chord, adopted from `@earendil-works/chord` 1.0.1.