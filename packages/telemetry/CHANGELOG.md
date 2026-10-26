# Changelog

## [Unreleased]

### Added

- Metrics: `TelemetryContext.metrics` exposes `counter`/`upDownCounter`/`histogram`;
  `createTypedMetrics()` binds instrument names and exact measurement attributes to one or more
  schemas, and `NOOP_TELEMETRY_METRICS` is the inert implementation. `InMemoryTelemetryContext`
  records measurements (`getMetrics()`) next to spans; recorded spans and measurements share a
  `context` carrier, so a histogram can be tied back to the span that produced it.
  `TelemetrySchemaDefinition` accepts an optional `metrics` block.
- `tg.span.ai.request` and `tg.span.ai.poll`: one logical model request (or deferred-response poll)
  observed inside a tg-ai adapter, registered here so house consumers can validate the same spans
  the ai package emits through its own `AI_TELEMETRY_SCHEMA` (pi-ai 1.4.0 parity; metric names stay
  in the ai-local schema).

### Changed

- Rebranded from `@earendil-works/pi-telemetry` to `@OnePanda-TgSec/tg-telemetry`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- The `description` field no longer references the upstream project; it describes TianGong.
- `tg.span.sec.guard`'s `layer` values gained `self-protection`: a weak-evidence loopback or
  local-interface hit is an ask raised on its own layer, not a hard-deny result, so the value is
  required to keep the attribute recording the layer that actually produced the decision. Synced
  with `TgSecMatchedLayer` in `@OnePanda-TgSec/tg-sec-guard`, which is the only consumer. The
  `rule` description now says the attribute is present when the layer is `hard-deny` **or**
  `self-protection`.
- The `tg.span.sec.guard` `rule` description widened again with batch 2a: the attribute is present
  for the `hard-deny` and `self-protection` layers, and when the `danger` evaluator names its rule
  on a danger-layer hit (`TgSecDangerRuleId` in `@OnePanda-TgSec/tg-sec-guard`).
- `tg.span.sec.guard`'s `layer` values gained `rules` (batch 2b), placed after `hard-deny` to
  mirror the chain: the intercept rules table's deny (forced ask) and ask run ahead of
  self-protection, and a rules-table allow taken inside mode dispatch attributes to this layer as
  well. Operator rule ids are free text and stay out of the `rule` vocabulary; the attribution
  names the winning rule in the ask reason, which never enters the span. Synced with
  `TgSecMatchedLayer` in `@OnePanda-TgSec/tg-sec-guard`, the only producer of these values.

### Added

- README documenting the span contracts, typed schemas, adapter obligations, the conformance suite,
  and the in-memory recorder.
- `vitest.config.ts`, resolving sibling packages through the shared `vitest.base.ts` aliases.
- `src/spans.ts` and the `TG_SPAN_SCHEMA` export: the first span vocabulary, covering
  `tg.span.provider.acquire`, `tg.span.provider.request`, `tg.span.agent.turn`, and
  `tg.span.agent.tool`, declared as typed schema data. Every attribute is a count or a closed
  enumeration; no span carries prompt text, tool arguments, or paths.
- `tg.span.sec.guard` and `tg.span.sec.mode` in `TG_SPAN_SCHEMA`, the audit vocabulary for
  `@OnePanda-TgSec/tg-sec-guard`: one span per guard decision (allow included) carrying mode,
  matching layer, effect, forced flag, and a truncated argument digest, and one span per permission
  mode switch carrying `from`, `to`, and `actor`. No span carries command text or argument values.
- `self-destruction.rm-home` in the `tg.span.sec.guard` `rule` values: the new hard-deny rule for
  `rm -rf ~` / `rm -rf $HOME`, kept in sync with `TgSecHardDenyRuleId` in `@OnePanda-TgSec/tg-sec-guard`.
- The 32 `danger.*` ids in the `tg.span.sec.guard` `rule` values, covering the batch 2a
  dangerous-instruction set in `@OnePanda-TgSec/tg-sec-guard` (`danger.sql.*`, `danger.tool.*`,
  `danger.web.*`, `danger.redis.*`, `danger.mongo.*`, `danger.persist.*`, `danger.rm.system-path`,
  `danger.business.*`, `danger.wordlist.huge`, `danger.bruteforce.*`). Kept in lockstep with
  `TgSecDangerRuleId`, the only producer of these values; the attribute stays a closed
  low-cardinality enumeration — no command text ever enters the span.
- `tg.span.sec.fork` and `tg.span.sec.evidence` in `TG_SPAN_SCHEMA`, the batch-4 audit vocabulary for
  `@OnePanda-TgSec/tg-sec-agent`: one span per delegated fork carrying `lane`, `outcome` and `depth`
  (never the intent text), and one span per evidence-store operation carrying `op`, a truncated
  one-way `subjectDigest`, `outcome`, `changed` and `count` (never a subject string, a content hash,
  or a snapshot id). Both are declared as typed schema data, consistent with the existing rule that no
  span carries prompt text, tool arguments, or paths.

### Removed

- The `TelemetryAttributeType` and `TelemetrySchemaSpanUnion` aliases: declared and never used.
  The attribute type unions are inlined in `TelemetryAttributeDefinition`, which is what
  adapters actually consume.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the telemetry contracts, adopted from
  `@earendil-works/pi-telemetry` 1.0.1.