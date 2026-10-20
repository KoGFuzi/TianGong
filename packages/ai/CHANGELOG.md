# Changelog

## [Unreleased]

### Breaking Changes

- The Azure provider is now named `azure`, not `azure-openai-responses`, because it serves Chat
  Completions as well as the Responses API. `getModel("azure", ...)` replaces the old provider id, and
  the provider factory is `azureProvider` (with `AZURE_MODELS`, `AZURE_IMAGE_MODELS`, and
  `AZURE_CLASSIFIER_MODELS`) from the `./providers/azure` subpath. The `azure-openai-responses` api id
  and the `AZURE_OPENAI_*` environment variables are unchanged. Credentials stored under the old
  provider id are orphaned: sign in to Azure again.

### Changed

- Rebranded from `@earendil-works/pi-ai` to `@OnePanda-TgSec/tg-ai`. The package was adopted from
  the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer changed. No
  module was added, removed, or restructured, and the public API is unchanged.
- Imports of the telemetry contracts now use `@OnePanda-TgSec/tg-telemetry`.
- The `pi-ai` binary is now published as `tg-ai`.
- `repairJson()` rebuilds the repaired text from an array of chunks instead of per-character `+=`
  concatenation. The streaming tool-argument parser can run it over the whole partial-arguments
  buffer, and character-by-character concatenation copied that buffer once per character.
- `validateToolArguments()` returns `JsonObject`, not `any`. The docstring already promised the
  validated arguments, and every caller's cast was hiding nothing.
- Streaming chat adapters re-parse a tool call's accumulating arguments at most once every 50 ms
  (`parseStreamingJsonThrottled`) instead of once per delta. Deltas still reach consumers unchanged
  and completed calls are parsed in full, so only the parsed preview lags, while the repeated scans
  over the whole buffer disappear.
- `Models.complete()`, `completeSimple()`, and `fetchDeferred()` drain the completion stream while
  awaiting its result. They never read its events, and the undrained stream retained one event
  object per streamed delta.
- `declarationsEqual()` serializes each tool declaration once instead of cloning both parameter
  schemas with a JSON round-trip before comparing them.

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
- Provider calls are traced as `tg.span.provider.request`, one span per logical request through
  `createProvider` (chat streaming, `streamSimple`, image generation, and classification). The span
  carries `provider`/`api`/`model` at start and, when the call settles, `stopReason`, `retried`, the
  token counts and total cost the response reported, and the error name on failure. `Models.holdSlot`
  records concurrency-gate admission as `tg.span.provider.acquire`, parented to the request span, so
  a refused or aborted admission is recorded without a request span. `ProviderRequestOptions.onRetry`
  is the internal hook the wrapper installs to observe adapter retries; the adapters forward it to
  `retryProviderRequest` unchanged. Without an active `telemetryContext` both paths pass through
  untouched.

- `AssistantMessage.durationMs` and `ToolResultMessage.durationMs` record how long a request or tool
  execution took, in milliseconds, measured with the monotonic `performance.now()` clock. Both are
  optional. Every provider adapter stamps its terminal assistant message — the `done` event and the
  `error`/`aborted` path alike — and the faux provider stamps all of its terminals, including the
  abort messages it builds after a signal fires mid-stream. A setup failure that happens before any
  request gets `durationMs: 0` rather than a fabricated window.

- `Model.samplingParamsByThinkingLevel` overrides sampling parameters per thinking level, resolved by
  `streamSimple()` for the request's clamped level with `Model.samplingParams` below it and
  `StreamOptions.samplingParams` above it, per key. A level with no entry keeps the model default, and
  `"off"` covers a request that ends up with thinking disabled, including every request to a
  non-reasoning model. Only the OpenAI-compatible adapters (completions, responses, Azure responses)
  apply it; a direct `stream()` call has no thinking level to resolve.

- Claude Haiku 5.5 is now marked as an adaptive thinking model, in both id spellings, so its reasoning
  effort is sent as a direct effort level instead of a thinking-token budget, matching the other
  adaptive-thinking Claude models. The generator's name list drives this; the catalog data is
  regenerated with `bun run generate:models`.

- `LoginOptions.agentName` lets an app put its own product name on the provider's consent screen. The
  Sign in with ChatGPT flow sends it as `agent_name_hint` and falls back to the package's own name,
  which is what the dev CLI now passes explicitly.

- The Azure provider serves Foundry deployments over Chat Completions as well as the Responses API: a
  model under `azure` whose `api` is `openai-completions` streams through chat completions with the
  endpoint and deployment name the provider resolves per request. `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`
  and `azureDeploymentName` apply to both APIs, and DeepSeek V4 Pro ships in the built-in catalog with
  Azure's own rates and a thinking-level map the deployment accepts.

- The `openai-decisions` classifier API calls OpenAI's Decisions API (`POST /v1/decisions`), with
  `gpt-6-luna` as a classifier model of the `openai` provider. It needs an API key, so the provider
  hides it from `getAvailableOfType("classifier")` while `openai` uses Sign in with ChatGPT. A request
  is not retried on a 504, which the gateway returns as an HTML page for inputs above roughly 600K
  tokens. Ported from upstream pi 1.1.0.

- `ClassifierContext.images` lets a classifier judge image blocks together with its state. Only models
  whose `input` includes `"image"` accept them: `classify()` returns an error result for any other
  model, and the System One and llama.cpp classifier APIs reject them before sending.
  Ported from upstream pi 1.1.0.

- `MiniMax-M3.1-Flash` is in the `minimax` and `minimax-cn` catalogs with thinking levels low through
  max sent as `output_config.effort`; thinking cannot be turned off for it. New MiniMax models from
  models.dev now appear without a manual allowlist entry, and only the older M2, M2.1, M2.5, and
  M2.5-highspeed models stay hidden. Ported from upstream pi.

### Fixed

- Whitespace-only tool output, such as a bare `\r\n` from bash, is treated as empty by the OpenAI
  Completions, OpenAI Responses, and Google adapters and uses the same placeholder as empty output.
  Some providers reject whitespace-only tool content with a 400 that then repeats on every request in
  the session. Ported from upstream pi.
- Retry classification recognizes gateway upstream failures (`upstream_error`,
  `upstream_stream_read_error`, interrupted streams, and HTTP/2 stream failures) and node-fetch
  `request to ... failed, reason:` transport errors, including Google Vertex OAuth token refreshes.
  Ported from upstream pi.
- The assistant message frame codec no longer swallows message-level fields it does not name.
  `cloneStartMessage` rebuilds the start frame from a hard-coded field list, so `durationMs` was
  dropped on the encode/reduce round trip. The field is now carried through, and a message that was
  never stamped stays without the key instead of gaining an explicit `undefined`.
- `AssistantMessageEventStream` is now reachable as a value from the package root. `./types.ts`
  re-exported the class through `export type`, and a type-only alias of the same name shadows the
  value in `index.ts`'s star exports, so `import { AssistantMessageEventStream } from
  "@OnePanda-TgSec/tg-ai"` resolved to a type-only symbol (`TS1485`/`TS1362`). `index.ts` now
  carries an explicit value re-export, which wins over the star exports.
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

- A credential `modify` that has already produced a value is now persisted even when the caller
  aborted while it was running. `FileCredentialStore` and `InMemoryCredentialStore` used to check the
  signal *after* `fn` returned and *before* the write, so a cancelled OAuth refresh discarded the
  rotation the provider had already performed server-side, and the next request failed with
  `invalid_grant` against the previous refresh token. The abort is now honored before the mutation
  starts and never after `fn` returns; the caller still observes the cancellation through
  `raceWithAbortSignal`. Ported from upstream pi 1.0.3.

- Capacity and server-busy provider errors are classified as retryable instead of ending the turn.
  `server_busy`, spaced "server busy", generic "at capacity" wording (which subsumes the previous
  "model is at capacity"), and HTTP 529 now match `RETRYABLE_PROVIDER_ERROR_PATTERN`, and the OpenAI
  Codex adapter's own transport classifier matches server-busy text too. Ported from upstream pi 1.1.0
  (#10543).

- Mistral terminations reported as `finish_reason: "error"` are retried. The adapter's
  `Provider stopped with: error` message matched no retry pattern, so a transient mid-stream stop
  ended the turn as `model_error`. The literal phrase is now retryable; the equivalent wording from
  other providers carries non-transient finish reasons (`SAFETY`, `RECITATION`, ...) and stays
  terminal. Ported from upstream pi 1.1.0 (#10487).

- The fallback context estimate now uses 3.5 characters per token instead of 4. The previous ratio
  systematically undercounted long transcripts, which let `clampMaxTokensToContext` hand out a
  `maxTokens` that overflowed the context window. Ported from upstream pi 1.1.0 (#10497).

- The Radius provider's gateway catalog replaces the static public catalog instead of being merged
  into it. Overlaying left models the gateway had withdrawn visible indefinitely; the static catalog
  is now only a fallback while no gateway catalog has been fetched.

- The model generator preserves models.dev pricing tiers for Anthropic and OpenAI models. Both
  branches hand-built `cost` and dropped the `tiers` field, so Claude Haiku 5.5's 100k-context tier
  never reached the catalog and long-context requests were billed at the short-context rate. The
  catalog data is regenerated with `bun run generate:models`. Ported from upstream pi 1.1.0.

- Bedrock requests that fail with `The pending stream has been canceled` after a stalled HTTP/2
  connection are retried again. The provider error classifier now recognizes Node's
  `ERR_HTTP2_STREAM_CANCEL` wording, which the Bedrock SDK raises once its HTTP/2 session times out.
  Ported from upstream pi 1.0.4 (#10379).

- Retry backoff no longer leaks abort listeners. The `sleep()` helpers in `utils/retry.ts` and in
  the Codex stream attached an `abort` listener to the caller's signal and removed it only on
  abort, so one shared signal accumulated a listener per retry in the loop. The timer path now
  removes the listener; `test/retry.test.ts` fails on the old code.
- `closeOpenAICodexWebSocketSessions()` now also drops the per-session WebSocket debug stats and
  the SSE-fallback flags. Only the socket cache was dropped before, and the two maps grew with
  every session id the process ever served.

### Removed

- The `legacy-api-aliases.ts` module: the sixteen `@deprecated` `stream*`/`streamSimple*` provider
  aliases had no importer anywhere; use the `api/*.lazy.ts` factories or the
  `@OnePanda-TgSec/tg-ai/api/*` subpaths.
- `./api/llama-cpp-classify.lazy.ts`, an orphan wrapper: no registry entry and no test imported
  it. The classifier implementation and its tests remain.
- Unused exports `getApiProviders`, `validateToolCall`, `getOverflowPatterns`,
  `mapStopReasonString`, `getImageProviders`, and `getImageModels`.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the unified model API, adopted from `@earendil-works/pi-ai` 1.0.1.