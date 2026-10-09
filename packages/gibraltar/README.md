# @OnePanda-TgSec/tg-gibraltar

> **实验性。** 发布之间 API 可能不预告就变化。

持久化 agent harness。会话、模型 turn、工具调用以及你自己的状态，都在展示之前先提交进存储。进程
死在 turn 中途，重新打开存储后工作会从断点继续。

构建于 [`@OnePanda-TgSec/tg-ai`](../ai/README.md)（模型访问）与 `@OnePanda-TgSec/chord`（文档状
态）之上。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [概念](#概念)
- [持久化与恢复](#持久化与恢复)
- [扩展](#扩展)
- [工具](#工具)
- [系统提示词](#系统提示词)
- [每会话 Agent](#每会话-agent)
- [设置](#设置)
- [环境](#环境)
- [Reload](#reload)
- [观察会话](#观察会话)
- [忙碌会话](#忙碌会话)
- [重置与交接](#重置与交接)
- [压缩（Compaction）](#压缩compaction)
- [Agent 事件（实验性）](#agent-事件实验性)
- [Hooks](#hooks)
- [更多会话与 Fork](#更多会话与-fork)
- [中止与 Subagent](#中止与-subagent)
- [子任务](#子任务)
- [任务图](#任务图)
- [你自己的状态](#你自己的状态)
- [用量与费用](#用量与费用)
- [存储](#存储)
- [示例](#示例)
- [设计文档](#设计文档)

## 安装

```bash
bun add @OnePanda-TgSec/tg-gibraltar @OnePanda-TgSec/tg-ai @OnePanda-TgSec/chord
```

## 快速开始

```typescript
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import { openaiProvider } from "@OnePanda-TgSec/tg-ai/providers/openai";
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from "@OnePanda-TgSec/tg-gibraltar";

const context = BACKGROUND_CONTEXT;

const models = createModels();
models.setProvider(openaiProvider()); // 读取 OPENAI_API_KEY

const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, context);
const root = await harness.root(context, { agent: { model: { provider: "openai", modelId: "gpt-6-sol" } } });

const submission = await root.submit({ type: "input", content: "What is the capital of France?" }, context);
const settled = await submission.wait(context);
if (settled.status === "done" && settled.type === "input") {
	const answer = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
	console.log(answer?.model?.[0]);
}
await harness.close(context);
```

发生了什么：

- `Harness.open()` 在存储后端上打开一个 Session。`MemoryStorage` 把所有东西放在内存里。
- `root()` 返回根会话，首次使用时按给定的 agent 选择创建。会话是 immutable entry 的 transcript。
- `submit()` 把你的输入持久化受理，并返回一个 `Submission`。内置 generation 任务调用模型并追加
  回答。
- `wait()` 在输入被回答（`done`）或失败（`unanswered`，带原因）时 resolve。

每个异步调用都接受一个 Chord `Context`，它携带取消语义。`BACKGROUND_CONTEXT` 永不取消。取消一个
wait 只取消那个 wait，永不取消工作本身。

## 概念

- **Harness**：一份打开的存储加上在其上运行 agent 的机制。所有变更都走同一条原子提交线，任何东
  西在它的提交落库之前不会被展示。
- **Conversation**：一条 transcript。`root()` 首次使用时创建根会话；你可以创建更多并 fork。会话
  句柄不持有状态；按 `id` 比较句柄。
- **Entry**：一条 immutable transcript 记录，如用户消息（`tg.user`）、模型响应（`tg.assistant`）、
  工具结果（`tg.tool-result`）、系统提示词变更（`tg.system`）、重置（`tg.reset`），或你自己的
  kind。模型看到的是最近一次 reset 以来的 entry。
- **Commit**：一次原子写入。`conversation.commit((tx) => ...)` 可以追加 entry、编辑文档、创建任
  务，要么全部落库要么全部不落。
- **Document**：存放在 transcript 旁边的类型化 JSON 状态，随 commit 变更。内置文档保存每个会话的
  agent 选择（`tg.agent`）、运行中的 generation 与工具（`tg.live`）、排队的 submission
  （`tg.inbox`）与花费（`tg.usage`）。
- **Task**：随每一步保存检查点的持久化状态机，重启的进程从上一个检查点继续。每个任务都有属主：
  它的会话，或另一个任务。Harness 以内置任务运行回答：`tg.generation` 调用模型并持有其工具调用
  的 `tg.tool` 任务，等待它们，然后把运行交给下一轮 generation。
- **Submission**：你交给会话的东西，用户输入或一条待写 entry，可以等待它。
- **Turn 与 run**：turn 是一次模型响应及其工具调用；run 是从一个输入到其最终回答的若干 turn。有
  run 进行时会话处于忙碌状态。
- **Extension**：具名的一组工具、系统提示词 section、hook、包装器与任务。
- **Registry**：本进程安装的扩展。可以在 Harness 运行中变更；新工作使用新状态。
- **Agent**：会话运行的配置：模型、thinking level、选中的扩展、工具、指令与工作目录。按会话存储
  为 `tg.agent` 中的名字，每次使用时对照 registry 解析。

一个被回答的输入，以 entry 与任务表示：

```text
submit(input) → tg.user
  tg.generation → tg.system（仅当提示词或工具变化时）, tg.assistant（工具调用）
    tg.tool × n → tg.tool-result × n   （由 generation 持有并等待）
  tg.generation → tg.assistant（回答） → submission done
```

## 持久化与恢复

使用 SQLite 存储让会话跨重启保留：

```typescript
import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const harness = await Harness.open(await openNodeSqliteStorage("./session.sqlite"), { models, registry }, context);
// 或不带任何路径：
// const harness = await Harness.open(await openDefaultSqliteStorage(), { models, registry }, context);
const root = await harness.root(context); // 与上次同一个根会话
harness.resume(); // 继续上次进程未完成的任何运行
```

被崩溃或关闭打断的工作保持挂起。`resume()` 启动任务调度器；submit 或 wait 也会启动它。带相同
`requestId` 的重试 submission 会返回已有 submission 而不是重复提交：

```typescript
const submission = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// 重启之后：同一个请求 ID 找到同一个 submission。
const again = await root.submit({ type: "input", content: "Hello", requestId: "greeting-1" }, context);
// again.id === submission.id
```

`harness.submission(id)` 按 ID 重新获取一个 submission，例如用于在重启后等待它。

## 扩展

Harness 运行的、内置任务以外的代码，以具名扩展的形式安装在你进程拥有的 registry 里：

```typescript
import { createRegistry, defineExtension, defineTool, hook, section, ToolTask } from "@OnePanda-TgSec/tg-gibraltar";
import { CodingTools } from "@OnePanda-TgSec/tg-gibraltar/tools";

const Coding = defineExtension({
	name: "coding",
	sections: [section("preamble", () => "You are a concise coding assistant.", { tag: false })],
	hooks: [hook(ToolTask, { beforeTool: (call) => (isDangerous(call) ? { block: "Needs approval" } : undefined) })],
});

const registry = createRegistry();
registry.install(CodingTools);
registry.install(Coding);
```

一个扩展可以携带 `tools`、`sections`、`hooks`、`wraps`（按名字装饰工具或 section）与 `tasks`。
默认每个会话按安装顺序选中所有已安装扩展。registry 里没有任何东西被存储；会话存的是扩展名。

## 工具

`@OnePanda-TgSec/tg-gibraltar/tools` 提供 `read`、`write`、`edit`、`bash`，以及包含全部四个的
`CodingTools` 扩展。它们只通过调用的环境接触文件与进程（见[环境](#环境)）。暂不支持读取图片。

用 TypeBox schema 定义你自己的工具。`defineTool()` 从 `parameters` 类型化 `args`，Harness 在
`execute()` 之前校验。`api.output()` 流式输出运行中的内容，当 `execute()` 没有返回 `content` 时
成为结果：

```typescript
import { Type } from "@OnePanda-TgSec/tg-ai";

const count = defineTool({
	name: "count",
	description: "Count from 1 to n",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args, api) => {
		for (let i = 1; i <= args.n; i++) api.output(`${i}\n`);
		return {};
	},
});
registry.install(defineExtension({ name: "count", tools: [count] }));
```

每次调用作为独立的持久化任务运行。它的意图在 `execute()` 运行之前就已提交。进程死在调用中途
时，只有声明了 `replay: "safe"` 的工具会在重新打开时重跑；否则模型得到一个 `interrupted` 错误
结果，已提交的输出随之保留。从 `execute()` 抛出会给模型一个错误结果。结果也可以返回 `usage`，
会计入会话的[用量](#用量与费用)。还可以返回 `control: { terminate: true }`：当一轮的每个结果都
这样要求时，run 结束且不再发模型请求。

后安装的扩展里的同名工具在两个都被选中时替换先安装的；`wrapTool()` 装饰最终胜出的那个工具：

```typescript
const Venv = defineExtension({ name: "venv", tools: [createBashTool({ commandPrefix: "source .venv/bin/activate" })] });
const Timing = defineExtension({
	name: "timing",
	wraps: [wrapTool(createBashTool(), (bash) => ({ ...bash, execute: (args, api, ctx) => timed(() => bash.execute(args, api, ctx)) }))],
});
```

## 系统提示词

系统提示词由选中扩展的 section 按顺序构建，在每次请求前渲染。section 能看到解析后的 agent、为
请求构建的环境以及已提交的文档：

```typescript
section("cwd", (input) => input.env?.cwd); // 渲染为 <cwd>\n...\n</cwd>；undefined 则省略
```

会话的 `instructions` 最后渲染，作为 section `instructions`。section 与工具变化以位置系统 entry
的形式存储在 transcript 里。只有变化的部分会重新发送，保持 provider prompt 缓存的热度。每次都
返回不同内容的 section（例如当前时间）会破坏这一点。

## 每会话 Agent

每个会话把自己的运行配置存在 `tg.agent` 文档里。`configure()` 在一次 commit 里修改它；未设置
的字段跟随宿主：

```typescript
await root.configure(
	{
		model: { provider: "openai", modelId: "gpt-6-sol" },
		thinkingLevel: "high",
		extensions: { remove: [Coding] }, // 编辑宿主默认；数组形式则恰好选中这些，按顺序
		tools: [readTool, bashTool], // 数组形式恰好提供这些；{ remove: [...] } 移除部分
		instructions: "Only read; never edit files.",
		cwd: "/work/repo",
	},
	context,
);
await root.configure({ tools: null }, context); // null 把字段清回宿主默认
const agent = await root.agent(context); // 已解析：model、extensions、tools、sections、cwd
```

扩展与工具以对象传入、以名字存储，所以存储的名字比代码活得久：扩展被卸载后，选中它的会话只是不
再得到它，直到重新安装。`createConversation()`、`fork()` 与 `root()` 接受与 `agent` 相同的变
更。任务持有的会话（如 subagent 的）起始是其属主会话 agent 的拷贝。fork 从父会话在 fork entry 处
的 agent 开始。请求所用模型、提示词与工具在准备时固定；变更从下一个请求生效。工具调用与 hook 使
用的 agent 是其任务阶段所解析的，环境在每次使用时从当前 `cwd` 构建，所以 `cwd` 或扩展变更可以影
响模型已经发出的调用。

## 设置

所有会话共享的运行策略以 `settings` 传入。它在每次使用时读取且永不存储，所以 getter 是活配置，
例如由设置文件支撑：

```typescript
const harness = await Harness.open(storage, {
	models,
	registry,
	settings: {
		extensions: [CodingTools, Coding], // 默认选中；缺省时为全部已安装扩展
		stream: { timeoutMs: 120_000 },
		retry: { maxRetries: 3 },
		compaction: { reserveTokens: 16384 },
		toolExecution: "parallel",
		get followUpMode() {
			return userSettings.followUpMode;
		},
	},
}, context);
```

## 环境

`env` 为每次工具调用、section 渲染与 `runtime.env()` 构建执行环境。它接收会话 ID、其 agent
`cwd` 与已提交的读，所以一个函数可以服务于"每会话一个目录"或"每会话一个容器"：

```typescript
import { NodeExecutionEnv } from "@OnePanda-TgSec/tg-gibraltar/env/node";

const harness = await Harness.open(storage, {
	models,
	registry,
	env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
}, context);
```

`env` 抛出的异常成为该调用的错误结果。没有环境时，内置工具以错误结果失败。每次调用用新的环境
对象没有问题：`edit` 与 `write` 按环境的 `id` 与路径串行化对同一文件的变更。自定义
`ExecutionEnv` 要设置 `id`，使相同 id 看到相同路径下的相同文件，例如每容器一个 id。

## Reload

以已安装的名字安装一个扩展会原地一步替换它：

```typescript
registry.install(await loadCodingExtension()); // 同名 "coding"：替换已安装的那个
```

`registry.uninstall(extension)` 移除该名字已安装的扩展，无论对象是谁。

已经开始的工作保留它取到的代码：运行中的工具调用在旧实现下跑完，每个任务阶段从阶段开始时点的
registry 解析一次 hook 与 agent。下一个阶段、请求或调用使用新代码。重启后重新安装同样的扩展；
扩展 `tasks` 的挂起任务在安装后恢复。

## 观察会话

UI 需要的一切都是已提交状态。`viewState()` 把会话的结构视图作为只读 Chord 状态返回，在每个触
及它的 commit 之后更新：

```typescript
const view = await root.viewState(context);
view.subscribe((value) => {
	// value.entries：活跃 transcript
	// value.docs["tg.live"]：运行中的 generation（流式 partial、retry、deferred）与工具调用（output、details）
	// value.docs["tg.inbox"], value.docs["tg.usage"], value.docs["tg.agent"]
	render(value);
});
// 之后：view.dispose();
```

`watch()` 以每个 commit 的精确 Chord 操作交付同样的视图，一次一个回调：

```typescript
const watch = await root.watch(context);
render(watch.value); // 附着时刻的状态
watch.start(async (value, ops) => {
	await send(ops); // 例如发给应用操作的远程客户端
});
// 之后：await watch.stop();
```

慢的 watch 最多积压 100 帧未投递内容；超过后，待投帧被替换为持有最新完整视图的一帧。迟到或重连
的客户端从当前视图开始；不重放任何内容。

部分回答与工具输出最多每 100 ms 提交一次，所以一次崩溃最多丢失这个窗口。

## 忙碌会话

有 run 在处理输入时会话处于忙碌状态。向忙碌会话提交会把 submission 排进会话收件箱，即视图里
的 `docs["tg.inbox"]`：

```typescript
await root.submit({ type: "input", content: "Also run the tests" }, context); // follow-up（默认）
await root.submit({ type: "input", content: "Use pnpm, not npm", whenBusy: "steer" }, context);
await root.submit({ type: "input", content: "Only if idle", whenBusy: "reject" }, context); // 抛 ConversationBusy
await root.submit({ type: "write", entry: { kind: "app.note", data: "user opened a file" } }, context);
```

- **Steer** 放在当前工具轮之后，加入正在运行的工作。
- **Follow-up** 在 run 回答时放入，启动下一个 run。
- **Write** 追加一条 entry，不问模型。
- `await submission.abort(context)` 撤回一个排队的 submission。
- [设置](#设置)里的 `steeringMode: "all"` 与 `followUpMode: "all"` 一次性放入全部排队项，而不是每
  轮一条。

run 失败时，排队项留在收件箱里，直到下一个 submission 放置它们，最旧的最先。

## 重置与交接

`reset()` 开启一段新上下文。模型不再看到更旧的 entry，但它们仍留在存储里：

```typescript
await root.reset(undefined, context);                                  // 从零开始
await root.reset("We were fixing the flaky login test. Continue.", context); // 从交接说明开始
```

忙碌时的重置像 write 一样排队。在工具轮中被放置时，当前 run 结束。工具可以用
`control: { handoff: "..." }` 要求同样的效果。

## 压缩（Compaction）

压缩缩小模型看到的内容：它总结较旧的 entry 并追加一条 `tg.compaction` entry，保存摘要并指向它
保留的第一条 entry。更旧的 entry 留在存储里。

```typescript
const id = await root.compact("Keep the failing test names", context); // 手动，可带指令
const { outcome } = (await harness.waitForTask(id, context)).state;
if (outcome.status === "completed" && outcome.result.submissionId !== undefined) {
	const placed = await (await harness.submission(outcome.result.submissionId, context))!.wait(context);
	console.log(placed.status); // "done"，或带原因 "stale" 的 "unanswered"
}
```

摘要生成期间会话继续工作。摘要在会话空闲时一次性放置，否则在下一个 turn 边界放置。Esc
（`abort()`）取消手动压缩。

generation 也自行压缩，由[设置](#设置)控制：

```typescript
settings: {
	compaction: {
		enabled: true, // 自动压缩；手动 compact() 永远可用
		reserveTokens: 16384, // 高于 contextWindow - reserveTokens 时，下一个请求等待压缩
		keepRecentTokens: 20000, // 粗略保留多少最近的上下文原文
		backgroundTokens: 32768, // 低于该值这么多时，后台开始一次压缩；0 关闭
	},
}
```

当 provider 以上下文过长为由拒绝请求时，generation 压缩后重试一次。会把当前上下文起点切掉的摘
要在放置时 settle 为 `stale`，所以多个摘要在飞时最远的切口保持生效。摘要生成的花费计入
`tg.usage`。`CompactionTask` 上的 `beforeCompact` hook 可以拒绝或提供自己的摘要。

运行中的压缩列在 `docs["tg.live"].compactions`，带原因、尝试次数与重试退避。agent 事件增加
`compaction_start` 与 `compaction_end`，snapshot 里增加 `compactions` 字段。

## Agent 事件（实验性）

想要编码代理风格事件（`message_start`、`message_update`、`tool_execution_start`，……）而不是结
构化状态的消费方：

```typescript
import { watchEvents } from "@OnePanda-TgSec/tg-gibraltar";

const stream = await watchEvents(harness, root.id, context);
initialize(stream.snapshot); // entries、run、进行中的 generation、工具、压缩、inbox、agent、usage
stream.start(async (events) => {
	for (const event of events) console.log(JSON.stringify(event));
});
```

事件从 commit 派生，每个 commit 一批，叠加在 snapshot 之上。消息与工具更新携带 delta：文本与
thinking 追加、工具调用参数的追加文本、输出的裁剪与追加。消费者落后超过 100 批时，会收到一个全
新的 `snapshot` 事件。完整的一次运行事件流见 `test/examples/19-json.ts`。

## Hooks

Hook 让扩展观察或调整内置任务，在选中它们的会话里：

```typescript
import { GenerationTask, hook, ToolTask } from "@OnePanda-TgSec/tg-gibraltar";

const Guard = defineExtension({
	name: "guard",
	hooks: [
		hook(ToolTask, { beforeTool: (call) => (call.name === "bash" ? { block: "bash is disabled here" } : undefined) }),
		hook(GenerationTask, { onYield: (answer) => (needsMoreWork(answer) ? { continue: "Keep going." } : undefined) }),
	],
});
```

- **Generation**：`beforeRequest`（替换一次请求的消息）、`afterResponse`、`onYield`（以另一条用户
  消息继续 run）、`afterTools`（一轮工具全部完成后运行一次）。
- **Tools**：`beforeTool`（阻断或改写参数）与 `afterTool`（替换结果）。

要让 hook 只作用于部分会话，只在那里选中它的扩展，例如 `configure({ extensions: { add: [Guard] } })`。

## 更多会话与 Fork

```typescript
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const fork = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
```

fork 看到其父会话到 `entryId` 为止的 entry，然后独立继续。它保留父会话在该 entry 处的 agent。两
者都接受 `agent` 与 `init`，在创建它们的 commit 里应用。

## 中止与 Subagent

`await root.abort(context)` 停止一个会话：排队的输入被撤回（排队的 write 保留），其当前工作的
每个任务被中止，调用在会话空闲后 resolve。

会话可以被任务**持有**。subagent 工具在 `api.commit()` 里以
`ownership: { kind: "task", taskId: api.taskId }` 创建其子会话，然后通过 `api.conversation(id)`
驱动它：

```typescript
const Subagent: Extension = defineExtension({
	name: "subagent",
	tools: [
		defineTool({
			name: "subagent",
			description: "Delegate a self-contained task to a subagent and get its answer back.",
			parameters: Type.Object({ task: Type.String() }),
			replay: "safe", // 崩溃后的重跑找到同一个子会话与 submission
			execute: async (args, api, context) => {
				const child = await api.commit(async (tx) => {
					// 属主索引记住了子会话，所以重跑会复用它。
					const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
					if (existing !== undefined) return existing.id;
					// 起始是该会话 agent 的拷贝：模型、扩展、工具、cwd。
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
					// 更便宜的模型，且它自己没有 subagent。
					await configure(tx, created.id, { model: haiku, extensions: { remove: [Subagent] } });
					return created.id;
				}, context);
				await api.details({ conversationId: child }, context); // 让 UI 附着到子会话
				const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
				const settled = await (await (await api.conversation(child, context))!.submit(request, context)).wait(context);
				return { content: [{ type: "text", text: settled.status }] };
			},
		}),
	],
});
```

被持有的工作属于它的属主：

- 中止调用会中止子会话。调用失败也一样：`execute()` 抛异常，或崩溃打断了一个非 replay-safe 的调
  用。
- 父会话只有在子会话空闲后才算空闲。
- 以 `{ background: true }` 创建的任务是一个边界：它持有的工作在父会话中止后存活，且不让父会话
  保持忙碌。`root.abort(context, { background: true })` 也会中止它。

两个模式在示例里都是产品代码：

- [`22-subagent-foreground.ts`](test/examples/22-subagent-foreground.ts)：上面的工具，返回子会话的
  回答。UI 通过调用的 `details` 找到子会话，把子会话事件缩进打印在调用下面。
- [`23-subagent-background.ts`](test/examples/23-subagent-background.ts)：一个 `subagent` 工具背
  后的常驻 subagent：生成、发消息（steer 或 follow-up）、等待、停止、列出。每个子会话由一个后台
  锚任务持有，所以父会话的 Esc 与空闲等待都够不到它。每条消息由一个后台 reporter 任务投递，答
  到后以 follow-up 输入回发给父会话；request ID 保证重启后不会重复发送消息或报告。

## 子任务

一个任务可以持有子任务，以 `ownership: { kind: "task", taskId }` 创建，并通过提交一个 `waiting`
状态等待它们：

```typescript
pay: async (task, runtime, context) => {
	await runtime.commit(async (tx) => {
		const payments = [];
		for (const card of task.input.cards) {
			payments.push(await tx.createTask(Payment, { card }, { ownership: { kind: "task", taskId: task.id } }));
		}
		// 每个 payment 完成后在 `decide` 恢复；第一个失败会中止其余。
		return { status: "waiting", checkpoint: { phase: "decide", payments }, on: payments, policy: "failFast" };
	}, context);
},
decide: async (task, runtime, context) => {
	const outcomes = await runtime.outcomes(task.state.checkpoint.payments, context);
	// ...提交 checkout 自己的 outcome
},
```

- **等待**：任务在等待期间不运行代码。`allSettled` 时一旦 `on` 里的每个任务完成就恢复；
  `failFast` 时第一个失败的子任务也会中止其余。`on` 也可以命名其他任务，配合 `allSettled`。
- **完成**：结束时仍有其持有的工作在运行的任务是 `completing`：它的 outcome 已定，但要等到那份
  工作完成才成为终态，`waitForTask()` 也到那时才返回。失败或中止的 outcome 会先中止那份工作。
- **中止**：中止自底向上运行。中止一个任务先中止它持有的工作，它自己的中止处理器只在那份工作完
  成后才开始，于是每个任务撤销自己的效果。

[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 运行一个拥有并等待四笔支付的 checkout：一
张被拒的卡、一个被取消的 checkout、以及支付进行中的一次重启。

## 任务图

`harness.taskGraph(context)` 把 Session 的每个活任务显示为一个 Chord 状态，供任务面板或调试使
用。每个节点有其属主边（`owner` 任务，或会话自持任务没有）、状态、是否 `background` 或带中止标
记，以及它持有的会话。`harness.watchTaskGraph(context)` 以 watch 的方式交付同样的值，如同会话的
`watch()`。

```typescript
const graph = await harness.taskGraph(context);
graph.subscribe((value) => {
	for (const node of Object.values(value.tasks)) {
		const status = node.state.status === "waiting" ? `waiting on ${node.state.on.join(", ")}` : node.state.status;
		console.log(`${node.id} ${node.kind} ${status}`, node.owner ?? `conversation ${node.conversationId}`);
	}
});
```

任务随创建它的 commit 出现，随使它成为终态的 commit 离开。状态是已提交的那几个：`pending`、
`running`、`waiting`（带 `on` 与 `policy`）、`completing`（持有未决的 outcome 状态）。重启后，
曾处于 `running` 的任务显示为 `pending`，直到再次运行。挂起的任务是否被缺失的定义阻塞不属于图
的内容；`harness.inspect()` 会报告。图只列活任务：一旦 subagent 的属主任务成为终态，其会话中较
晚的任务就是顶层节点，会话的 `ConversationRecord.owner`（也在其视图的 `conversation` 里）把它链
回父会话。[`24-child-tasks.ts`](test/examples/24-child-tasks.ts) 在支付进行时打印 checkout 的树。

## 你自己的状态

文档是与 entry 一起提交的类型化 JSON 对象。定义一个，然后在 commit 里编辑它：

```typescript
import { defineDoc } from "@OnePanda-TgSec/tg-gibraltar";

const Todos = defineDoc<{ items: string[] }>({
	kind: "app.todos",
	version: 1,
	scope: "conversation",
	history: "latest", // 或 "rewindable"，用 snapshotAsOf() 读旧值
	fork: "initial", // fork 的起始内容："initial"、"current" 或 "asOf"
	initial: () => ({ items: [] }),
});

await root.commit(async (tx) => {
	(await tx.doc(Todos, root.id)).items.push("write docs");
}, context);
console.log(await harness.snapshot(Todos, root.id, context));
```

`harness.watchDoc()` 与 `harness.documentState()` 像上面的视图一样观察单个文档。
`HarnessOptions.conversationCreated(tx, conversation)` 在每个创建或 fork 会话的 commit 里运行，
包括工具的裸 `tx.createConversation()`，所以每个会话都有你的文档；`createConversation()`、
`fork()` 与 `root()` 里的 `init` 在同一份 commit 里写按次数据。扩展的工具、section 与 hook 通过
`api` 或 `input.read` 读取自己的文档，并把缺失文档按默认值对待
（[`11-extension-state.ts`](test/examples/11-extension-state.ts)）。

## 用量与费用

每个会话在 `docs["tg.usage"]` 里保存 token 与费用总计：模型响应按 `provider/model`、报告了
usage 的工具结果按工具名。失败与中止的尝试也计入。整个 Session：

```typescript
const usage = await harness.usage(context); // { models: { "openai/gpt-6-sol": Usage }, tools: {...} }
```

写入点与 entry 追加同 commit 原子：assistant 消息（`models` bucket）与工具结果（`tools` bucket）
落账时不会留下半提交的 turn。

整个项目层面，`projectUsage(storage, context)` 只读聚合出 `{ conversations, usage }`：有花费的会
话数，以及按模型/工具折叠的 `UsageState`。账始终只有一份（`tg.usage`），聚合是读时计算，不引入
第二份写路径。

## 存储

生产环境只用 SQLite。`MemoryStorage` 为测试存在。

| 后端 | 导入 | 说明 |
|---|---|---|
| SQLite | `@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node` 的 `openNodeSqliteStorage(file)` | 一个数据库文件。WAL 模式 + `synchronous = NORMAL`：commit 在进程崩溃后存活；最新数据在断电或主机故障时可能丢失。 |
| 默认 | 同一子路径的 `openDefaultSqliteStorage()` | `~/.local/share/TianGong/session.sqlite`，无需路径参数。 |
| 内存 | 包根目录的 `MemoryStorage` | 什么都不持久化。仅测试。 |

### 生命周期：删除、导出、备份

生命周期是 `Storage` 接口上的显式方法，不进 commit 写路径；`MemoryStorage` 与 `SqliteStorage`
同一 conformance 套件双侧同测：

```typescript
// 单事务删除会话及其全部行（entries、tasks、submissions、documents 按 conversation_id 级联）。
// 返回 ConversationDeletion 审计摘要；会话不存在返回 undefined，不抛错。
const deletion = await storage.deleteConversation(id, context);

// 把会话自己的行序列化为有序 JSONL 字符串数组：header + entries + tasks + submissions + documents，
// 从同一份一致快照读出。逐行 JSON.parse 即可还原。本期只导不入。
const lines = await storage.exportConversation(id, context);

// 用 VACUUM INTO 写出整库一致快照；目标文件已存在则报错（SQLite 语义原样透传）。
await storage.backup("./backup-session.sqlite", context);
```

约束：

- **审计**：每次删除在 `durable_metadata.deleted_conversations` 追加一条审计记录（何时删了哪个会
  话）。数据表结构不变，schema 版本随该单列迁移升到 3。
- **幂等**：删除不存在的会话返回 `undefined`；ID 永不回收（`record_ids` / `durable_metadata` 不动），
  保证 `mintId` 单调与审计连续。
- **Fork 不断链**：删除父会话不级联子会话——子会话的 entry 自持有数据；父行缺失被视为可见历史的
  终点，读取不会报错。
- **不导不入**：导入涉及 ID 冲突策略（重新 mint 还是保留原 ID），单独评审后再做。

### JSONL 存储已移除

append-only JSONL 后端曾与 SQLite 并存。它被移除了，理由只有一个：两种生产文件格式意味着两条迁
移路径、两条恢复路径、两套要推理的崩溃语义，而其中只有一条会被真正调优。SQLite 有 WAL、多表原
子 commit 与 `integrity_check`；JSONL 一样都没有。

早期版本写出的 JSONL 存储没有读取器。这是诚实的陈述，也是移除发生在任何部署之前而非之后的原因。

### 项目隔离

每一行都带 `project_id`，每次读取都按它过滤。一个数据库文件可以装多个项目，互不可见对方的会话、
entry、任务与 submission。

```typescript
const storage = await openNodeSqliteStorage(path, { project: "workspace-a" });
storage.project; // "workspace-a"
```

默认值是 `"default"`；项目隔离引入之前写入的行都被归入它。空项目 id 在打开时被拒绝。

### 健康与维护

```typescript
const health = await storage.health();
// { ok: true, integrity: "ok", schemaVersion: 3, journalMode: "wal",
//   synchronous: 1, walAutoCheckpointPages: 1000, busyTimeoutMs: 5000 }
await storage.checkpoint(); // wal_checkpoint(TRUNCATE)
```

`health()` 从连接读回 `integrity_check`、已记录的 schema 版本与连接设置，所以它报告的是数据库实
际被配置成什么，而不是适配器意图什么。在还没有跑过迁移的文件上，`schemaVersion` 是 0。

### 可移植性

一个进程同时持有一份存储；没有跨进程锁。可移植 SQLite 核心（`/storage/sqlite`）不依赖 Node
API，例如跑在 Bun 或 Cloudflare Durable Objects 上，只要提供一个异步 `SqliteDatabase` 门面。Node
子路径（`/storage/sqlite/node`）负责绑定 `node:sqlite`、应用 WAL pragma 并解析默认路径。

SQLite 适配器实现基于 promise 的 `exec`、`run`、`get`、`all`、`transaction` 与 `close`。`run`、
`get`、`all` 接收 SQL 文本加位置绑定；适配器可以按 SQL 文本缓存预编译语句。事务回调收到一个事
务句柄；事务里的所有工作必须使用它，回调 settle 后句柄失效。适配器必须把无关操作与其他事务排队
到该事务结束之后，所以在回调里调用 `database` 本身永远不会 settle：

```typescript
await database.transaction(async (transaction) => {
	await transaction.exec("CREATE TABLE example (value TEXT)");
	await transaction.run("INSERT INTO example (value) VALUES (?)", "stored atomically");
});
```

自定义后端可以用任何 Vitest 或 Jest 兼容运行器跑共享 conformance 套件：

```typescript
import { registerStorageConformance } from "@OnePanda-TgSec/tg-gibraltar/testing";
import { describe, expect, it } from "vitest";

registerStorageConformance({ describe, expect, it }, "My Storage", async (use) => {
	const storage = await openMyStorage();
	try {
		await use(storage);
	} finally {
		await closeMyStorage(storage);
	}
});
```

包根目录加载 TypeBox，因为工具任务用 `@OnePanda-TgSec/tg-ai` 的 `validateToolArguments()` 校验
参数。未打包时峰值 RSS 约 23 MB，tree-shaken 后约 4 MB。

## 示例

可运行示例在 [`test/examples`](test/examples)。在本包目录下运行其中一个：

```bash
node --conditions=source --experimental-strip-types test/examples/14-chat.ts
```

| 示例 | 展示 |
|---|---|
| [14-chat](test/examples/14-chat.ts) | 一问一答 |
| [16-real-model](test/examples/16-real-model.ts) | 从 OpenAI 流式回答 |
| [17-coding-tools](test/examples/17-coding-tools.ts) | SQLite 存储上一次用工具的 turn |
| [18-print](test/examples/18-print.ts) | 打印模式：提交提示词，打印回答 |
| [19-json](test/examples/19-json.ts) | JSON 模式：agent 事件或原始视图操作，SQLite 或内存 |
| [20-inbox](test/examples/20-inbox.ts) | 忙碌时的 steer、follow-up、write 与撤回 |
| [21-late-join](test/examples/21-late-join.ts) | 运行中途附着视图与事件流 |
| [22-subagent-foreground](test/examples/22-subagent-foreground.ts) | replay-safe 的 subagent 工具，其子会话归调用持有，事件缩进在调用下 |
| [23-subagent-background](test/examples/23-subagent-background.ts) | 常驻 subagent：生成、steer、停止、列出，回答回报，重启安全 |
| [24-child-tasks](test/examples/24-child-tasks.ts) | 拥有并等待四笔支付的 checkout：failFast、中止、重启 |
| [25-compaction](test/examples/25-compaction.ts) | 长对话在后台、手动、上下文溢出后压缩 |
| [26-coding-agent](test/examples/26-coding-agent.ts) | CodingTools、来自设置对象的活设置、跟随会话目录的环境 |
| [27-plan-mode](test/examples/27-plan-mode.ts) | 只读计划模式作为带自有文档的扩展，用 `configure()` 切换 |
| [28-reviewer](test/examples/28-reviewer.ts) | 有自有模型、扩展、工具、目录与评审循环的 reviewer 会话 |
| [29-sandbox-per-conversation](test/examples/29-sandbox-per-conversation.ts) | 每会话一个环境，从应用文档查得 |
| [30-tool-override](test/examples/30-tool-override.ts) | 部分会话的同名 bash，以及给胜出的 bash 计时的包装器 |
| [31-reload-and-restart](test/examples/31-reload-and-restart.ts) | 调用中途 reload 扩展，存储的选择跨重启存活 |
| [00](test/examples/00-conversation.ts)–[13](test/examples/13-recovery.ts) | 底下的各层：session、文档、fork、watch、Harness、agent 配置、reload、扩展状态、任务、恢复 |

调用 OpenAI 的示例需要 `OPENAI_API_KEY`；其余多数使用 faux provider。

## 设计文档

- [`docs/spec.md`](docs/spec.md)：规范性规格
- [`docs/pico-v5-handoff.md`](docs/pico-v5-handoff.md)：实现计划
- [`docs/pico-v5-chord-usage.md`](docs/pico-v5-chord-usage.md)：本包如何使用 Chord

基准：`bun run bench:storage`、`bun run bench:storage:memory`、`bun run bench:tool-output`。

## `tg.*` 标识符

Entry kind（`tg.user`、`tg.assistant`、`tg.tool-result`、`tg.system`、`tg.reset`、
`tg.compaction`）、文档 kind（`tg.agent`、`tg.live`、`tg.inbox`、`tg.usage`）与任务 kind
（`tg.generation`、`tg.tool`）是**持久化字符串**，不是包名。它们出现在存储的 transcript、文档表
与 SQLite 迁移里。

它们在上游是 `pi.*`，作为 TianGong house standard 的一部分改名为 `tg.*`。它们不是兼容垫片，也没
有别名：只有一个权威前缀，这个包版本写出的存储由这个包版本读取。如果你在迁移上游版本创建的存
储，打开前原地改写 kind 字符串。

## 来源

从 [pi agent](https://github.com/earendil-works/pi) 项目以 `@earendil-works/pi-durable` 身份采
用，改牌到 `@OnePanda-TgSec`。模块无增删重组，只有命名层改变。存储生命周期三方法（delete /
export / backup）、删除审计迁移（schema v3）与 `projectUsage` 聚合为本工作区新增。见工作区根目
录的 [`docs/provenance.md`](../../docs/provenance.md)。

## License

MIT
