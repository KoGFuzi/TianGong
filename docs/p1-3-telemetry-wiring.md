# P1-3 详细落地规划：telemetry 接线（第一批 span）

> 父规划：`docs/p1-usage-engineering.md` §3（已批）。本文档把已批摘要展开为可实施设计：
> 词表 schema 全文、挂点精确到行、包裹机制、断言矩阵、里程碑切分。
> 实施顺序与提交切分遵循父规划 §4 的步 4 / 步 5。

## 0. 决策记录

### 0.1 已拍板（2026-10-10）

- **D1 span 分层架构（用户拍板，取代摘要 §3.3 字面）**：采用方案 3——
  **gate 层 acquire span**（`tg.span.provider.acquire`，记排队与拒绝）+
  **model 层 request span**（`tg.span.provider.request`，记重试与推理），
  两者通过 Trace Context 自然串联为父子（`acquire ⊃ request`），零跨层标记。
  方案 4（业务调用方端到端 span）**不启用**：gate 挂点 `Models.holdSlot` 是自有代码，可直接开 span。
  具体落点（实施细化，D1 附则）：
  - acquire 落在 `packages/ai/src/models.ts` `Models.holdSlot`（L888-903），包 `limiter.acquire()`；
  - request 落在 `createProvider` 四个赋值点（`stream` L1165 / `streamSimple` L1166 /
    `generateImages` L1196 / `classify` L1211）——provider 边界，同时覆盖
    Models 目录路径与 compat/tg-messages **直调 provider** 路径（compat 对 builtin 模型
    直调 `builtinProvider.stream/streamSimple`，绕过 Models，见 `compat.ts` L263/L289）；
  - 父子串联：holdSlot 在 acquire span 回调内以 `{...requestOptions, telemetryContext: acquireSpan}`
    调用 `open()`——纯上下文传递，不是标记。
  - 父链形态（Models 路径）：`turn ⊃ acquire ⊃ request`；直调路径：`turn ⊃ request`（无 acquire）。
- **D2 `retried` 回写通道（用户拍板）**：`ProviderRequestOptions` 新增公开可选字段
  `onRetry?: () => void`（文档注明内部用途：provider 重试调度回调），8 个适配器调用点机械透传进
  私有 `ProviderRetryOptions`；request span 包装处注入计数，settled 时写 `retried: boolean`。
- **D3 词表四 span**：摘要 §3.2 批了 3 个；`tg.span.provider.acquire` 为方案 3 新增
  （命名取自拍板用词）。另有一处文档级修正：`tg.span.agent.tool` 的 `parents` 取
  `spans: ["tg.span.agent.turn", "tg.span.agent.tool"]`（嵌套工具调用的 span 父于工具 span，
  摘要只写 turn，见 §2.4）。
- **D4 词表载体**：schema 常量落 `packages/telemetry/src/spans.ts`（新文件），`src/index.ts` 再导出；
  机械断言（正则 + 可序列化 + typed starter 拒词表外）落 `packages/telemetry/test/spans.test.ts`（新文件）。
  依据：已批摘要 §5.3——词表以 `TelemetrySpanDefinition` schema 声明，span 名全部匹配
  `^tg\.span\.[a-z][a-z0-9.]*$`，词表外无 span 名可用。
- **D5 agent 两处事实修正**（对摘要 §3.3 的勘误，已核代码）：
  1. `AgentLoopConfig extends SimpleStreamOptions`（`agent/src/types.ts` L194），
     `telemetryContext` 随继承已存在——摘要说的「`AgentLoopConfig` 新字段」不需要。
  2. 摘要说 tool span 包 `runToolCall`；实际模型发起的调用走 `executeToolCallsSequential`（L531）/
     `executeToolCallsParallel`（L587），`runToolCall`（L879）只覆盖嵌套/外部调用。
     span 需逐路径覆盖（§2.4）。
- **D6 agent 新依赖边**：`packages/agent/package.json` 增加
  `"@OnePanda-TgSec/tg-telemetry": "^2.0.1"`（与 tg-ai 版本对齐；DAG 中 agent 在 telemetry 之上，
  合法）。`packages/chord/test/boundary.test.ts` 只护 chord 独立，与本次无关，无需改动。
- **D7 首批不包 `fetchDeferred` / `cancelDeferred`**：异步续答路径形状不同，词表未批，记入非目标。

### 0.2 实施期回填（实施时更新）

步 4（实现完成，门禁绿）：

- D1 落点与文档一致；实现新增 `packages/ai/src/utils/provider-spans.ts`，导出
  `providerRequestStream`（流式：同步开流、span 回调内转发并 await 流 settle）与
  `providerRequestResult`（images/classify：await 结果后写端属性）。
- `holdSlot` 拆出私有 `openSlot(bucket, open, signal, parent)`：无 telemetry 时以 `parent === undefined`
  直调 `open(undefined)`，与改前逐字节同形；有 telemetry 时 `startSpan("tg.span.provider.acquire", …)`
  并把 acquireSpan 作为 `telemetryContext` 交下层（§2.3 预期形态）。
- D2 触发点实现于 `provider-retry.ts` 两守卫之后、`abortableSleep` 之前，同步调用 `options.onRetry?.()`；
  8 调用点全部透传（`grep` 复核：anthropic-messages / azure-openai-responses / system-one-shared /
  llama-cpp-classify / openrouter-images / openai-completions / openai-responses / google-shared），
  另 `retryGoogleRequest` 的 `Pick` 扩入 `"onRetry"` 以覆盖 google-generative-ai / google-vertex 两个调用方。
- errorName 同步抛错路径按 §2.2-4 落在 `providerRequestStream` 的 `open()` catch，`error.name` 缺省
  `"ThrownValue"`，记录后原样重抛（同步语义不变）。
- 实测校正（记档）：适配器若以 `end()` 结束且不带终局消息，`inner.result()` 会挂起——这是 §5 已记风险，
  真实适配器都 push 终局事件；新增测试显式 push `done`/`error` 终局事件（含 gate 拒绝用例的收尾）。
- 依赖面：`models.ts` 由「仅类型引用 telemetry」变为运行时引用（`createTypedSpanStarter` /
  `NOOP_TELEMETRY_CONTEXT` / `TG_SPAN_SCHEMA`）。`test/models-entry.test.ts`、`test/lazy-module-load.test.ts`
  在子进程里按包 `exports` 解析 tg-telemetry，故门禁须先 `bun run build`（构建产物含新导出）。

步 5（实现完成，门禁绿）：

- 新增 `packages/agent/src/telemetry.ts`：`AgentSpanStarter = TypedSpanStarter<readonly [typeof TG_SPAN_SCHEMA]>`、
  `agentSpanStarter(context)`（`context ?? NOOP`，调用点不分支）、`turnStopReason(value)`（`pending` 落空，不写键）、
  `traceToolCall(starter, toolName, run, isError)`（开 span → await 结果 → 写 `isError`/status）。
- turn span 落点：`runLoop` 迭代体内，包「消息声明与 emit + `prepareRequest` + `streamAssistantResponse` +
  工具批执行与结果入列」；`finishTurn`、`turn_end`/`agent_end` emit 在 span 外。**边界细化**：
  `prepareNextTurn`（可能触发 compaction）留在 span 外——它是「下一轮准备」而非本轮推理/工具时长，
  与 §2.4「finishTurn 不在 span 内」同源；`turn_start` emit 仍在其原位置（`lastCompletedTurn` 分支内）。
  首个迭代无 `turn_start` 也照开 span（无条件开）。turn 的 `telemetryContext` 经
  `{...config, telemetryContext: turnSpan}` 交 `streamAssistantResponse`，故 request span 自然父于 turn。
- turn 失败态：`stopReason ∈ {error, aborted}` → `turnSpan.setStatus({status:"error", error:{name, message}})`，
  name 取消息 diagnostics 的首个 `error.name`，缺省 `"Error"`（`failureName`）。早退路径（error/aborted）
  与原代码等价：`finishTurn` → `turn_end(toolResults: [])` → `agent_end` → return；非早退路径不变。
- tool span 三路径 + truncated 全部覆盖：sequential（prepare+execute+finalize + 权限拒绝 immediate 分支）、
  parallel（immediate 分支即时包；prepared 分支的 deferred 闭包内包 execute+finalize，prepare 仍在 span 外——
  §2.4 已记注）、`failToolCallsFromTruncatedMessage`（每次调用 `isError:true`）。
  `emitToolExecutionEnd` 均在 span 外（与 §2.4 一致）。父子经 typed starter 的 `startChildSpan` 绑定 turnSpan。
- `runToolCall` 整体包 tool span；父上下文经**新增可选字段** `RunToolCallOptions.telemetryContext` 传入。
  **记档缺口**：`examples/mcp-codemode/createNestedToolRunner` 目前不传该字段（`Agent` 未暴露 telemetry 上下文），
  故该示例的嵌套调用暂不产生嵌套 span；接口已就位，宿主接入即可（不改 D5-1：`AgentLoopConfig` 无需新字段）。
- 默认路径：`NOOP` 直通（`agentSpanStarter(undefined)`），span 数为 0、事件序列不变（A3 对比断言）。
- 依赖面：`packages/agent/package.json` 增 `@OnePanda-TgSec/tg-telemetry`，`bun install --ignore-scripts` 重生 lockfile。
  agent 测试经既有 vitest alias 解析 telemetry 源码，无需新增 alias。

## 1. 调研事实（全部已核到行）

### 1.1 telemetry 契约（`packages/telemetry`）

| 事实 | 位置 |
| --- | --- |
| `TelemetryContext.startSpan(options, callback)`；callback 收 `TelemetrySpan`，span 继承 TelemetryContext（可作父） | `src/index.ts` L14-22 |
| `TelemetrySpan`：`addEvent(name, attrs?)` / `setAttributes(attrs)` / `setStatus(ok \| error{name,message})` | `src/index.ts` L18-22 |
| `NOOP_TELEMETRY_CONTEXT`：冻结 noop，callback 直通、异常原样 reject | `src/noop.ts` L3-20 |
| `InMemoryTelemetryContext`：记录 `RecordedTelemetrySpan{id, parentId, name, attributes, events, status, settled, endSequence}` | `src/memory.ts` L16-25 |
| schema 体系：`defineTelemetrySchema`（const 恒等）；span 定义含 `description / parents / startAttributes / endAttributes / events? / status`；start/event 属性有 `required`，**end 属性全可选** | `src/index.ts` L28-72 |
| `parents` 词法：`{kind:"any"}` \| `{kind:"root_or_external"}` \| `{kind:"spans", spans:[...]}` | `src/index.ts` L52-55 |
| `createTypedSpanStarter(context, schemas)` → `start(name, startAttrs, (span, startChildSpan) => …)`；**schema 仅类型推断，无运行时校验**；跨 schema span 重名是编译期错误 | `src/index.ts` L305-354 |
| `InMemoryTelemetryContext` 从包根再导出；`./testing` 子路径是 adapter conformance 基建 | `src/index.ts` L356-357 |

### 1.2 ai 层

| 事实 | 位置 |
| --- | --- |
| `ProviderRequestOptions.telemetryContext?: TelemetryContext` 已存在（"Explicit parent context for telemetry produced by this logical request"） | `src/types.ts` L135 |
| `StreamOptions extends ProviderRequestOptions<Model<Api>>` → `SimpleStreamOptions extends StreamOptions` → `AgentLoopConfig extends SimpleStreamOptions`：字段已全链存在 | `types.ts` L187/L350；`agent/src/types.ts` L194 |
| `createProvider` 四入口：`stream` L1165、`streamSimple` L1166（**独立 dispatch，无互调**）、`generateImages` L1196、`classify` L1211——单层包裹不会双生 span | `src/models.ts` |
| `AssistantMessageEventStream = EventStream<…, AssistantMessage>`：`settled()` 终态必 resolve、**永不 reject**；`result()` 终局事件后给出 AssistantMessage（error 事件的消息 stopReason="error"/"aborted"） | `src/utils/event-stream.ts` L48-124 |
| `AssistantMessage` 直接携带 `provider / model / api / usage{input,output,cacheRead,cacheWrite,cost.total} / stopReason / errorMessage / diagnostics?` | `src/types.ts` L546-570、L427-448 |
| `AssistantImages` / `ClassifierResult` 同样携带 `provider/model/usage?（可选）/stopReason/errorMessage`——request span 端属性四入口通用 | `src/types.ts` L621-631、L679-689 |
| `AssistantMessageDiagnostic.error.name` 可用（`extractDiagnosticError` 填 `error.name`）——流内 error 的 errorName 数据源 | `src/utils/diagnostics.ts` L3-15 |
| 重试（今日事实）：`retryProviderRequest(request, options: ProviderRetryOptions)`，options 仅 `{maxRetries?, maxRetryDelayMs?, signal?}`——**签名不含任何回调**，`onRetry` 为本规划新增（§2.2）；DEFAULT_MAX_RETRIES=2，发生在**适配器内部**；调用点 8 处（anthropic-messages L649、azure-openai-responses L122、system-one-shared L198、llama-cpp-classify L244、openrouter-images L72、openai-completions L370、openai-responses L183、google-shared L498） | `src/utils/provider-retry.ts` L13-17（私有 options 类型）、L115-134 |
| gate：`ConcurrencyLimiter` 只在 `Models.holdSlot`（L888-903，acquire→open→settled release）；**`Models.generateImages`/`classify` 不过 gate**（L997-1031） | `src/models.ts` |
| `Models.stream/streamSimple` 的 lazy 体内串 `applyAuth → holdSlot → provider.stream/streamSimple`（auth 在 gate 外） | `src/models.ts` L905-951 |
| `lazyStream` 体立即启动、只跑一次；失败转 error 事件（含 gate 拒绝——ConcurrencyLimitError 走此路） | `src/api/lazy.ts` L46-61 |
| compat：builtin 模型**直调** `builtinProvider.stream/streamSimple`（绕过 Models/gate），cloudflare 未鉴权时例外走 `compatModels` | `src/compat.ts` L255-292 |
| ai → telemetry 依赖已存在（`types.ts` L1） | `packages/ai/package.json` |

### 1.3 agent 层

| 事实 | 位置 |
| --- | --- |
| `runLoop`：外层 while（follow-up）+ 内层 while（一迭代 = 一个 turn）；provider 请求点 `streamAssistantResponse` L243；工具批 `executeToolCalls` L271；`turn_start` L208 / `turn_end` L288 | `src/agent-loop.ts` L164-322 |
| `streamAssistantResponse` 用 `{...config, apiKey, signal}` 调 `streamFunction`——config 展开已把 `telemetryContext` 带进流调用；turn span 只需显式覆盖为 turnSpan | `src/agent-loop.ts` L404-408 |
| 工具执行三路径：sequential L531 / parallel L587 / `runToolCall`（导出，嵌套调用）L879；共用 `prepareToolCall → executePreparedToolCall → finalizeExecutedToolCall`；权限拒绝走 `prepareToolCall` 的 `immediate` 分支（isError） | `src/agent-loop.ts` L531-661、L879-887 |
| parallel 模式 prepare 提前（eager L605），execute/finalize 在延迟闭包内（L620-641）——单 span 无法横跨两段 | `src/agent-loop.ts` |
| `failToolCallsFromTruncatedMessage`（L479）：截断消息的 tool call 不执行直接报错，但仍有 tool_execution_start/end 事件 | `src/agent-loop.ts` |
| 测试基建：`agent-loop.test.ts` 已有 `MockAssistantStream`/`createModel`/`createUsage`/假 streamFn 模式可复用 | `agent/test/agent-loop.test.ts` L22-60 |

## 2. 设计

### 2.1 词表 schema（`packages/telemetry/src/spans.ts`）

导出一个 `defineTelemetrySchema` 常量（暂定名 `TG_SPAN_SCHEMA`，实施时可定），四个 span：

**`tg.span.provider.acquire`**（D1 新增）

| 项 | 值 |
| --- | --- |
| description | Concurrency-gate admission for one provider request：排队等待与拒绝 |
| parents | `root_or_external` |
| startAttributes | `provider`：string，required，cardinality low（ProviderId） |
| endAttributes | （空——拒绝经 status.error 表达） |
| status | default ok；errorWhen「并发门拒绝（ConcurrencyLimitError）或等待被 abort」 |

**`tg.span.provider.request`**（摘要 §3.2 已批）

| 项 | 值 |
| --- | --- |
| description | 一次完整 provider 逻辑调用（含适配器重试与流式推理全程） |
| parents | `root_or_external`（实际形态：acquire 之下 / turn 之下 / 独立根） |
| startAttributes | `provider`（req，low）、`api`（req，low——Api/ImageApi/ClassifierApi id）、`model`（req，low——catalog id，如 `claude-sonnet-5-5`，自由文本禁入） |
| endAttributes | `stopReason`（values：stop/length/toolUse/error/aborted/deferred；完成消息不会出现 pending）、`retried`（boolean）、`tokens.input/output/cacheRead/cacheWrite`（number×4）、`cost.total`（number）、`errorName`（string，low） |
| status | default ok；errorWhen「stopReason 为 error/aborted 或调用抛出」 |

**`tg.span.agent.turn`**（摘要已批）

| 项 | 值 |
| --- | --- |
| parents | `root_or_external` |
| startAttributes | `provider`（req）、`model`（req），同上规则 |
| endAttributes | `stopReason`（同上 values）、`toolCallCount`（number） |
| status | default ok；errorWhen「turn 以 error/aborted stopReason 结束」 |

**`tg.span.agent.tool`**（摘要已批；parents 按 D3 修正）

| 项 | 值 |
| --- | --- |
| parents | `spans: ["tg.span.agent.turn", "tg.span.agent.tool"]`（嵌套工具调用父于工具 span） |
| startAttributes | `toolName`（req，low——工具名由工具集限定） |
| endAttributes | `isError`（boolean） |
| status | default ok；errorWhen「工具执行失败、被拒绝或调用抛错」 |

隐私边界（已批死规矩）落进每个属性的 `description`：只放计数与枚举，不进 prompt 文本、工具参数、路径；
`model` 用 catalog id。所有属性 `sensitive` 不显式标（无敏感属性），cardinality 全 low。

### 2.2 ai 层 request span 机制（步 4 主体）

包裹点：`createProvider` 四入口。以 `stream` 为例（其余三入口同构）：

1. 父上下文：`const telemetry = options?.telemetryContext ?? NOOP_TELEMETRY_CONTEXT`；
   `const startSpan = createTypedSpanStarter(telemetry, [TG_SPAN_SCHEMA])`。
2. startSpan 回调**同步返回** EventStream（保持 `provider.stream` 同步签名）；
   回调内挂 `void stream.settled().then(closeSpan)`（floating，settled 永不 reject——已核）：
   - `const message = await stream.result()`（终局事件必带消息；settled 后 result 必 resolve——已核 lazy 错误路径也 push error+end(message)）；
   - `span.setAttributes({stopReason, tokens.*, cost.total, retried, errorName})`；
   - `stopReason === "error" \|\| "aborted"` → `span.setStatus({status:"error", error:{name: errorName ?? "Error", message: message.errorMessage ?? ""}})`；
     否则不设（schema default ok）。
3. `retried` 通道（D2 的实施细化）：
   - 私有类型扩展：模块私有接口 `ProviderRetryOptions`（provider-retry.ts L13-17，未导出）新增
     `onRetry?: () => void`——不导出、不进公开类型面；公开面只有 `ProviderRequestOptions.onRetry` 一处；
   - 机械透传：8 个适配器调用点（§1.2 清单）各在自建的 retry options 对象上加 `onRetry: options.onRetry`；
   - 触发点约束：在「未 abort 且判定可重试且剩余次数 > 0」**之后**、`abortableSleep` **之前**同步调用——
     计数 = 重试决策数，同步触发使计数不依赖 abort 与 sleep 解的竞态；重试耗尽后的末次失败不再触发
     （决策未通过）；
   - 包装处 `let retries = 0`，以 `{...options, onRetry: () => { retries++ }}` 调下层；closeSpan 写
     `retried: retries > 0`。
4. `errorName` 规则：dispatch/构造期同步抛错 → catch 中 `error instanceof Error ? error.name : "ThrownValue"`，
   setStatus 后**原样重抛**（保持既有同步抛出行为）；流内 error →
   `message.diagnostics?.find(d => d.error?.name)?.error?.name`（无则省略属性，status 仍 error）。
5. `streamSimple`：同构（返回值相同生命周期）。`generateImages`/`classify`：函数本身 async，
   回调直接 await 下层调用，结果上取 `usage?`/`stopReason`/`errorName`（结果错误对象
   经 `imageErrorResult`/`classifierErrorResult` 编码——错误名同样先查 diagnostics 形态，实施时以实际形状断言）。
   **usage 缺省规则**：结果无 `usage` 时**不写入任何 `tokens.*`/`cost.total` 键**（不是写 0）——
   写 0 会伪造「提供方报告了 0」的语义，缺省即缺席。

NOOP 路径：四入口默认走 NOOP 直通，零分配变化之外无行为差异（测试 T5 锁）。

### 2.3 gate 层 acquire span 机制（步 4 主体）

挂点：`Models.holdSlot`（models.ts L888-903）。结构：

```
startSpan("tg.span.provider.acquire", { provider: bucket }, async (acquireSpan) => {
   await this.limiter.acquire(bucket, signal)      // ← 排队等待在 span 内；拒绝/abort → span error，原样上抛
   …原 try/open/catch 与 settled-release 逻辑不变…
   但 open() 以 {...requestOptions, telemetryContext: acquireSpan} 调用
})
```

- 父子串联：`Models.stream/streamSimple` 的 lazy 体内，`holdSlot` 调用点的 `open` 闭包改为
  `() => provider.stream(requestModel, transcript, { ...requestOptions, telemetryContext: acquireSpan })`
  ——即 holdSlot 签名把 open 改成接收父上下文（内部实现细节，不动公开签名语义）。
- 拒绝路径：acquire 抛 ConcurrencyLimitError → acquire span error（errorName=ConcurrencyLimitError），
  **无 request span**（未发生 provider 请求）；lazyStream 转 error 事件的既有行为不变。
- auth 时间在两 span 之外（既有顺序：auth → gate → provider），记档不争辩。
- `generateImages`/`classify` 无 acquire（不过 gate，by design——D8 记注）。

### 2.4 agent 层 turn/tool span（步 5 主体）

**父链**：`runLoop` 在 turn 边界用 `config.telemetryContext ?? NOOP` 开 turn span；span 回调内：
- 调 `streamAssistantResponse` 时显式 `telemetryContext: turnSpan`（覆盖 config 展开值）→
  Models 路径自然形成 `turn ⊃ acquire ⊃ request`；
- 工具 span 经 typed starter 的 `startChildSpan`（父于 turnSpan）发起。

**turn 边界**：一个内层迭代一个 span——从迭代体起点（首个迭代无 `turn_start` 事件，span 照开）
到工具结果入列（L279）为止；`finishTurn` 回调与 `turn_end`/`agent_end` emit 在 span 外
（finishTurn 可能触发 compaction，不属于 turn 时长）。端属性在收尾时取
`message.stopReason` 与 `toolCalls.length`。error/aborted 早退路径（L246-257）在 span 内收尾并 setStatus。

**tool 边界**：每个 toolCall 一个 span，三条路径逐路径包裹（D5 修正），span 覆盖
`tool_execution_start` 之后到 `emitToolExecutionEnd` 之前的 prepare→execute→finalize 连续区段：
- sequential（L542-570）：prepare+execute+finalize 连续，整体包（含权限拒绝的 immediate 分支——已批测试 A2 要求）；
- parallel：immediate 分支（L606-618）eager 包；prepared 分支在延迟闭包内包 execute+finalize
  （prepare 在 eager 循环提前发生，span 不含 prepare 时长——记注此非对称）；
- `runToolCall`（L881-886）：整体包（嵌套工具调用父于当前工具 span）。
- `failToolCallsFromTruncatedMessage`：每个被_fail 的调用也出 span（`isError: true`）——
  与事件流对称；实施时若结构过绕可改为只包 emit 对，文档记注。
- 端属性：`isError` 取 finalized outcome；toolName 取 start 属性。

**继承**：嵌套 runner 经 config spread 自动继承 `telemetryContext`（已批摘要同款机制，代码事实支持）。

### 2.5 与已批摘要的偏差清单（全部已拍板或记档）

| # | 摘要字面 | 实际 | 处置 |
| --- | --- | --- | --- |
| 1 | §3.3 createProvider 包一层 span，外层包住 retry + gate | 双 span：acquire（gate）+ request（provider 边界），父子串联 | D1 用户拍板（2026-10-10），取代字面 |
| 2 | §3.3 `AgentLoopConfig` 新字段 `telemetryContext` | 字段随 `extends SimpleStreamOptions` 已存在 | D5-1 勘误，零新增 |
| 3 | §3.3 tool span 包 `runToolCall` | 三路径逐路径包裹 | D5-2 勘误 |
| 4 | §3.2 tool span parents = turn | turn + tool（嵌套调用） | D3 文档级修正 |
| 5 | §3.2 词表 3 span | 4 span（+acquire） | D1/D3 拍板 |

## 3. 测试矩阵

测试只断已观察行为（house 规则）；探针先行。

### 3.1 `packages/telemetry/test/spans.test.ts`（新，步 4）

| 用例 | 断言 |
| --- | --- |
| V1 词表正则 | 全部 span 名匹配 `^tg\.span\.[a-z][a-z0-9.]*$`（已批 §5.3 机械校验） |
| V2 词表可序列化 | `JSON.stringify(TG_SPAN_SCHEMA)` 不抛；每 span 有非空 description 与 status.errorWhen |
| V3 编译期拒绝 | `expectTypeOf` + `@ts-expect-error`：typed starter 起词表外 span 名 / 缺 required start 属性 / stopReason 传闭集外值——均编译失败（沿用 `telemetry.test.ts` L60-71 模式） |

### 3.2 `packages/ai/test/telemetry.test.ts`（新，步 4）

基建：`createProvider` + 内存假 `ProviderStreams`（自产 EventStream），`InMemoryTelemetryContext` 断言。
| 用例 | 断言 |
| --- | --- |
| T1 request span 基础 | `provider.stream` 一次调用 → 恰 1 个 request span；start 属性 provider/api/model；settled 后 end 属性 stopReason/tokens.*/cost.total；status ok |
| T2 acquire ⊃ request 父子 | 经 `Models.stream`（providerConcurrency 默认）→ 2 span，parentId 串联；事件序列与无 telemetry 时一致 |
| T3 retried | 假适配器内调真 `retryProviderRequest` 三形态：(a) 首次抛可重错（带 retryable headers）后成功 → `retried: true`、status ok；(b) 直通成功 → `retried: false`；(c) **重试耗尽仍失败**（maxRetries=1，两次均抛可重错）→ `retried: true`、status error，且末次失败不计新决策（守卫不通过，onRetry 不触发） |
| T4 gate 拒绝 | limit=1 先占坑不 settle，第二个请求 → 仅 1 个 acquire span 且 status error、errorName=ConcurrencyLimitError；**无** request span；外层收到 error 事件（现状行为不变） |
| T5 NOOP 默认 | 不配 telemetryContext → 事件序列与现状逐事件相等（InMemory vs 基线各跑一遍比对），零 span 产生 |
| T6 流内 error | 假适配器 push error 事件 → request span status error、errorName 来自 diagnostics（同步抛错路径另断 Error.name） |
| T7 images/classify | 两入口各出 request span、**无** acquire；usage 缺省的结果**不产生任何 `tokens.*`/`cost.*` 键**（不断言写 0） |

### 3.3 `packages/agent/test/telemetry.test.ts`（新，步 5）

复用 `agent-loop.test.ts` 的 MockAssistantStream/createModel/假 streamFn 基建。
| 用例 | 断言 |
| --- | --- |
| A1 span 树 | 带工具的 turn：`turn ⊃ acquire ⊃ request`、`turn ⊃ tool(n)`；turn 属性 provider/model/stopReason/toolCallCount；tool 属性 toolName/isError=false |
| A2 权限拒绝 | onPermissionAsk 拒绝 → tool span 仍产生且 isError=true（已批 §3.4-4） |
| A3 默认零副作用 | 不配 telemetryContext → 事件序列与现状一致、零 span |
| A4 早退 | 流内 error 的 turn → turn span status error；provider request span error（嵌套正确） |

既有 suite 回响：`agent-loop.test.ts` 全绿（span 代码不得改变任何事件时序）；`ai` 既有 provider 测试全绿（`onRetry` 可选注入不得改变默认重试行为）。

## 4. 里程碑与提交切分（照父规划 §4）

| 步 | 内容 | 提交 | 门禁 |
| --- | --- | --- | --- |
| 4 | spans.ts 词表 + spans.test；Models.holdSlot acquire + 父子串联；createProvider 四入口 request 包裹 + settled 收尾 + errorName 规则；`ProviderRequestOptions.onRetry` + provider-retry.ts 私有 options + 8 适配器透传；ai/test/telemetry.test.ts；telemetry、ai CHANGELOG | `feat(ai,telemetry): wire the first provider request spans` | check + build + test 全绿 |
| 5 | agent-loop turn/tool span（三路径 + truncated）；agent/package.json 加 tg-telemetry 依赖（bun install 重生 bun.lock）；agent/test/telemetry.test.ts；agent CHANGELOG | `feat(agent): wrap turns and tool calls in telemetry spans` | check + build + test 全绿 |

每步一个 commit；CHANGELOG 入 `## [Unreleased]` → `### Added`。

## 5. 风险与逃生舱

| 风险 | 缓解 |
| --- | --- |
| request span 的 floating settled 钩子若漏挂，span 永不收尾 | T1/T2 断言 `settled === true`（InMemory 记录该位）；代码内注释标明契约 |
| `result()` 在 `end()` 无终局消息的违规路径挂起 | 已核：全部内置路径（push 终局事件 / lazy error）都带消息；钩子内 `settled().then(result)` 顺序保证；假适配器测试锁 |
| onRetry 公开字段被外部误用 | description 注明内部用途；不改任何默认行为（T3/T5） |
| parallel 工具 span 的非对称（prepare 在 span 外） | §2.4 记注；A1 断言 span 数量与父子，不断时长 |
| acquire span 增加一次 startSpan 调用开销 | NOOP 直通零开销；InMemory 仅测试用 |

## 6. 非目标（本期不做）

已批 §3.5：不接 OTel SDK exporter；不做采样/批量导出/进程外转发；tui 不挂 span。
本期追加：`fetchDeferred`/`cancelDeferred` 不包（D7）；gate 的 inflight 指标不进属性；
`retryAssistantCall`（`utils/retry.ts` L186）仍不接线（父规划 §6）。

## 7. 开放问题与实施自检（实施期回填）

开放问题：（空——两个拍板分歧已决；若实施中发现词表属性与真实结果形状不合，回写 §0.2 并同步修订测试断言。）

实施自检（步 4 提交前逐项打勾，防机械遗漏）：

- [x] **8 调用点透传完整性**：`grep -rn "retryProviderRequest(" packages/ai/src/api` 仍恰为 8 处；
      逐处确认自建 options 含 `onRetry: options.onRetry`（或等价透传）——anthropic-messages、
      azure-openai-responses、system-one-shared、llama-cpp-classify、openrouter-images、
      openai-completions、openai-responses、google-shared
- [x] **触发点位置核对**：`onRetry` 在两个守卫通过之后、`abortableSleep` 之前，同步调用（决策点计数）
- [x] **T3 三形态**（直通成功 / 重试后成功 / 耗尽仍败）全绿
- [x] **usage 缺省规则**：generateImages/classify 无 usage 的结果不产生任何 `tokens.*`/`cost.*` 键

步 4 门禁：`bun run check`、`bun run build`、`bun run test` 全绿（8 package suite 通过）。

实施自检（步 5 提交前逐项打勾）：

- [x] **三路径 + truncated 全覆盖**：sequential / parallel（immediate 与 deferred 两分支）/
      `failToolCallsFromTruncatedMessage` / `runToolCall`
- [x] **父子树核对**：`turn ⊃ acquire ⊃ request`、`turn ⊃ tool`（A1）；`runToolCall` 父上下文经
      `RunToolCallOptions.telemetryContext`（缺口见 §0.2）
- [x] **A1-A4** 全绿；既有 `agent-loop`/`permission`/`agent` 套件全绿（事件时序未变）
- [x] **默认零副作用**：不配/NOOP 上下文 → span 数为 0、事件序列与无 telemetry 逐类型相等（A3）

步 5 门禁：`bun run check`、`bun run build`、`bun run test` 全绿（8 package suite 通过）。
