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
  engine (kinds, precedence, persistence) is batch 1c.
- Attestation probes 2 and 6: `probeScopeOutsideNotAllows` asserts a scope-outside sample never
  resolves to allow (it must be a forced ask), and `probeUnaffiliatedCallEntersChain` feeds a
  placement-free sample straight to `decisionFor` and asserts a real decision plus exactly one
  `tg.span.sec.guard` span — the wiring-review P1-5 bypass shape. Both run in `guard.attest`'s
  default sequence.

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

### Removed

- `toBeforeToolBlocks`: it existed only to feed the old probe 7 the host-reported block mapping.
  The rebuilt probe asserts against the real `beforeTool` result.

### Fixed

- Hard deny no longer misses nested-quote payloads (`sh -c "rm -rf /"` and
  `bash -c "dd if=/dev/zero of=/dev/sda"` were both previously accepted): the serialized match
  surface put a JSON backslash before the `rm` prefix anchor and cut the `of=` field at escaped quotes.
- Self-destruction rules no longer fire on bare words anywhere in the arguments:
  `grep shutdown /var/log/messages`, a URL ending in `/shutdown`, and `cat mkfs.ext4.8.gz` are
  no longer hard-denied, while `shutdown -h now`, `sudo reboot`, and `proxychains4 mkfs.ext4` still are.

### Fixed

- Grants were wrongly consulted as a global pre-layer in `evaluate()`, so a resource recorded as
  `always` let later calls through in `strict` and bypassed the judge in `judge-auto` — a standing
  exemption against the mode that is defined to review every call. The grants lookup now lives
  inside the `auto`/`yolo` branch only: `strict` always asks and `judge-auto` always reaches the
  judge, matching the design document's evaluation order.
- `hitsDdDevice` no longer false-kills the benchmark sinks: batch 1a matched the bare `of=/dev/`
  prefix, so `dd if=/dev/zero of=/dev/null` was hard-denied. `of=/dev/null` (discards) and
  `of=/dev/zero` (writing zeros into a zero source overwrites nothing) are excluded; every other
  device target, `of=/dev/sda` included, still hits.
