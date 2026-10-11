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
- README documenting the agent loop, event stream, tool contract, hooks, steering and follow-up
  queues, and the low-level loop exports.
- Turn and tool-call spans. Each turn is recorded as `tg.span.agent.turn` (`provider` and `model` at
  start; `stopReason` and `toolCallCount` when it ends) and each tool call as `tg.span.agent.tool`
  (`toolName` at start; `isError` when it settles). Both nest under the turn span, and the turn span
  is handed to the provider request as its parent context, so a turn with a model call and tool calls
  appears as one tree. Sequential and parallel tool execution, truncated-message failures, and
  `runToolCall` from a nested tool are all covered; `RunToolCallOptions` gains an optional
  `telemetryContext` so a nested caller can parent its span. Without a configured context the spans
  are no-ops and the event sequence is unchanged. New module `src/telemetry.ts`; new dependency on
  `@OnePanda-TgSec/tg-telemetry`.
- Tool executions report their elapsed time. `AgentToolCallOutcome`, `tool_execution_end`, and the
  persisted `ToolResultMessage` gain an optional `durationMs`, measured with the monotonic
  `performance.now()` clock over the full window from `tool_execution_start` to
  `tool_execution_end`: preparation, permission checks, `execute`, and `afterToolCall` are all inside
  it, and a parallel call that waits on a sibling's batch reports that wait too. The window is
  stamped by the agent loop, not by the tool. `AgentToolResult` also gains an optional `durationMs`,
  which a tool may use to report its own measurement, like `usage`.

### Changed

- Rebranded from `@earendil-works/pi-agent-core` to `@OnePanda-TgSec/tg-agent-core`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- Imports of the model layer now use `@OnePanda-TgSec/tg-ai`.
- `examples/mcp-codemode` still imports `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode`
  by their upstream names. Those two packages were migrated verbatim from pi agent and are frozen.
- `streamProxy` now returns the public `AssistantMessageEventStream` from `@OnePanda-TgSec/tg-ai`
  instead of a private byte-identical subclass. The returned value is unchanged at runtime; only the
  declared type widens to the type `README.md` already documented.

## [2.0.1] - 2026-10-03

### Added

- Initial TianGong release of the agent core, adopted from `@earendil-works/pi-agent-core` 1.0.1.