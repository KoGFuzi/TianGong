# Changelog

## [Unreleased]

### Changed

- Rebranded from `@earendil-works/pi-ai` to `@OnePanda-TgSec/tg-ai`. The package was adopted from
  the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer changed. No
  module was added, removed, or restructured, and the public API is unchanged.
- Imports of the telemetry contracts now use `@OnePanda-TgSec/tg-telemetry`.
- The `pi-ai` binary is now published as `tg-ai`.

### Changed: identifiers

- The `pi-messages` API id is now `tg-messages`. `src/api/pi-messages.ts` is
  `src/api/tg-messages.ts`, `src/utils/pi-user-agent.ts` is `src/utils/tg-user-agent.ts`, and the
  `PiMessages*` / `PiAnthropic` exported types are now `TgMessages*` / `TgAnthropic`. `getPiUserAgent()`
  is now `getTgUserAgent()` and reports `tg (...)` as the User-Agent product token.
- `PI_*` environment variables read by this package are now `TG_*` (`TG_CACHE_RETENTION`,
  `TG_OAUTH_CALLBACK_HOST`).
- The credential file moved from `~/.pi/agent/auth.json` to
  `~/.local/share/TianGong/auth.json`, resolved through `XDG_CONFIG_HOME` and `$TIANGONG_DATA_DIR`.
  It sits under the data root rather than the config root, matching how `opencode` places its own
  `auth.json`.

### Added

- README documenting entry points, the model registry, streaming, provider registration,
  authentication, model-data generation, and the shared utilities.
- `src/config-paths.ts` and the `./config-paths` export subpath: one XDG root resolver for the whole
  product, plus `tiangongSessionDbPath()` for the default session database.
- `src/auth/api-key.ts`: `ApiKeyAuthenticator`, `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`,
  and `bearerToken()` for bearer-key authentication on a session service.
- `bearerToken()` matches the `Bearer` scheme name case-insensitively, as RFC 7235 requires.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the unified model API, adopted from `@earendil-works/pi-ai` 1.0.1.