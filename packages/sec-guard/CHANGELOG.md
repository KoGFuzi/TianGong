# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

### Added

- Package skeleton for `@OnePanda-TgSec/tg-sec-guard`: four-level permission mode machine
  (`strict`, `judge-auto`, `auto`, `yolo`) persisted in the session-scoped `tg.sec.mode` document,
  built-in non-configurable hard deny, session `always` grants keyed on the exact `tool:<name>`
  resource, the gibraltar `ToolHooks.beforeTool` adapter with fail-closed construction and
  fail-closed asks, and the attestation framework with probes 1, 4, 5, and 7.
- Guard and mode-switch audit spans (`tg.span.sec.guard`, `tg.span.sec.mode`) emitted
  through the `@OnePanda-TgSec/tg-telemetry` span vocabulary.

### Fixed

- Grants were wrongly consulted as a global pre-layer in `evaluate()`, so a resource recorded as
  `always` let later calls through in `strict` and bypassed the judge in `judge-auto` — a standing
  exemption against the mode that is defined to review every call. The grants lookup now lives
  inside the `auto`/`yolo` branch only: `strict` always asks and `judge-auto` always reaches the
  judge, matching the design document's evaluation order.
