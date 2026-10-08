# Changelog

## [Unreleased]

### Added

- Declarative permission policy evaluated before every tool dispatch. `AgentOptions` and
  `AgentLoopConfig` gain `permissionRules` (first match wins, `"*"` wildcards, resource derived as
  `tool:<toolName>`) and `onPermissionAsk` (async human-approval channel consulted on `effect: "ask"`
  hits). The default is fail-open: no matching rule means allow, matching the pre-permission
  behavior. Deny and declined approvals reuse the exact blocked-result path as a `{ block: true }`
  `beforeToolCall` return, so the model sees identical refusal semantics. The one fail-closed point
  is an `ask` hit with no `onPermissionAsk` handler configured, which is blocked rather than
  silently allowed. A user `beforeToolCall` that blocks still wins over any rule; any non-blocking
  hook return abstains and defers to the policy. `onPermissionAsk` may reply `"always"` to record a
  session-scoped grant in `permissionGrants` (keyed `execute:<resource>`; human approval outranks
  declared rules, grants never widen to a wildcard's full span). `Agent` owns one grants set for its
  lifetime, and nested tool calls via `runToolCall` inherit rules, ask channel, and grants when the
  caller forwards them (`examples/mcp-codemode` does). New module `src/permission.ts` exports
  `PermissionRule`, `PermissionRequest`, `PermissionAskReply`, `evaluatePermission`,
  `permissionGrantKey`, and `toolResource`. Design rationale: `docs/permission-model.md`.

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