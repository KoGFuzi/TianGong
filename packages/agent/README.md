# @OnePanda-TgSec/tg-agent-core

Agent 循环：模型 turn、工具执行、steering，以及 UI 绑定的事件流。

`@OnePanda-TgSec/tg-ai` 负责与模型对话。这个包决定发什么、运行什么、什么时候停。它没有存储也没
有 UI：它是 transcript 与 provider 之间的那一层。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [Agent](#agent)
- [事件](#事件)
- [工具](#工具)
- [Steering 与 Follow-ups](#steering-与-follow-ups)
- [Hooks](#hooks)
- [Thinking Levels](#thinking-levels)
- [自定义消息](#自定义消息)
- [底层循环](#底层循环)
- [可观测性](#可观测性)
- [MCP 与 Code Mode](#mcp-与-code-mode)
- [开发](#开发)
- [来源](#来源)
- [License](#license)

## 安装

```bash
bun add @OnePanda-TgSec/tg-agent-core @OnePanda-TgSec/tg-ai
```

## 快速开始

```typescript
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import { openaiProvider } from "@OnePanda-TgSec/tg-ai/providers/openai";
import { Agent } from "@OnePanda-TgSec/tg-agent-core";

const models = createModels();
models.setProvider(openaiProvider()); // 读取 OPENAI_API_KEY

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

`prompt()` 会一直运行到 agent 无事可做：每个工具调用都已解决、没有待处理的 steering 消息、没有
排队的 follow-up。`continue()` 从当前上下文继续，不新增用户消息。

## Agent

`Agent` 是有状态的封装。它的公开状态刻意保持很小：

| 成员 | 含义 |
| --- | --- |
| `agent.state` | `systemPrompt`（只读）、`model`、`thinkingLevel`、``tools`、`messages`、`isStreaming`、`streamingMessage`、`pendingToolCalls`、`errorMessage`。 |
| `agent.prompt(input, images?)` | 排队用户输入并运行到 agent 安定。 |
| `agent.continue()` | 从当前上下文再跑一轮。 |
| `agent.abort()` | 中止当前运行。`agent.signal` 暴露其 `AbortSignal`。 |
| `agent.subscribe(listener)` | 接收事件。返回取消订阅函数。 |

给 `state.tools` 或 `state.messages` 赋值会拷贝数组，所以拿着旧引用的调用方不会意外改到活的
agent 状态。修改 `state.tools` 会在下一次请求前用一条系统消息向模型宣告差异。

系统提示词是只读的。要改它就追加一条系统消息；transcript 里的系统消息是唯一事实来源，回放进
`state.systemPrompt`。

## 事件

`subscribe()` 收到有序的 `AgentEvent` 流：

```text
agent_start
  turn_start
    message_start → message_update* → message_end      (assistant，流式)
    tool_execution_start → tool_execution_update* → tool_execution_end   (每次调用)
  turn_end
agent_end
```

监听器的 promise 按订阅顺序 await，并且是运行 settlement 的一部分：直到 `agent_end` 的监听器全
部结束，agent 仍处于 `isStreaming`。这是刻意的——UI 可以在运行被认为结束之前刷完最后一帧。

## 工具

工具是来自 `@OnePanda-TgSec/tg-ai` 的 `Tool` 加上 label 和 `execute` 函数：

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

- 返回 `isError: true` 而不是抛异常，用于报告模型应该看到并自行推理的失败。抛异常只留给真正的
  bug。
- `onUpdate` 把部分结果流式推给 UI。
- `executionMode` 为不能并发执行的工具覆盖批量策略。
- `outputSchema` 声明 `structuredContent` 的形状：它不进模型的视野，交给编程调用方。
- `replay` 标记一个结果未知的副作用在崩溃后重放是否安全。

批量行为在 agent 上设置：`toolExecution: "parallel"`（默认）顺序准备、并发执行；
`"sequential"` 端到端逐个执行。

## Steering 与 Follow-ups

两个队列坐落在 turn 之间：

- `getSteeringMessages()` 在一轮的工具调用结束后轮询。返回消息以在中途改变 agent 的走向；当前
  turn 的工具调用仍会跑完。
- `getFollowUpMessages()` 在 agent 本来要停的时候轮询。返回消息让它继续干别的事。

两者默认一次取一条；把 `steeringMode` 或 `followUpMode` 设为 `"all"` 则全部取出。

## Hooks

| Hook | 时机 | 用途 |
| --- | --- | --- |
| `transformContext` | `convertToLlm` 之前 | 剪枝、压缩、注入外部上下文。 |
| `convertToLlm` | 每次请求之前 | 把 `AgentMessage[]` 投影为 provider 消息。不许抛异常。 |
| `getApiKey` | 每次请求之前 | 短期凭证，例如运行中途会过期的 OAuth token。 |
| `prepareRequest` | 每次请求紧前 | 换上下文、模型或 thinking level。 |
| `finishTurn` | turn 之后、`turn_end` 之前 | `{ action: "end" }` 不再发请求直接停。 |
| `prepareNextTurn` | 继续时 `turn_end` 之后 | 下一轮之前改写状态。 |
| `beforeToolCall` | 参数校验之后 | 策略。`{ block: true }` 发错误结果而不运行工具。 |
| `afterToolCall` | 执行之后、事件之前 | 脱敏或重塑结果。逐字段覆盖，不做深合并。 |

错误与中止响应是硬退出：`finishTurn` 不能把它们掩盖掉。

## Thinking Levels

`thinkingLevel` 取值为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。`xhigh` 与
`max` 只有部分模型家族支持；问 `@OnePanda-TgSec/tg-ai` 的模型元数据，不要想当然。每个 level 的
token 预算放进 `agent.thinkingBudgets`。

## 自定义消息

应用通过声明合并加自己的消息角色：

```typescript
declare module "@OnePanda-TgSec/tg-agent-core" {
	interface CustomAgentMessages {
		artifact: ArtifactMessage;
	}
}
```

`AgentMessage` 随之拓宽，`convertToLlm` 决定 provider 实际看到什么。UI 专用消息是最常见的场
景：把它们投影掉，永远到不了模型。

## 底层循环

`agentLoop` 与 `agentLoopContinue` 是 `Agent` 所包装的函数，导出给需要"运行但不需要有状态封装"
的调用方。它们接收 `TranscriptContext`、把事件发进 sink，并返回完成时的消息。

`streamProxy` 把代理的上游流变成 `AssistantMessageEventStream`；
`setDefaultStreamFn()` 覆盖未提供 `streamFn` 时 `Agent` 使用的函数。

## 可观测性

可选字段 `telemetryContext`（经 `AgentLoopConfig` 传入）打开 span 记录：

- 每个 turn 记录一个 `tg.span.agent.turn`：开始属性 `provider`、`model`；turn 结束时写
  `stopReason` 与 `toolCallCount`；以 error/aborted 结束时 status 为 error。
- 每次工具调用记录一个 `tg.span.agent.tool`（父于 turn span）：开始属性 `toolName`，settle 时写
  `isError` 并据其置 status。顺序、并发两种批量执行、截断消息导致的整批失败、权限拒绝，全部覆
  盖。
- turn span 作为请求的父上下文传给 provider，所以一轮带工具的 turn 呈现为一棵树：
  `turn ⊃ acquire ⊃ request`、`turn ⊃ tool × n`。

边界是刻意的：`prepareNextTurn`（可能触发压缩）与 `finishTurn`、`turn_end`/`agent_end` 事件都
在 turn span 之外。

嵌套工具调用（工具再调工具）经 `runToolCall` 的 `RunToolCallOptions.telemetryContext` 把 span 挂
在父工具 span 下面；不传则该次调用不记录。

不传 `telemetryContext` 时全部是 NOOP：span 数为零，事件序列与不配 telemetry 时逐事件一致。

词表定义在 `@OnePanda-TgSec/tg-telemetry` 的 `TG_SPAN_SCHEMA`。

## MCP 与 Code Mode

[`examples/mcp-codemode`](examples/mcp-codemode) 把本包接到两个 vendored TianGong 包上：它把
MCP 工具暴露给 QuickJS 沙箱，让模型对着注入的工具签名写 JavaScript，而不是一次发一个工具调用。

```bash
bun run examples/mcp-codemode/main.ts
```

它以原名 import `@earendil-works/pi-mcp` 与 `@earendil-works/pi-codemode`——这两个包是从 pi
agent 原样迁移的，处于冻结状态。

## 开发

从 monorepo 根目录：

```bash
bun run check           # house standard、格式、类型
bun run test            # 每个包套件
bun run test packages/agent   # 只跑本包
```

## 来源

从 [pi agent](https://github.com/earendil-works/pi) 项目以 `@earendil-works/pi-agent-core` 身份采
用，改牌到 `@OnePanda-TgSec`。模块无增删重组；埋点模块（`src/telemetry.ts`）与对 agent-loop 的
span 包裹为本工作区新增。见工作区根目录的
[`docs/provenance.md`](../../docs/provenance.md)。

## License

MIT
