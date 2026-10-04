# Changelog

## [Unreleased]

### Changed

- Rebranded from `@earendil-works/pi-telemetry` to `@OnePanda-TgSec/tg-telemetry`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- The `description` field no longer references the upstream project; it describes TianGong.

### Added

- README documenting the span contracts, typed schemas, adapter obligations, the conformance suite,
  and the in-memory recorder.
- `vitest.config.ts`, resolving sibling packages through the shared `vitest.base.ts` aliases.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the telemetry contracts, adopted from
  `@earendil-works/pi-telemetry` 1.0.1.