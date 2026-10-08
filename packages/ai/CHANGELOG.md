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

- `test/usage-accounting.test.ts` pins the token accounting every adapter owes a caller: cached and
  cache-write tokens are deducted from the reported prompt/input count in the openai-completions
  family (including the DeepSeek `prompt_cache_hit_tokens` and top-level `cached_tokens` dialects),
  the openai-responses shared adapter, and mistral-conversations; Anthropic's own non-inclusive
  `input_tokens` is carried through as-is. Also pins `calculateCost`: per-class rates, the 1h
  cache-write multiplier, and tier selection over `input + cacheRead + cacheWrite`.
- README documenting entry points, the model registry, streaming, provider registration,
  authentication, model-data generation, and the shared utilities.
- `src/config-paths.ts` and the `./config-paths` export subpath: one XDG root resolver for the whole
  product, plus `tiangongSessionDbPath()` for the default session database.
- `src/auth/api-key.ts`: `ApiKeyAuthenticator`, `generateApiKey()`, `hashApiKey()`, `verifyApiKey()`,
  and `bearerToken()` for bearer-key authentication on a session service.
- `bearerToken()` matches the `Bearer` scheme name case-insensitively, as RFC 7235 requires.
- `src/auth/credential-store-file.ts` and the `./auth/node` export subpath: `FileCredentialStore`, a
  `CredentialStore` backed by `~/.local/share/TianGong/auth.json`. It excludes `modify` across
  processes with a file lock held across the whole read-decide-write sequence, which is what makes
  the double-checked OAuth refresh in `resolveProviderAuth` actually exclude: the second caller
  re-reads the rotated credential from disk instead of refreshing a token another process already
  replaced. Writes commit through a temporary file and a rename, so an interrupted process leaves the
  previous file intact. The file is created mode `0600` inside a `0700` directory because it holds API
  keys and OAuth tokens in the clear. Entries this package does not recognize are carried through
  read-modify-write verbatim rather than dropped. It lives behind `./auth/node` so browser bundles
  never pull in `node:fs` or the file lock.
- `tiangongAuthFilePath()` and `TIANGONG_AUTH_FILE` in `src/config-paths.ts`, so the credential file
  location has one definition. The dev CLI (`tg-ai login`) now persists through `FileCredentialStore`
  instead of writing `auth.json` itself; it previously wrote the file without a lock, atomic rename,
  or a restrictive mode.
- `src/utils/concurrency-limit.ts`: `ConcurrencyLimiter`, `ConcurrencyLimitError`, and
  `DEFAULT_PROVIDER_CONCURRENCY` (16). `Models.stream`, `streamSimple`, `complete`, and `completeSimple`
  now admit at most that many in-flight requests per provider id, configured through
  `CreateModelsOptions.providerConcurrency` and set to 0 to disable. Admission fails fast with
  `ConcurrencyLimitError` rather than queueing: an agent already owns a retry budget, and blocking
  here would turn a provider 429 into latency. A slot is scoped to the provider-side stream and is
  released when that stream settles, so an upstream request that is still running keeps its slot even
  if the caller stops reading. Auth resolution happens before admission, so a slow OAuth refresh does
  not hold a request slot. Buckets are per provider id, so one saturated provider cannot starve
  another.
- `EventStream.settled()` resolves once a stream can produce no further events, through either a
  terminal event or `end()`. Unlike `result()`, it settles when the stream ends without a final value.

### Fixed

- Transient provider failures are retried by default. `maxRetries` previously defaulted to 0, so a
  caller who left it unset got exactly one attempt: the adapters pass the option straight through
  without a fallback, and the provider SDKs are invoked with `maxRetries: 0` so their own default of
  2 never applied. `retryProviderRequest` now defaults to 2, matching what
  `ProviderRequestOptions.maxRetries` documents. Set `maxRetries: 0` to keep the old behavior.
- Corrected the recorded Kimi K3 cache-write rate in `scripts/generate-models.ts` from `0` to `3`
  dollars per million tokens. Moonshot now bills context-cache writes as their own line item, at the
  uncached input rate for the default 5-minute TTL and twice that for the 1-hour TTL; the 1-hour tier
  is already priced by the 2x multiplier `calculateCost` applies to `cacheWrite1h`, so only the
  5-minute rate changed. This corrects the model catalog for `moonshotai` and `moonshotai-cn`, and the
  API-equivalent implied pricing for the `kimi-coding` subscription model `k3`.
  See https://platform.moonshot.ai/docs/pricing/chat.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the unified model API, adopted from `@earendil-works/pi-ai` 1.0.1.