# @OnePanda-TgSec/tg-agent-core

The agent loop: model turns, tool execution, steering, and the event stream a UI binds to.

`@OnePanda-TgSec/tg-ai` talks to models. This package decides what to send, what to run, and when
to stop. It has no storage and no UI: it is the part between a transcript and a provider.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [The Agent](#the-agent)
- [Events](#events)
- [Tools](#tools)
- [Steering and Follow-ups](#steering-and-follow-ups)
- [Hooks](#hooks)
- [Thinking Levels](#thinking-levels)
- [Custom Messages](#custom-messages)
- [Low-level Loop](#low-level-loop)
- [MCP and Code Mode](#mcp-and-code-mode)
- [Development](#development)
- [Provenance](#provenance)
- [License](#license)

## Installation

```bash
bun add @OnePanda-TgSec/tg-agent-core @OnePanda-TgSec/tg-ai
```

## Quick Start

```typescript
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import { openaiProvider } from "@OnePanda-TgSec/tg-ai/providers/openai";
import { Agent } from "@OnePanda-TgSec/tg-agent-core";

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

const agent = new Agent({
	model: models.getModel("openai", "gpt-5.2"),
	convertToLlm: (messages) => messages,
});

agent.subscribe((event) => {
	if (event.type === "message_update") process.stdout.write(event.assistantMessageEvent);
	if (event.type === "turn_end") console.log("\n", event.message.content);
});

await agent.prompt("What is the capital of France?");
```

`prompt()` runs until the agent has nothing left to do: every tool call resolved, no steering
message pending, no follow-up queued. `continue()` resumes from the current context without adding a
user message.

## The Agent

`Agent` is the stateful wrapper. Its public state is small on purpose:

| Member | Meaning |
| --- | --- |
| `agent.state` | `systemPrompt` (read-only), `model`, `thinkingLevel`, `tools`, `messages`, `isStreaming`, `streamingMessage`, `pendingToolCalls`, `errorMessage`. |
| `agent.prompt(input, images?)` | Queue user input and run until the agent settles. |
| `agent.continue()` | Run again from the current context. |
| `agent.abort()` | Abort the active run. `agent.signal` exposes its `AbortSignal`. |
| `agent.subscribe(listener)` | Receive events. Returns an unsubscribe function. |

Assigning `state.tools` or `state.messages` copies the array, so a caller holding the old reference
cannot mutate live agent state by accident. Changing `state.tools` announces the difference to the
model with a system message before the next request.

The system prompt is read-only. To change it, append a system message; the transcript's system
messages are the single source of truth, replayed into `state.systemPrompt`.

## Events

`subscribe()` receives an ordered `AgentEvent` stream:

```text
agent_start
  turn_start
    message_start → message_update* → message_end      (assistant, streamed)
    tool_execution_start → tool_execution_update* → tool_execution_end   (per call)
  turn_end
agent_end
```

Listener promises are awaited in subscription order and are part of the run's settlement: the agent
is still `isStreaming` until the `agent_end` listeners finish. That is deliberate, so a UI can flush
its last frame before the run is considered done.

## Tools

A tool is a `Tool` from `@OnePanda-TgSec/tg-ai` plus a label and an `execute` function:

```typescript
import type { AgentTool } from "@OnePanda-TgSec/tg-agent-core";
import { Type } from "typebox";

const weather: AgentTool = {
	name: "weather",
	label: "Weather",
	description: "Current weather for a city",
	parameters: Type.Object({ city: Type.String() }),
	execute: async (_toolCallId, { city }, signal) => {
		const response = await fetch(`https://example.invalid/${city}`, { signal });
		return { content: [{ type: "text", text: await response.text() }], details: undefined };
	},
};
```

- Return `isError: true` instead of throwing to report a failure the model should see and reason
  about. Throwing is for genuine bugs.
- `onUpdate` streams partial results to the UI.
- `executionMode` overrides the batch strategy for tools that cannot run concurrently.
- `outputSchema` declares the shape of `structuredContent`, which is kept out of the model's view
  and handed to programmatic callers instead.
- `replay` marks whether an effect whose outcome is unknown is safe to repeat after a crash.

Batch behaviour is set on the agent: `toolExecution: "parallel"` (default) prepares calls
sequentially and runs them concurrently; `"sequential"` runs each one end to end.

## Steering and Follow-ups

Two queues sit between turns:

- `getSteeringMessages()` is polled after a turn's tool calls finish. Return messages to change the
  agent's course mid-run; the current turn's tool calls still complete.
- `getFollowUpMessages()` is polled when the agent would otherwise stop. Return messages to keep it
  working on something else.

Both default to `one-at-a-time` draining; set `steeringMode` or `followUpMode` to `"all"`.

## Hooks

| Hook | When | Use it for |
| --- | --- | --- |
| `transformContext` | Before `convertToLlm` | Pruning, compaction, injecting external context. |
| `convertToLlm` | Before every request | Projecting `AgentMessage[]` onto provider messages. Must not throw. |
| `getApiKey` | Before every request | Short-lived credentials, e.g. an OAuth token that expires mid-run. |
| `prepareRequest` | Immediately before each request | Swapping context, model, or thinking level. |
| `finishTurn` | After a turn, before `turn_end` | `{ action: "end" }` to stop without another request. |
| `prepareNextTurn` | After `turn_end` when continuing | Rewriting state before the next turn. |
| `beforeToolCall` | After argument validation | Policy. `{ block: true }` emits an error result instead of running the tool. |
| `afterToolCall` | After execution, before events | Redacting or reshaping the result. Field-by-field override, no deep merge. |

Error and aborted responses are hard exits: `finishTurn` does not get to paper over them.

## Thinking Levels

`thinkingLevel` is one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. `xhigh` and `max`
are supported only by some model families; ask the model metadata from `@OnePanda-TgSec/tg-ai`
rather than assuming. Per-level token budgets go in `agent.thinkingBudgets`.

## Custom Messages

Applications add their own message roles by declaration merging:

```typescript
declare module "@OnePanda-TgSec/tg-agent-core" {
	interface CustomAgentMessages {
		artifact: ArtifactMessage;
	}
}
```

`AgentMessage` widens to include them, and `convertToLlm` decides what the provider actually sees.
UI-only messages are the usual case: project them away so they never reach the model.

## Low-level Loop

`agentLoop` and `agentLoopContinue` are the functions `Agent` wraps, exported for callers that need
the run without the stateful wrapper. They take a `TranscriptContext`, emit events into a sink, and
return the finished messages.

`streamProxy` turns a proxied upstream stream into an `AssistantMessageEventStream`, and
`setDefaultStreamFn()` overrides the function `Agent` uses when `streamFn` is not supplied.

## MCP and Code Mode

[`examples/mcp-codemode`](examples/mcp-codemode) wires this package to the two vendored TianGong
packages: it exposes MCP tools to a QuickJS sandbox so the model writes JavaScript against
injected tool signatures instead of emitting tool calls one at a time.

```bash
bun run examples/mcp-codemode/main.ts
```

It imports `@earendil-works/pi-mcp` and `@earendil-works/pi-codemode` by their upstream names,
because those packages were migrated verbatim from pi agent and are frozen.

## Development

From the monorepo root:

```bash
bun run check           # house standard, formatting, types
bun run test            # every package suite
bun run test packages/agent   # this package only
```

## Provenance

Adopted from the [pi agent](https://github.com/earendil-works/pi) project as
`@earendil-works/pi-agent-core` and rebranded under `@OnePanda-TgSec`. No module was added,
removed, or restructured. See [`docs/provenance.md`](../../docs/provenance.md) in the workspace root.

## License

MIT