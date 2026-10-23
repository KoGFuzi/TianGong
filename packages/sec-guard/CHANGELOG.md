# Changelog

All notable changes to this package will be documented in this file.

## [Unreleased]

### Breaking Changes

- `extractConnectionTargets(request)` returns `readonly TgSecConnectionTarget[]`
  (`{ host, evidence }`), not `readonly string[]`. Batch 1c splits the candidates into two
  evidence tiers and the tier has to travel with the host: self-protection denies on strong
  evidence only, and the scope reason names the tier it compared. `TgSecCommandSurface` gained
  `targetStreams` (the filtered candidate face) alongside `values`/`streams` (the unfiltered
  self-destruction face), and `src/index.ts` exports `TgSecConnectionTarget`,
  `TgSecTargetEvidence`, and `TgSecTargetStream`.
- `TgSecMatchedLayer` gained `"self-protection"`. Weak loopback/interface evidence is an ask on
  its own layer, so it must not be attributed to `hard-deny`; the telemetry `layer` vocabulary and
  `rule` description were synced in the same change.
- Batch 1d narrowed the package entry: `src/index.ts` no longer exports `extractCommandSurface`,
  `tokenize`, `TG_SEC_SUBCOMMAND_DEPTH_LIMIT`, `TgSecCommandSurface`, `TgSecTargetStream`, or
  `TgSecToken`. The only public extraction surface is `extractConnectionTargets`, because a
  consumer holding the surface primitives can skip the parameter-name filter and rebuild a second
  text-matching face; `test/boundary.test.ts` asserts the narrowing on the runtime export keys.
  `test/command-text.test.ts` imports the primitives from their home module instead.
- `createTgSecScopeResolver` now requires the richer `TgSecScopeRegistry` from
  `src/scope-registry.ts`: it reads `outcome(host)`, not just `contains(host)`, so a hand-rolled
  resolver-input object that implements only `contains` no longer type-checks.
- `TgSecAttestContext` gained the required field `dangerSample: ToolHookCall`: probe 3 needs a
  call that is in scope and matches the danger set, and the attestation cannot assert
  grant-and-mode immunity without the host naming that sample.
- `TgSecDangerEvaluator` returns `TgSecDangerHit` (`{ hit, rule?, reason? }`), not
  `{ hit, reason? }`: batch 2a landed the real evaluator and a danger-layer hit must name its
  closed rule id so the guard span's `rule` attribute covers the `danger` layer too.
  `TgSecEvaluation.ruleId` widened to `TgSecHardDenyRuleId | TgSecDangerRuleId` accordingly.
- `TgSecMatchedLayer` gained `"rules"`: the intercept rules table attributes its deny forced ask,
  its ask, and the allow taken inside mode dispatch. The telemetry `layer` vocabulary was synced in
  the same change; operator rule ids deliberately stay out of the closed `rule` vocabulary, so a
  rules-layer attribution names its winner in the free-text reason, never on the span.
- `TgSecAttestContext` gained the required field `rulesSample: ToolHookCall`: probes 8-11 need a
  call that stays silent on every layer ahead of the rules table and mode dispatch, and the
  attestation wires its fixture rule tables and its degraded judges around that one sample.

### Added

- Package skeleton for `@OnePanda-TgSec/tg-sec-guard`: four-level permission mode machine
  (`strict`, `judge-auto`, `auto`, `yolo`) persisted in the session-scoped `tg.sec.mode` document,
  built-in non-configurable hard deny, session `always` grants keyed on the exact `tool:<name>`
  resource, the gibraltar `ToolHooks.beforeTool` adapter with fail-closed construction and
  fail-closed asks, and the attestation framework with probes 1, 4, 5, and 7.
- Guard and mode-switch audit spans (`tg.span.sec.guard`, `tg.span.sec.mode`) emitted
  through the `@OnePanda-TgSec/tg-telemetry` span vocabulary.
- Command-text extraction layer `src/command-text.ts`: recursive collection of argument string
  values (unserialized), `tokenize` with command-position marking, wrapper-prefix skipping
  (`env`/`sudo`/`nohup`/`stdbuf`/`nice`/`setsid`/`time`/`proxychains`/`proxychains4`/`sshpass`,
  `timeout <dur>`, leading `VAR=value`), and `sh -c`/`bash -c` subcommand extraction bounded at
  depth 2. Interpreter `-c`/`-e`/`-r` bodies are treated as ordinary string values, not subcommands.
- New hard-deny rule `self-destruction.rm-home`: forced recursive removal of `~`, `$HOME`, or
  `${HOME}` (the telemetry `rule` vocabulary gained the id in the same change).
- Connection-target extraction `extractConnectionTargets` in `src/command-text.ts`: host/authority
  candidates from the same token streams as the hard-deny surface — bare tokens that are URLs
  (authority only), bare IPv4 literals, the reserved `localhost`, and bare domains with a real TLD
  minus file-suffix names; data-flag values (`-d`/`-H`/`-F`/`--data*`/`--cookie*`/`-x`/`-o` and the
  rest of the design list) never contribute, `-u`/`--url`/`--host` values do, and recursive
  `sh`-family subcommands reuse the batch 1a depth limit. `-L`/`-R` are boolean: they do not consume
  the following token. `SUBCOMMAND_SHELLS` gained `zsh`, `dash`, and `ksh`.
- Scope seam `src/scope.ts`: the minimal `TgSecScopeRegistry` shape (`contains(host)`),
  `createInMemoryScopeRegistry` (exact hostnames/IPs, case-insensitive), and
  `createTgSecScopeResolver(registry)` over the shared extraction. A request with no connection
  targets is in scope deliberately, so read/write/edit are not force-asked. The registry matching
  engine (kinds, precedence, config loading) shipped in batch 1d; persistence and hot reload
  remain batch 4.
- Attestation probes 2 and 6: `probeScopeOutsideNotAllows` asserts a scope-outside sample never
  resolves to allow (it must be a forced ask), and `probeUnaffiliatedCallEntersChain` feeds a
  placement-free sample straight to `decisionFor` and asserts a real decision plus exactly one
  `tg.span.sec.guard` span — the wiring-review P1-5 bypass shape. Both run in `guard.attest`'s
  default sequence.
- Evidence-tiered target extraction in `src/command-text.ts`: a candidate is **strong** when it is
  the authority of a scheme URL, the value of `-u`/`--url`/`--host` (bare or `--url=value`), or the
  value of a host/url-named parameter, and **weak** when it is a bare IPv4, bare IPv6 (bracketed,
  compressed, with an optional `:port` and path tail), bare `localhost`, or schemeless-domain token
  in command position. `bareIpv6Host` replaces the two IPv6 regexes, which could not match a
  compressed address without a literal `::` after a greedy group.
- Parameter-name filter for the candidate face (`src/command-text.ts`): string leaves are tagged
  with the role of their nearest key — `command-text` (`command`, `cmd`, `shell`, `script`),
  `declared-target` (`url`, `host`, `hostname`, `target`, `endpoint`, `address`, `addr`, `dest`,
  `destination` and their plural/underscore variants), or `detail` (`content`, `text`, `body`,
  `file_path`, `path`, `pattern`, `query`, `note`, `message`, `description`). Only the first two
  feed `targetStreams`; an unrecognized key defaults to `command-text`.
- `evaluateWeakSelfProtection(request, hostAddresses)` in `src/hard-deny.ts`: the weak-tier half of
  the self-protection rules, returning `TgSecWeakSelfProtectionHit` (rule id, host, reason) or
  `undefined`, exported with `TgSecSelfProtectionRuleId`. `selfProtectionRule` is the single
  matcher both tiers share.
- Scope registry matching engine `src/scope-registry.ts`. Entry kinds: `exact-host` (case-insensitive;
  IPv6 hosts and patterns are normalized through their 128-bit value, so `2001:DB8::1` equals
  `2001:db8:0:0:0:0:0:1`, and IPv4-mapped `::ffff:a.b.c.d` collapses to the dotted quad on either
  side), `suffix-domain` (label-boundary matching: `example.com` covers itself and hosts beneath it
  and refuses `notexample.com`), `fuzzy-host` (substring containment for asset rollups, with its
  false-positive surface documented at the rule and asserted in tests), and self-implemented
  `cidr4`/`cidr6` (BigInt prefix compare, no new dependency; `/0` and full-length prefixes are the
  tested edges, invalid bases or prefix lengths throw at construction, pattern sides keep their
  address family while host sides map across it). Every entry is
  `{ kind, pattern, effect: "allow" | "deny", enabled }`; disabled entries skip matching. Deny
  outranks allow on a per-candidate scan, and the verdict names the matching rule.
- `parseTgSecScopeConfig(text)` (a JSON array of entries) throws on every validation failure —
  invalid JSON, non-array root, unknown kind, illegal pattern, illegal prefix, effect outside
  allow/deny, a missing or non-boolean `enabled` — and never silently drops an entry.
  `loadTgSecScopeRegistry(path)` reads the operator-side config (convention
  `.tiangong/scope.json`): a missing file yields an empty-allow registry — under
  registration-is-the-only-source-of-permission that permits nothing and forces an ask on every
  network target — and a corrupt file propagates instead of half-loading. No DB persistence, no
  hot reload (batch 4).
- `test/scope-registry.test.ts`: the engine, precedence, validation, and config suites
  (empty-allow, deny-over-allow including the gateway carve-out of a `/32` deny from a `/24`
  allow, disabled entries, IPv6 case/compression, IPv4-mapped normalization both directions).
- `test/boundary.test.ts`: the single text-matching-surface rule made mechanically checkable —
  the package entry does not export the surface primitives, the engine imports nothing from the
  extraction module and never sees a request, the resolver takes exactly `extractConnectionTargets`
  from it, and no src file outside `command-text.ts` plus its two declared readers (`types.ts`
  ingress, `guard.ts` telemetry digest) reads `.arguments`. The checker is itself run against
  deliberate bypass sources so a cannot-fail assertion is not mistaken for protection.
- The dangerous-instruction set `src/danger.ts` (batch 2a): `createTgSecDangerEvaluator({ objective })`
  builds the armed rule table for one track — `redteam`, `ctf`, or `src`; an objective outside the
  three throws at construction. Four families, 32 closed ids in `TgSecDangerRuleId`:
  target-destructive (`danger.sql.*` destructive SQL with reads excluded by construction,
  `danger.tool.sqlmap-*`, `danger.web.action-destroy`, `danger.redis.flushall|flushdb`,
  `danger.mongo.drop-database` — all tracks, CTF not exempt), persistence
  (`danger.persist.crontab|add-user|authorized-keys|schtasks|systemd-unit` — write shapes only:
  `crontab -l`, `cat /etc/crontab`, `grep authorized_keys`, `systemctl status` cannot hit),
  critical-path removal (`danger.rm.system-path`: forced recursive `rm` onto the ten system
  directories, a forced ask per the 2026-10-22 decision — hard deny keeps only `/`, `/*`, `~`,
  `$HOME`), and objective-conditional (`danger.business.*` armed on redteam/src only,
  `danger.wordlist.huge` armed on all three as a budget-and-pacing guardrail,
  `danger.bruteforce.hashcat|john-wordlist` CTF-only). Every hit names its id and a human reason;
  the evaluator consumes the finished views and no argument tree.
- The **text-scan view** `scanTextSurface(request): TgSecTextSurface` in `src/command-text.ts`:
  every string value (`detail` keys included), the token streams, and the pre-split lowercased
  command groups (`TgSecCommandGroup`). Package-internal by design — `index.ts` exports neither the
  view nor the built-in table `TG_SEC_DANGER_RULES`; the host gets a guard, not a scanner.
  `hasForcedRecursiveFlags` and `nonFlagTargets` moved into `command-text.ts` as shared command-shape
  helpers so the rm rules in hard deny and danger cannot drift on what "forced recursive" means.
- Attestation probe 3, `probeDangerSetForcesAskPastGrants(sample, createGuard)`: the probe builds a
  `yolo` guard whose grant store already holds the sample's exact resource, runs `decisionFor`, and
  asserts a forced ask **and** the guard span's `layer === "danger"` — a sample refused by the scope
  layer would produce the same decision for the wrong reason and must not pass. It runs third in
  `guard.attest`'s default sequence, and `TgSecAttestContext` gained `dangerSample`.
- `test/danger.test.ts`: the rule-by-rule suite (each id with a positive and a named near-miss
  negative), the 3-objectives × 5-families arming matrix asserted cell by cell, the construction
  throw, and the view-isolation claims — the danger evaluator sees SQL payload text under `detail`
  keys while the connection-target view produces no candidate from those same keys.
- Exports: `createTgSecDangerEvaluator`, `TG_SEC_OBJECTIVES`, `TgSecObjective`,
  `TgSecDangerRuleId`, `TgSecDangerHit`, `probeDangerSetForcesAskPastGrants`.
- The intercept rules table `src/rules.ts` (batch 2b): entries
  `{ id, priority, pattern, effect: "allow" | "deny" | "ask", enabled, note? }` matched on the
  `tool:<name>` resource through the legacy wildcard grammar (`scripts/legacy/agent-core/src/
  permission.ts`: `*` is the only wildcard, everything else regex-escaped, whole-string anchored,
  case-sensitive). Evaluation collects **all** hits and returns the winner under the absolute
  precedence deny > ask > allow; `priority` orders attribution inside one effect only (a tie keeps
  the earlier declaration) and never reorders across effects. The engine is fail-closed on itself:
  an empty or duplicate id, a pattern outside the `tool:` namespace or carrying a space, an effect
  outside the three, a non-integer priority, a non-boolean `enabled`, or a non-string `note` throw
  at table construction. `parseTgSecRules(text)` reads the JSON config shape by shape and never
  drops an entry; `loadTgSecRules(path)` reads the operator-side `.tiangong/rules.json` — a missing
  file yields an empty table, a corrupt file propagates. No DB persistence, no hot reload.
- The two-axis judge `src/judge.ts` (batch 2b): `createTgSecTwoAxisJudge({ transport, model?,
  timeoutMs?, maxInputBytes? })` returns a `TgSecJudge`. The transport
  (`complete(input: TgSecJudgeInput): Promise<string>`) is the only external shape; this batch
  wires no real provider. The judge question is written for this package along the two axes
  (reversibility; the subject the effect lands on — test artifacts versus target production
  assets), not copied from the ARTEX intercept prompt. The reply protocol is strict JSON
  `{"decision": "allow" | "ask", "comment": string}`: invalid JSON, a non-object, a missing or
  non-string comment, a decision outside the two values (a rogue `deny` included — the judge keeps
  no deny power), a transport throw, and a hang past `timeoutMs` (default 15 000 ms, the guard's
  own judge budget) all resolve to ask. Injection control: the judge consumes only the tool name,
  `extractConnectionTargets`, and `scanTextSurface` joined and truncated to `maxInputBytes`
  (default 8192 UTF-8 bytes — command-and-payload shapes put the decisive evidence in the first
  KiB, and past that the marginal injection surface outgrows the marginal evidence value), the
  payload sits inside a declared data block, and forged delimiters inside the payload are
  neutralized before embedding. The comment reaches the ask reason (human text) and never the span
  attributes.
- Attestation probes 8-11: `probeRuleDenyForcesAskPastExemptions` (a rule deny forces its ask past
  `yolo` plus a standing `always` grant, and the guard span's `layer` must be `rules`),
  `probeStrictIgnoresRuleAllow` (strict asks anyway and the ask is attributed to `mode`),
  `probeJudgeTransportErrorAsks` and `probeJudgeTimeoutAsks` (a degraded judge escalates to a human
  on the `mode` layer instead of releasing the call). All four build their own guards inside
  `guard.attest`, following probe 3's executed-not-trusted pattern; the default sequence now runs
  eleven probes.
- `test/rules.test.ts`: the wildcard grammar (anchoring, case sensitivity, literal `?` and regex
  metacharacters, `tool:*` and `tool:n*`, non-`tool:` and space-carrying patterns rejected), the
  absolute deny > ask > allow order against inverted priorities, priority attribution inside one
  effect including the declaration-order tie, disabled and empty tables, every construction throw,
  and the config loaders (valid parse, bad JSON, non-array root, bad entry, no silent drop;
  missing `rules.json` empty, corrupt propagates).
- `test/judge.test.ts`: the protocol surface (allow, ask, invalid JSON, arrays and scalars, a rogue
  `deny`, a missing comment), throw/reject/hang escalation, construction validation, the injection
  suite (the transport sees exactly `{ model, toolName, targets, boundedText, prompt }` and nothing
  else; a forged end marker neutralizes to exactly one delimiter pair while the pseudo-instruction
  survives inside the block as data; `maxInputBytes` truncation, the 8192 default on a 100 KiB
  body, and a UTF-8 code-point-boundary cut that never exceeds the budget or emits U+FFFD), and the
  two-axis framing claims.
- Exports: `createTgSecRuleTable`, `parseTgSecRules`, `loadTgSecRules`, `TgSecRule`,
  `TgSecRuleEffect`, `TgSecRuleTable`, `createTgSecTwoAxisJudge`,
  `TG_SEC_JUDGE_DEFAULT_TIMEOUT_MS`, `TG_SEC_JUDGE_DEFAULT_MAX_INPUT_BYTES`, `TgSecJudgeInput`,
  `TgSecJudgeTarget`, `TgSecJudgeTransport`, `TgSecTwoAxisJudgeOptions`, and probes 8-11.

### Changed

- Hard deny matches on extracted command texts and token streams instead of the serialized
  `JSON.stringify(request.arguments)` text. Self-destruction rules (`rm-root`, `rm-home`, `mkfs`,
  `dd-device`, `power`) now hit at command positions only — after wrapper skipping and inside
  extracted `sh -c` subcommands; `fork-bomb` matches whitespace-normalized command texts because
  its construct spans tokens. Platform self-protection rules keep target semantics and match all
  string values. `evaluateHardDeny(request, hostAddresses)` is unchanged. (Superseded for
  self-protection by the batch 1b change below: loopback and local-interface rules now read the
  connection-target extraction only.)
- Attestation probe 7 was rebuilt to execute the chain rather than vouch for host-supplied
  values: `probeForcedAskBlocks(sample, hookApi, context, createGuard)` builds its own guard
  without an ask channel, asserts `decisionFor(sample)` is a forced ask, and asserts `beforeTool`
  maps it to a block. `TgSecAttestContext` gained `hookApi` and `probeGuard`; `forcedAskSample`
  is now a `ToolHookCall`; `toTgSecRequest` moved from `guard.ts` to `types.ts` (same export).
- Hard deny's platform self-protection rules (`self-protection.loopback-*`,
  `self-protection.local-interface`) now evaluate only the hosts produced by
  `extractConnectionTargets` — the same single extraction the scope resolver reads. The rule-id
  vocabulary is unchanged. localhost in `-d`/`-H`/`-F` payloads, in URL paths and queries, and in
  other data-flag values no longer hard-denies (the 2026-10-22 narrowing: hard deny has no appeal
  channel, so SSRF and redirect test payloads must pass); direct loopback targets, `curl -L`
  through boolean flags, and interface-address targets still deny. A bare, non-data-flag token in
  any argument position remains a candidate, so `grep 127.0.0.1 access.log` is denied — asserted
  as-is in `test/command-text.test.ts` and flagged as a known overreach for the batch report.
- The two `${HOME}`/`${home}` literal match targets (in `hard-deny.ts` and its test) carry inline
  `biome-ignore lint/suspicious/noTemplateCurlyInString` suppressions with a stated reason; they
  are literals, not template placeholders. `bun run check:format` is warning-free.
- Self-protection splits on the evidence tier, superseding the batch 1b note above: strong
  evidence keeps the hard deny, and weak evidence is a forced ask emitted by the new
  `self-protection` layer between hard deny and scope in `evaluate()`. The ask is immune to
  `always` grants and to every mode exemption, and `strict` is unchanged because it already asks —
  the difference is that the ask is now recorded as forced. The previous shape hard-denied
  `grep 127.0.0.1 access.log` and force-asked a `write` body that merely mentions `localhost`.
- The scope resolver compares both tiers rather than one candidate face, and its reason names the
  tier (`… "127.0.0.1" (weak evidence) is not in the registered scope`). Registration does not
  overrule the chain: a weak self-protection ask is still an ask for a registered host.
- Self-destruction is deliberately outside the filter and the tiering: `evaluateHardDeny` matches
  `rm -rf /` and friends against the unfiltered `values`/`streams` face, so the string in
  `{ "content": "rm -rf /" }` still denies. The accepted cost is an asymmetry — a loopback mention
  in a detail body is silent while a removal-of-root mention there denies — taken because a missed
  target costs self-protection while a missed self-destruction check costs the disk.
- `createTgSecScopeResolver(registry)` reads `registry.outcome(host)` per candidate, so the ask
  reason now distinguishes a refusal by a named deny entry
  (`… is refused by the scope deny entry "192.168.0.1/32" (cidr4)`) from a host no allow entry
  covers (`… is not in the registered scope: no allow entry covers it`). Everything else about the
  resolver is unchanged from batch 1c: both tiers are compared, the tier rides in the reason, and a
  request with no connection targets is in scope.
- Probe 2's suite is driven by the real registry engine instead of an injected fake resolver: a
  CIDR-inside target is allowed through the whole chain, a CIDR-outside target forces the ask the
  probe expects, a deny hit inside an allowed CIDR is refused naming the deny entry (deny-over-allow
  proven at the probe layer), and a `/0` allow — under which nothing is outside scope — now fails
  the probe. The probe's own not-allow and not-forced negatives are unchanged.
- The scope suites build registries with `createTgSecScopeRegistry`; the local `allowHosts` helper in
  `test/scope.test.ts` is test-side on purpose, so no src shorthand for registration exists to drift.
- `src/command-text.ts` is now the only module that traverses the argument tree, and it hands out two
  finished views instead of the raw carrier: the connection-target view (`extractConnectionTargets`,
  semantics unchanged) and the text-scan view (`scanTextSurface`). `src/hard-deny.ts` was migrated to
  consume the two views — an equivalent migration, its public signatures, rule ids, and every
  existing assertion are unchanged; the shared `toCommands`/`hasForcedRecursiveFlags` logic simply
  moved to the view producer. `src/danger.ts` consumes only the text-scan view: a danger rule never
  matches a host, so the connection-target view stays out of this layer's reach and the two views
  cannot be quietly merged back into one.
- `test/boundary.test.ts` tightened accordingly (never loosened): the tree-walking whitelist is
  `command-text.ts` alone, the `types.ts` ingress and `guard.ts` digest reads are pinned to their
  exact declared lines, `scanTextSurface` and `TG_SEC_DANGER_RULES` joined the forbidden index
  exports, and each matcher module gained a per-file import constraint — `hard-deny.ts` may import
  only the two views and command-shape helpers, `danger.ts` only `scanTextSurface` and its shape
  helpers, and neither may reach `extractCommandSurface`, `connectionTargetsFromSurface`, or
  `tokenize`.
- The danger layer in `evaluate()` now carries the hit's closed rule id into `TgSecEvaluation.ruleId`
  and the guard span's `rule` attribute (evaluation order unchanged; an injected evaluator that
  omits the rule records no id, which the span tolerates as an optional attribute). The telemetry
  `tg.span.sec.guard` `rule` values gained the 32 `danger.*` ids in the same change, keeping the
  vocabulary closed.
- The attestation e2e fixtures drive the real evaluator: `attestContext()` passes
  `createTgSecDangerEvaluator({ objective: "redteam" })` and a `sqlmap --os-shell` danger sample,
  so the default seven-probe sequence exercises the built set end to end rather than trusting a
  no-hit fake for probe 3's wiring.
- The rules table joins `evaluate()` between hard deny and weak self-protection, and the chain is
  now: hard deny → rule deny (forced ask) → rule ask → weak self-protection → scope → danger → mode
  dispatch. The two 2026-10-23 semantics are structural, not advisory: a rule `deny` produces an
  appealable forced ask and the built-in hard deny remains the only terminal deny
  (`TgSecDecision`'s deny keeps its `hard: true`-only shape); a rule `allow` is consulted only
  inside mode dispatch — `strict` never consults it, `judge-auto` skips the judge when it matches,
  `auto`/`yolo` take it ahead of the grant check, and an allow and a standing grant on the same
  call attribute to `rules` because an operator-written rule is the standing statement of intent.
  `TgSecGuardOptions.rules` is optional: an absent or empty table leaves the chain exactly as the
  batch 2a behaviour, asserted test by test. A rule `ask` is non-forced — an `always` reply is
  accepted and banked — but the layer precedes the grant check, so the ask rule re-fires each call
  by construction.
- `test/boundary.test.ts` tightened again (never loosened): `judge.ts` is pinned to importing
  exactly `extractConnectionTargets` and `scanTextSurface` with no raw primitive named anywhere in
  the file and no `.arguments` read; `rules.ts` is pinned to importing nothing from the extraction
  module, never naming `TgSecRequest`, and reading no arguments; the package entry must export the
  rule-table and judge seams (their absence is now a failure, alongside the forbidden-export pins).
- The guard's own doc for the judge seam in `types.ts` no longer defers to a hypothetical batch 2
  interface: `TgSecJudge` is the type `createTgSecTwoAxisJudge` implements, with the off-protocol
  and no-deny-power stances stated where the guard enforces them.

### Removed

- `toBeforeToolBlocks`: it existed only to feed the old probe 7 the host-reported block mapping.
  The rebuilt probe asserts against the real `beforeTool` result.
- `createInMemoryScopeRegistry`, superseded by `createTgSecScopeRegistry` with `exact-host` rules.
  It could not express a deny effect, a CIDR, or any of the normalization batch 1d requires, and its
  boolean `contains` could not tell a human which rule refused a host. No compatibility shim: the
  seam's own tests cover `contains` on the new engine, and its doc comment states it answers only
  the permitted question.

### Fixed

- Hard deny no longer misses nested-quote payloads (`sh -c "rm -rf /"` and
  `bash -c "dd if=/dev/zero of=/dev/sda"` were both previously accepted): the serialized match
  surface put a JSON backslash before the `rm` prefix anchor and cut the `of=` field at escaped quotes.
- Self-destruction rules no longer fire on bare words anywhere in the arguments:
  `grep shutdown /var/log/messages`, a URL ending in `/shutdown`, and `cat mkfs.ext4.8.gz` are
  no longer hard-denied, while `shutdown -h now`, `sudo reboot`, and `proxychains4 mkfs.ext4` still are.
- Grants were wrongly consulted as a global pre-layer in `evaluate()`, so a resource recorded as
  `always` let later calls through in `strict` and bypassed the judge in `judge-auto` — a standing
  exemption against the mode that is defined to review every call. The grants lookup now lives
  inside the `auto`/`yolo` branch only: `strict` always asks and `judge-auto` always reaches the
  judge, matching the design document's evaluation order.
- `hitsDdDevice` no longer false-kills the benchmark sinks: batch 1a matched the bare `of=/dev/`
  prefix, so `dd if=/dev/zero of=/dev/null` was hard-denied. `of=/dev/null` (discards) and
  `of=/dev/zero` (writing zeros into a zero source overwrites nothing) are excluded; every other
  device target, `of=/dev/sda` included, still hits.
- `grep 127.0.0.1 access.log` is no longer hard-denied, and a `write`/`read` call whose `content`,
  `body`, or `path` mentions `localhost` or `127.0.0.1` produces no candidate at all: it neither
  denies nor asks. Both were reported as the batch 1c false positives, were written as failing
  tests first, and are covered in `test/hard-deny.test.ts` and `test/command-text.test.ts`.
- Subcommand extraction no longer demands the literal next token `-c`: `bash -lc 'rm -rf /'`,
  `sh -ic 'rm -rf /'`, `bash -l -c 'rm -rf /'`, and `bash --norc -c 'rm -rf /'` used to run a
  body that neither hard deny nor the danger set ever saw. The parser now walks the shell's flag
  run, arms the body on any short-flag cluster carrying `c`, steps over `--flag value` pairs whole,
  and takes the first non-flag token after the run; `bash script.sh` still extracts nothing. The
  same blindness inside `bash -lc` also hid targets from the scope resolver and the danger set's
  critical-path removal rule.
- Word splitting ends a token at `)`, so `echo $(rm -rf /)` now yields the target `/` instead of
  `/)` and reaches `self-destruction.rm-root`; a bare subshell `(rm -rf /)` and a mid-word
  substitution `echo$(rm -rf /)` now open a command position like `$(`. Both shapes bypassed hard
  deny before. Prose is unaffected: a numbered list (`steps:\n1) rm -rf /etc`) and a quoted
  `printf '1) rm -rf /etc'` still produce no command position, asserted in `test/danger.test.ts`.
- `README.md` no longer claims `yolo` “allows everything the hard deny does not refuse” and no
  longer lists grants as a global layer ahead of mode dispatch: both contradicted the design's
  evaluation order and the chain, where forced asks precede dispatch and grants live inside the
  `auto`/`yolo` branch. The stale batch-0.5a attestation paragraph (four probes, three reserved)
  now lists the eleven probes that actually run.
