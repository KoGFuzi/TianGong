# Changelog

## [Unreleased]

### Changed

- Rebranded from `@earendil-works/pi-agent-core` to `@OnePanda-TgSec/tg-agent-core`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- Imports of the model layer now use `@OnePanda-TgSec/tg-ai`.
- `examples/mcp-codemode` still imports `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode`
  by their upstream names. Those two packages were migrated verbatim from pi agent and are frozen.

### Added

- README documenting the agent loop, event stream, tool contract, hooks, steering and follow-up
  queues, and the low-level loop exports.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the agent core, adopted from `@earendil-works/pi-agent-core` 1.0.1.