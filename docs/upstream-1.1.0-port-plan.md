# 上游 pi 1.0.1 → 1.1.0 移植工程基线（tg-ai / tg-agent-core）

> 生成于 2026-10-11。本文件是 `tg-ai` 与 `tg-agent-core` 两包从上游 pi agent 1.0.1 升级到 1.1.0 的
> **唯一 cherry-pick 与回滚基线**，取代 [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)
> 中这两包的「推荐」列（该表对 `tg-gibraltar` / `tg-tui` 仍然有效）。
>
> 每个条目标注三项：**来源版本**（上游 changelog 版本）、**上游类型**（Added / Fixed / Changed / Breaking）、
> **本地兼容性结论**（在本仓库落地是否 breaking、是否触及持久化契约、测试面大小）。所有 file:line 均按
> 当前 `V2` 分支实测核对（commit `1cca963`）。
>
> 落点分支：**V2**（当前开发分支）。`v1` 是交付分支且已冻结，本档案任何条目不直接落 `v1`；
> 符合 v1 修复资格的子集在第 9 节单独标注，是否回移植另议。

---

## 0. 基线勘误（先读）

审核表第 38 行将「stream 函数必须返回 `AssistantMessageEventStream`」列为 1.1.0 待移植 Breaking。
**实测结论：该项已随 V1 导入（commit `5614f77`）完整落地，不是待移植项。**

- `packages/ai/src/utils/event-stream.ts:111-125` 已有该类；`types.ts:291-304`、`:365-380`、`models.ts:211-227`、
  `compat.ts:73-83`、`packages/agent/src/types.ts:34-38` 均已声明为强制返回类型。
- 10 个 API 适配器、`lazy.ts`、`provider-spans.ts`、`faux.ts`、`packages/gibraltar/src/harness/generation.ts:399-407`
  及约 35 个测试文件全部已在 `.result()` / `for await` 上。

因此上游 1.1.0 的这条 Breaking 在本地只剩两个残点，均划入批次 2：

1. `packages/agent/src/proxy.ts:20-31` 自建 `ProxyMessageEventStream`（构造体与 `AssistantMessageEventStream`
   逐字节相同的私有副本），`streamProxy()` 返回它——见 B2-3。
2. `packages/ai/src/api/lazy.ts:25-38` 内层仍以裸 `AsyncIterable` + `hasResult()` 鸭子探测衔接（刻意设计：
   `end()` 无值时 `result()` 会永久挂起）——**保留不动**，非移植项。

### 实施期勘误（2026-10-11，落地时以实测为准）

1. **B2-2 打点位置**：本档第 201 行要求「每个 `stream()` 入口取 `startedAt`，终态赋值处打点」，表格列的是
   各适配器 `output.stopReason = ...` 的行号。实测更优且更简单的落点是**终态事件推送前一行**
   （`stream.push({ type: "done"/"error", ... })` 之前），理由有二：其一，量到 `done` 推送为止的窗口才真正
   覆盖整个请求，而在 `stopReason` 首次赋值时打点会截掉内容定稿的尾巴；其二，`openai-responses-shared.ts`
   的 `finalizeResponse` 只赋值 `stopReason`、**不推送终态事件**，终态推送在
   `openai-responses.ts` / `azure-openai-responses.ts` / `openai-codex-responses.ts` 三个调用方，
   故在调用方打点即可把 `startedAt` 留在 `stream()` 闭包内，**不必给共享函数加参数**。
   实际改动：10 个 API 文件 + `faux.ts` + `tg-messages.ts` + `lazy.ts`（每文件 `startedAt` 一处、终态推送前
   各一处），共 22 个打点；`transform-messages.ts` 合成 toolResult 按本档省略不动。
2. **B2-3 前置条件（本档遗漏）**：`AssistantMessageEventStream` 在包根**不是值导出**。`src/types.ts:15`
   有 `export type { AssistantMessageEventStream } from "./utils/event-stream.ts";`，与 `index.ts` 的
   `export *` 同名；类型别名遮蔽了 `event-stream.ts` 的值导出，`tsc` 报 TS1485/TS1362（值不可达）。
   因此 B2-3 需附一条 `packages/ai/src/index.ts` 显式值导出 `export { AssistantMessageEventStream } from ...`
   才能编译。该缺陷此前无消费方触碰，属随本条一并修复的既有隐性缺陷。
3. **提交粒度（可编译性修正）**：第 7 条（frame 保字段）必须先有 `AssistantMessage.durationMs` 类型才可编译，
   故第 7 条含「`AssistantMessage.durationMs` 类型 + `cloneStartMessage` 保字段 + 往返测试」；第 8 条含
   「`ToolResultMessage.durationMs` 类型 + 22 处打点 + faux/tg-messages/lazy」。两条各自独立可 revert。
4. **B3-1 合并点实现形态**：本档第 340 行要求「解析出等级参数并以 … 的优先级并入三处合并点（建议收口为
   单一辅助函数）」。落地把收口点放在 `buildBaseOptions()`：新增内部函数
   `resolveSamplingParams(model, level, requestParams)`，先把模型默认值与等级参数并入返回的
   `StreamOptions.samplingParams`，于是三处合并点
   （`Object.assign(params, model.samplingParams, options?.samplingParams)`）**原文不动**即自然满足
   「模型 < 等级 < 请求」的优先级——三处消费的正是 `options.samplingParams`，而 `buildBaseOptions()` 是它的
   唯一构造点，改一个构造点比改三处消费点更不易漏。等级键取 `clampThinkingLevel()` 的钳制结果并以 `"off"`
   兜底（`clampedReasoning ?? "off"`）：`SimpleStreamOptions.reasoning` 是 `ThinkingLevel`、不含 `"off"`，
   非推理模型与「未指定等级」两种情形都经钳制落到 `"off"`；直接 `stream()` 调用不可见等级，故不解析等级
   参数（该界限已由测试钉住）。新增导出仍留在内部模块 `api/simple-options.ts`，不进包根。
5. **B3-2 测试面（本档只给落点）**：`anthropic-adaptive-thinking-models.test.ts` 的第二个断言要求「全部已标记
   模型必须命中允许集正则」，故加入 `haiku-5` 的同时必须把 `haiku[-.]5` 加进该正则，否则该断言反转失败；
   期望表补入实测新标记的 6 个条目（`anthropic` / `github-copilot` / `opencode` / `opencode-go` /
   `openrouter` / `vercel-ai-gateway`）。实测新标记的 `anthropic-messages` haiku-5 条目
   `thinkingLevelMap` 仍为 `undefined`——第 353 行的「自动跟随」指晋升判定本身；`openrouter` 那条的等级表
   此前已由 models.dev `reasoning_options` 提供，本次只为它新增 `forceAdaptiveThinking`。
6. **B4-1 落地形态（细化本档落点）**：(a) 改名只在 **provider** 层——`providers/azure-openai-responses.ts`
   （+ `.models.ts`）→ `providers/azure.ts`（+ `azure.models.ts`），导出 `azureProvider` 与
   `AZURE_MODELS` / `AZURE_IMAGE_MODELS` / `AZURE_CLASSIFIER_MODELS`；`azure-openai-responses` **api id、
   `AZURE_OPENAI_*` 环境变量与 `api/azure-openai-responses.ts`（+ `.lazy.ts`）文件名全部不变**，`types.ts` 的
   `KnownApi` / `ApiOptionsMap` 与 `index.ts` / `compat.ts` / `legacy-api-aliases.ts` 亦不动（只改
   `KnownProvider`、`env-api-keys.ts` 的 provider key、`providers/all.ts` 与生成脚本、`models.generated.ts` /
   `providers/azure.models.ts` 重生成）。(b) 新增 `src/api/azure-openai-config.ts` 承载 `AzureEndpointOptions` /
   `resolveDeploymentName` / `resolveAzureBaseUrl` / `resolveAzureConfig`，Responses 适配器改为引入；
   `providers/azure.ts` 用 `azureStreams()` 包装 `openai-completions` 的 lazy api，在 `lazyStream` 内解析
   endpoint 与 deployment（部署名经 `onPayload` 覆写 `model`）。(c) 第 397 行的「`api/simple-options.ts`
   合并点」落点**未使用**：改名面不触合并点，本地 B3-1 已把等级参数收口在 `buildBaseOptions`，上游的那处是
   适配器级 `resolveSamplingParams`，两种形态等价，本次不引入 churn。(d) Foundry 增量 = 生成脚本新增
   `AZURE_DEEPSEEK_V4_THINKING_LEVEL_MAP` 与 `azureDeepSeekModels`（把 `deepseek-v4-pro` 克隆为
   `provider:"azure"` / `api:"openai-completions"`，Azure 价与 compat），加 `test/azure-openai-completions.test.ts`。
   (e) 凭据按本档倾向采纳「接受重新登录」：不做键重写，Breaking 条目在 CHANGELOG 写明。

---

## 1. 执行主线与批次结构

依赖序是唯一执行主线：**每个批次内部先 `tg-ai` 后 `tg-agent-core`**，因为 agent-core 的每一条改动都消费
tg-ai 的类型与行为。跨批次不并行；批次 4 条目彼此独立，可按场景单独触发。

| 批次 | 内容 | 性质 | 提交粒度 |
| --- | --- | --- | --- |
| 批次 1 | 非 Breaking 关键修复：OAuth 竞态、server_busy、Mistral 终止、context 估算、Radius 目录、定价层 | 纯修复，每条带回归测试 | 每缺陷一 commit |
| 批次 2 | 结构性变更：帧编解码白名单、`durationMs` 全链（ai + agent）、`streamProxy` 返回类型、测试断言合规 | 上游 Breaking / 本地非 Breaking（见各条） | **每条单独成 commit**，便于回滚 |
| 批次 3 | 按需增强：思考等级采样、Haiku 5.5、`LoginOptions.agentName` | Added，非 Breaking | 每条一 commit，按需启动 |
| 批次 4 | 全面引入、场景触发：Azure 改名 + Foundry、Bedrock HTTP/2 重试、openai-decisions 分类器 | 含真 Breaking | 每条一 commit，场景出现才启动 |

---

## 2. 批次 1：非 Breaking 关键修复（立即落地）

全部为 tg-ai 侧、单包可完成、互不依赖，可按任意顺序实现，但按下表顺序提交（缺陷严重度降序）。

### B1-1 OAuth token 刷新竞态 — 来源 1.0.3 · Fixed · 本地非 Breaking

**缺陷（已实测确认）**：`packages/ai/src/auth/credential-store-file.ts:222-228`：

```ts
const next = await fn(current);
if (next === undefined) return current;
signal.throwIfAborted();          // ← 位于写盘之前
record[providerId] = next;
// Write before honoring an abort past this point. A rotated refresh token must land on
// disk even if the request is cancelled, because the previous one may already be invalid.
await this.#writeRecord(record);
```

注释描述的意图与代码顺序相反：`fn` 是 `oauth.refresh()`（`auth/resolve.ts:126-142`、`models.ts:635-642`），
返回时服务端**已经轮换**了 refresh token；调用方 signal 在 `fn` 在途期间 abort，第 224 行把这次轮换直接丢弃，
下一次请求读到已作废的旧 token，`invalid_grant`。放大因素：`models.ts:497-506` 的
`supersedeProviderRefresh()` 会主动 abort 同 provider 在途刷新控制器，该 signal 恰好经
`modify(..., { signal })`（`models.ts:641`）传入——第二次 `Models.refresh()` 确定性地杀死第一次的轮换。

内存实现 `packages/ai/src/auth/credential-store.ts:49-50` 同样顺序错误。`#delete`（`:237-248`）顺序相同但无害。

**变更规格**：两处 `#modify` 把 abort 检查移到 `fn(current)` 调用**之前**（避免无谓发起刷新）；
`fn` 一旦返回新值，**无条件落盘**，注释意图随之成真。`models.ts` / `resolve.ts` 不动。

**回归测试**（`packages/ai/test/file-credential-store.test.ts`，现有 21 例均未覆盖此场景）：
deferred `fn` 在途时 abort 调用方 signal → `fn` 仍返回新凭据 → 断言 `read()` 得到**新**凭据且不抛。
先以 `bun -e` 实测现状（丢弃行为可复现）再写断言。

**回滚**：单 commit revert，安全。

### B1-2 `server_busy` / 容量错误误终止 turn — 来源 1.1.0 · Fixed（#10543）· 本地非 Breaking

**现状**：`server_busy` 全仓不存在。`packages/ai/src/utils/retry.ts:30-102`
`RETRYABLE_PROVIDER_ERROR_PATTERN` 已含 `overloaded`(L32)、`model is at capacity`(L34)、`server.?error`(L45)、
`500|502|503|504|520|524`(L38-43，**无 529**)，全不匹配 `server_busy`。误终止消费点：
`packages/gibraltar/src/harness/generation.ts:474-502`（重试判定 → `reason: "model_error"` 收尾）。
`packages/agent/src/agent-loop.ts:273,316-321` 本身零重试，任何 `error` 即终止 turn（已知缺口，本条不扩 scope）。

**变更规格**：`RETRYABLE_PROVIDER_ERROR_PATTERN` 追加 `"server.?busy"`、泛化的 `"at capacity"`、
状态码备选加 `529`。实现时核对两处旁路：(a) `api/openai-codex-responses.ts:123-137` 自带
`isRetryableError` 正则（`rate.?limit|overloaded|service.?unavailable|...`）是否同步加 `server.?busy`；
(b) `utils/overflow.ts:76-80` `NON_OVERFLOW_PATTERNS` 确认容量措辞不会被误判为上下文溢出。

**回归测试**：`packages/ai/test/retry.test.ts`，模板是 L73-78 的 Azure 峰值容量回归（#9669）。

**回滚**：单 commit revert，安全。

### B1-3 Mistral `finish_reason:"error"` 不重试 — 来源 1.1.0 · Fixed（#10487）· 本地非 Breaking

**现状**：`packages/ai/src/api/mistral-conversations.ts:932-933` 产出
`errorMessage: "Provider stopped with: error"`，不匹配任何可重试模式，最终在
`generation.ts:474-502` 以 `model_error` 终止。

**变更规格**：`RETRYABLE_PROVIDER_ERROR_PATTERN` 追加精确短语 `provider stopped with: error`。
作用域论证：该字面短语只在原始 finish reason **恰为 `"error"`** 时出现（Mistral 的 `finish_reason:"error"`）；
Google 同款措辞（`google-generative-ai.ts:280-281`、`google-vertex.ts:288-289`）的原始 reason 是
`SAFETY`/`RECIPATION` 等，永不等于字面 `error`，不受影响。`mapChatStopReason` 的消息文本**不动**，
故 `packages/ai/test/mistral-raw-stop-reason.test.ts:46-55` 原断言保持。

**回归测试**：`retry.test.ts` 加分类断言（"Provider stopped with: error" → retryable；
"Provider stopped with: SAFETY" → not retryable，钉死作用域）。

**回滚**：单 commit revert，安全。

### B1-4 context 估算 3.5 字符/token — 来源 1.1.0 · Fixed（#10497）· 本地非 Breaking

**现状**：`packages/ai/src/utils/estimate.ts:15` `CHARS_PER_TOKEN = 4`。

**变更规格**：改为 `3.5`。单常量；下游消费点 `api/simple-options.ts:12,15-19`（`clampMaxTokensToContext`）
与 `packages/gibraltar/src/harness/compaction.ts:263,317-318`（压缩切点选择）自动跟随，不需改动。

**回归测试**：`packages/ai/test/context-estimate.test.ts` 两处比率耦合断言需更新。
预期值（**实现时以 `bun -e` 实测为准，先探后写**）：L55-61 的 `tokens: 1_005` → 约 `1_149`、
`maxTokens: 4_899` → 约 `4_755`；L75-80 的 `trailingTokens: 1`（"tail" 4 字符）→ `2`。

**回滚**：revert 需连同测试期望一起回退；注意 revert 后 compaction 切点行为回摆，属预期。

### B1-5 Radius 目录覆盖而非合并 — 来源 1.1.0 · Fixed · 本地非 Breaking

**现状**：`packages/ai/src/providers/radius.ts:40-48` 是合并语义：静态 `data/radius.json` 打底、同 id 覆盖、
异 id 追加。默认网关 `https://radius.pi.dev` 下陈旧静态条目永久残留。

**变更规格**：网关 `/v1/config` 返回模型时**整体替换**基线；仅当无动态模型时回落静态基线。
`radius-config.ts`、`radius.models.ts` 不动。

**回归测试**：`packages/ai/test/radius-provider.test.ts:52-74` 现断言合并语义
（`:73` `toBeGreaterThan`），方向反转为「动态目录存在时 `getModels("radius")` 恰等于动态集」。
离线回落路径（L76-89）保持。

**回滚**：单 commit revert（含测试反转），安全。

### B1-6 prompt 长度定价层（计费修正）— 来源 1.1.0 · Fixed · 本地非 Breaking

**现状**：运行时机制已完备——`types.ts:1061-1076` `ModelCostTier`/`ModelCost.tiers`、
`models.ts:1294-1313` `calculateCost()` 取最高匹配阈值。缺口在**生成端**：
`packages/ai/scripts/generate-models.ts` 的 `getModelsDevCost()`（`:1259-1281`）只被调用三处
（`:1800` bedrock、`:2061` xai、`:2380` copilot）；Anthropic 段（`:1815-1831`）与 OpenAI 段（`:1854-1859`）
手搓 `cost` 并丢弃 models.dev `tiers`。实测 `data/anthropic.json` 中 10 个 adaptive 模型 `tiers` 全为 null。

**变更规格**：Anthropic、OpenAI 段改走 `getModelsDevCost()`；实现时先探 models.dev 是否实际提供这两家的
tier 数据（若无则该改动为合规性 no-op，仍值得落地以对齐上游管线）。其他 provider 段按上游 diff 逐段核对。
重新生成走 `bun run generate:models`——`models.generated.ts` 与 `providers/*.models.ts` 是 tracked 产物，
**只可再生成、不可手改**；`providers/data/*.json` 在 `.gitignore`。

**回归测试**：`generate-models-strict.test.ts`（确定性）；在 `anthropic-cache-write-1h-cost.test.ts`
或新文件加一条 tier 计费断言（构造带 `cost.tiers` 的模型，验证 `calculateCost` 跨阈值换档）。

**回滚**：revert 源码后**必须再生成**产物，不得手改回退。

---

## 3. 批次 2：结构性变更（每条单独成 commit）

顺序即依赖序：帧编解码修复必须先于 `durationMs` 落地，否则新字段从第一天起就被吞；
tg-ai 侧 `durationMs` 必须先于 tg-agent-core 侧。

### B2-1 `assistant-message-frame` 白名单吞字段（隐性 bug）— 来源 1.1.0（随 durationMs 引入的本地风险）· Fixed

**缺陷**：`packages/ai/src/utils/assistant-message-frame.ts:77-92` `cloneStartMessage()` 逐字段硬编码重建
`AssistantMessage`。任何新字段（含即将引入的 `durationMs`）会被 `AssistantMessageFrameEncoder.encode()`
的 `start` 分支**静默丢弃**。

**变更规格**：字段清单追加
`...(message.durationMs === undefined ? {} : { durationMs: message.durationMs })`。
实现时用 `bun -e` 走一遍 encode→`reduceAssistantMessageFrames()`（`:372-490`）确认重建路径不丢。

**回归测试**：`packages/ai/test/assistant-message-frame.test.ts` 加往返用例：带 `durationMs` 的消息
编码再还原后字段存活。

**本地兼容性**：非 Breaking（当前无该字段，纯前向兼容）。
**回滚**：可独立 revert；即便 B2-2 已落，revert 本条只回退「帧路径保字段」行为，消息对象本身不受影响。

### B2-2 `durationMs` 注入：tg-ai 侧 — 来源 1.1.0 · 上游 Breaking / **本地非 Breaking**（可选字段）

**决策（已定）**：`performance.now()` 单调时钟；在 10 个适配器的 `output` 上打点；字段**可选**。

**类型**（`packages/ai/src/types.ts`）：

- `:551-575` `AssistantMessage` 加 `durationMs?: number;`
- `:599-613` `ToolResultMessage` 加 `durationMs?: number;`

可选的理由：与 `:587` `NestedToolCallRecord.durationMs?: number` 同名先例一致；避免触碰约 50 个测试文件
里的消息字面量。上游标的 Breaking 源于其基线还是裸 `AsyncIterable` 返回，本地已越过该基线（见第 0 节）。

**时钟**：直接用全局 `performance.now()`（Bun/Node 均有），房内先例
`packages/codemode/src/runtime/host.ts:270,305`。**不新增 util 模块**（新增模块即新增导出面）。

**打点清单**（每个 `stream()` 入口取 `const startedAt = performance.now();`，终态赋值处补
`output.durationMs = performance.now() - startedAt;`）：

| 文件 | 终态赋值行 |
| --- | --- |
| `api/anthropic-messages.ts` | 822（正常）、894（error/abort） |
| `api/openai-completions.ts` | 580、692、714 |
| `api/openai-responses-shared.ts`（shared） | 445、591、595 |
| `api/openai-responses.ts` / `azure-openai-responses.ts` / `openai-codex-responses.ts` | 各自 error 路径 222 / 159 / 490 |
| `api/bedrock-converse-stream.ts` | 314、352 |
| `api/google-generative-ai.ts` | 226、228、295 |
| `api/google-vertex.ts` | 234、236、303 |
| `api/mistral-conversations.ts` | 622、173 |
| `api/tg-messages.ts` | `createEventConverter` 终态、`:323` `createErrorEvent` |
| `providers/faux.ts` | `:427-434` done/error 推送处；四个构造器（78/294/308/322）随 done 打点 |
| `api/lazy.ts:5-21` | `createSetupErrorMessage` → `durationMs: 0`（setup 失败，无请求窗口） |
| `api/transform-messages.ts:171-178` | 合成 toolResult 省略（可选字段） |

**不可行的替代方案（存档以防复议）**：在 `utils/provider-spans.ts:129-169` `providerRequestStream()` 单点打点
——`：135` `if (!isTelemetryActive(...)) return open(options);` 在 telemetry 关闭时短路返回内层流，
单点打点会随 span 缺席而丢字段。

**回归测试**：`packages/ai/test/faux-provider.test.ts`（`tokensPerSecond` 驱动、无网络）断言 done 消息
`durationMs` 为非负有限数；`message-types.test.ts:46` 处 `expectTypeOf` 补可选字段形状。

**持久化影响**：消息整体 JSON 落 gibraltar 行（`omitUndefinedProperties`），可选字段为纯增量，
**无 schema 迁移、`tg.*` kind 字符串不动**。

**回滚**：单 commit revert（类型可选，无调用方依赖）。注意先 revert B2-4 再 revert 本条（agent 侧字段源自此处）。

### B2-3 `streamProxy()` 返回 `AssistantMessageEventStream` — 来源 1.1.0 · 上游 Breaking / **本地仅类型、行为零变化**

**现状**：`packages/agent/src/proxy.ts:20-31` 私有类 `ProxyMessageEventStream` 与
`AssistantMessageEventStream` 构造体逐字节相同；`:120-124` 返回类型为该私有类。该类**未导出**，
加宽到公有类对调用方无任何 narrowing 损失；`result()` 本就继承自同一基类并被
`packages/agent/test/proxy.test.ts:63,92,112` 覆盖。`packages/agent/README.md:173` 已宣称此契约——
本条落地后文档与代码对齐。

**变更规格**（单文件）：

1. 删 `:19-31` 本地类；
2. `:125` 改 `new AssistantMessageEventStream()`（从 `@OnePanda-TgSec/tg-ai` 导入）；
3. `:120-124` 返回类型改 `AssistantMessageEventStream`；
4. `:10` 导入清单移除随之未使用的 `EventStream`。

**回归测试**：现有 `proxy.test.ts` 三例原样覆盖，无需新增。

**回滚**：单 commit revert，最安全的一条。

### B2-4 `durationMs` 注入：tg-agent-core 侧（全程窗口）— 来源 1.1.0 · 上游 Breaking / **本地非 Breaking**（可选字段）

**决策（已定）**：测量窗口为 **`tool_execution_start` 发出 → `tool_execution_end` 发出**，即含
`prepareToolCall`、`beforeToolCall`/权限判定、`tool.execute`、`afterToolCall` 的全程；字段可选；
时钟 `performance.now()`。

**类型**（`packages/agent/src/types.ts`）：

- `:461-483` `AgentToolResult` 加 `durationMs?: number;`（可选——`test/utils/calculate.ts:5`、
  `get-current-time.ts:4` 以 `interface extends` 继承它，必填会破两处）
- `:486-490` `AgentToolCallOutcome` 加 `durationMs?: number;`（runToolCall 公共 API 的载体）
- `:566` `tool_execution_end` 事件加 `durationMs?: number;`

**实现**（`packages/agent/src/agent-loop.ts`）：

1. 三处 `tool_execution_start` 发点（`:522` 截断失败路径、`:587` sequential、`:652` parallel）紧邻处取
   `const startedAt = performance.now();`
2. 每个 `FinalizedToolCallOutcome`（= `AgentToolCallOutcome`，`:749`）构造点补
   `durationMs: performance.now() - startedAt`：sequential 的 immediate 与 executed 两分支、
   parallel 的 immediate 与 deferred 两分支（含 `:679` aborted 分支）、截断失败路径、
   `runToolCall`（`:952-966`，无事件流，窗口为其 `traceToolCall` 闭包全程）
3. `emitToolExecutionEnd`（`:1061-1069`）带出 `finalized.durationMs`
4. `createToolResultMessage`（`:1071-1084`）将 `finalized.durationMs` 写入 `ToolResultMessage`
   （消费 B2-2 的字段位）

**范围界定**：`packages/gibraltar` 的 harness **自建** `ToolResultMessage`
（`harness/tool.ts:438-460`、`harness/context.ts:153-163`），不走 agent-core 循环，**不在本条链路**；
其 `startedAt/endedAt` 移植属审核表 gibraltar 批次，另行处理。

**测试影响**：`agent-loop.test.ts` 绝大多数为 `toMatchObject`（加字段安全）；`:2092-2193` `runToolCall`
describe 补 `durationMs` 非负断言；`:2168` `toEqual` 作用于 partial updates（不带该字段）不受影响；
`:1673-1688` 事件序列断言只 map `e.type`，安全。`examples/mcp-codemode/tools.ts` 只读
`structuredContent`/`isError`，不受影响。

**持久化影响**：agent-core 消费方的 transcript 行新增可选 JSON 字段，无迁移。

**回滚**：单 commit revert；须在 revert B2-2 之前。

### B2-5 测试断言合规 — 本地合规修复 · 非 Breaking

1. `packages/ai/src/auth/oauth/openai-chatgpt.ts:17` `const AGENT_NAME_HINT = "Pi";` 是 `src/` 内的上游
   残留品牌串，且不在 `check:house-standard` 四项豁免之列；`packages/ai/test/openai-chatgpt-oauth.test.ts:92`
   断言 `agent_name_hint === "Pi"` 与之绑定。改为 `"TianGong"` 并同步测试；B3-3 落地后该常量降级为默认值。
2. `packages/agent/CHANGELOG.md` `[Unreleased]` 下存在**两个** `### Added` 段（L5 与 L32），违反房规
   小节顺序；在为本档案追加条目时顺手归并为一个（文档整理，随 B2-4 的 changelog commit 走）。

**回滚**：条目 1 单 commit revert；条目 2 无独立回滚需求。

### B2-OPT（可选伴随项，默认不做）：`tg.span.agent.tool` 增加 `durationMs` end 属性

`packages/telemetry/src/spans.ts:113-132` 的 `TG_SPAN_SCHEMA`（`version: 1`）目前只有
`toolName`/`isError`。若要与 span 体系互补，需在 `traceToolCall`（`packages/agent/src/telemetry.ts:36-49`）
结算处补 `span.setAttributes({ durationMs })` 并扩 schema。**触发条件**：telemetry 消费方明确提出需要
span 级耗时；届时 schema 以增量 end 属性处理并评估版本号。不阻塞主线。

---

## 4. 批次 3：按需增强（Added，非 Breaking）

### B3-1 `samplingParamsByThinkingLevel` — 来源 1.0.2 · Added

**现状**：全仓无 `SamplingOptions` 类型。请求级 `types.ts:212` 与模型级 `:1134` 均为裸
`Record<string, unknown>`，合并点三处：`api/openai-completions.ts:1000`、`api/openai-responses.ts:383`、
`api/azure-openai-responses.ts:349`（`Object.assign(params, model.samplingParams, options?.samplingParams)`）。
**难点**：思考等级不在 `StreamOptions` 中，走 `SimpleStreamOptions.reasoning`（`:358`），由
`api/simple-options.ts:21-49` `buildBaseOptions()` 转换时不可见。

**变更规格**：`Model` 加
`samplingParamsByThinkingLevel?: Partial<Record<ModelThinkingLevel, Record<string, unknown>>>`；
`buildBaseOptions()` 接收 `reasoning`（或等价透传），解析出等级参数并以
**模型 `samplingParams` < 等级参数 < 请求 `samplingParams`** 的优先级并入三处合并点
（建议收口为单一辅助函数）。`packages/ai/test/sampling-options.test.ts` 已有 `makeModel(api, samplingParams)`
与 `onPayload` 捕获机制，直接扩展。

**触发**：需要按思考等级调采样（如 high 关温度）的运行时场景。

### B3-2 Claude Haiku 5.5 adaptive thinking — 来源 1.1.0 · Added

**现状**：`data/anthropic.json` **已有** `claude-haiku-5-5` 全条目（models.dev 自动到货，无需手工补丁），
缺 `compat.forceAdaptiveThinking` 与 `thinkingLevelMap`：`scripts/generate-models.ts:622-639`
`isAnthropicAdaptiveThinkingModel()` 匹配 `opus-4-6/4-7/4-8/5`、`sonnet-4-6/5`、`fable-5`、`mythos-5`，
**无 `haiku-5`**。

**变更规格**：判定函数加 `haiku-5`，`forceAdaptiveThinking`（`:1114-1116`）与 `thinkingLevelMap`
（`:1099-1113`）自动跟随；`bun run generate:models` 再生成。prompt 定价层若 models.dev 提供，经 B1-6 管线到货。
测试落点 `anthropic-adaptive-thinking-models.test.ts`。

**触发**：模型目录例行跟进，建议随批次 1 尾部顺手做（也可独立）。

### B3-3 `LoginOptions.agentName` — 来源 1.1.0 · Added

**现状**：`auth/types.ts:201-209` `LoginOptions` 仅 `getDeviceId`；唯一品牌串消费点
`openai-chatgpt.ts:250-263`（`agent_name_hint`）。

**变更规格**：`LoginOptions` 加 `agentName?: string`；`openai-chatgpt.ts:233-237` 读
`options?.agentName ?? AGENT_NAME_HINT`（透传链 `models.ts:773-787` → `auth/helpers.ts:55` 已天然携带
整个 options，无需改）；`cli.ts:46-68` 传 `agentName: "TianGong"`。
测试：`openai-chatgpt-oauth.test.ts` 两例（默认值 + 覆盖值）。

**触发**：B2-5 合规修复落地后，品牌串有可配置需求时。

---

## 5. 批次 4：全面引入、场景触发

三项均**纳入本基线**（相对审核表的「暂缓」为决策升级），但以实际场景出现为启动条件；
每项落地前须重读上游对应 diff 全文再裁剪。

### B4-1 Azure provider 改名 `azure-openai-responses` → `azure` + Foundry Chat Completions — 来源 1.0.3 · **真 Breaking**

**本地落点**：`api/azure-openai-responses.ts`（+ `.lazy.ts`）、`providers/azure-openai-responses.ts`
（+ `.models.ts`）、`api/simple-options.ts` 合并点、生成脚本 Azure 段、测试
`azure-openai-base-url.test.ts`、`azure-openai-responses-reasoning-replay.test.ts`、
`azure-openai-tool-choice.test.ts`、`azure-utils.ts`。

**主要兼容性风险（本地结论）**：凭据按 providerId 落盘（`credential-store-file.ts`），改名会**孤儿化已存的
Azure 凭据**。缓解：一次性凭据键重写，或接受重新登录（当前无 Azure 使用方，倾向后者）。
Foundry Chat Completions 为新增 api 模块，纯增量。

**触发**：出现 Azure / Foundry 接入需求。

### B4-2 Bedrock HTTP/2 断流自动重试 — 来源 1.0.4 · Fixed

**本地落点**：`api/bedrock-converse-stream.ts:298`（`for await (const item of response.stream!)`，AWS SDK 流）。
实现约束：中途已有部分输出的流**不可盲目整体重试**，须核对上游的重试前置条件（推测为首个内容事件前）。
配套测试 `bedrock-*.test.ts` 系列已相当齐备。

**触发**：启用 Bedrock 时（与 B4-1 独立）。

### B4-3 `openai-decisions` 分类器 API + `ClassifierContext.images` — 来源 1.1.0 · Added

**本地落点**：分类面已有基础设施——`api/llama-cpp-classify.ts`、生成脚本
`loadModelsDevClassifierModels()`（models.dev `?type=decision`）、`test/classifier-models.test.ts`。
移植为新增 `api/openai-decisions.ts` 适配器 + 分类上下文的 `images` 字段，纯增量。

**触发**：出现内容分类需求。

---

## 6. Cherry-pick 序（唯一基线）

提交顺序即下表；commit message 依房规
`{feat,fix,docs,refactor,chore}[(ai,tui,agent,gibraltar,chord,telemetry,mcp,codemode)]: <message>`。
每个 commit 落地前须通过 `bun run check` 与对应包 `bun run test`（见第 8 节）。

| # | Commit message | 条目 | 包 | 依赖 |
| --- | --- | --- | --- | --- |
| 1 | `fix(ai): persist rotated OAuth credentials when the caller aborts mid-refresh` | B1-1 | ai | — |
| 2 | `fix(ai): classify server_busy and 529 capacity errors as retryable` | B1-2 | ai | — |
| 3 | `fix(ai): retry Mistral finish_reason error terminations` | B1-3 | ai | — |
| 4 | `fix(ai): estimate context tokens at 3.5 chars per token` | B1-4 | ai | — |
| 5 | `fix(ai): replace the static Radius catalog with the gateway catalog` | B1-5 | ai | — |
| 6 | `fix(ai): emit models.dev pricing tiers for anthropic and openai` | B1-6 | ai | — |
| 7 | `fix(ai): carry durationMs through the assistant message frame codec` | B2-1 | ai | — |
| 8 | `feat(ai): stamp optional durationMs on assistant and tool result messages` | B2-2 | ai | #7 |
| 9 | `refactor(agent): return AssistantMessageEventStream from streamProxy` | B2-3 | agent | — |
| 10 | `feat(agent): add optional durationMs to tool execution outcomes and events` | B2-4 | agent | #8 |
| 11 | `fix(ai): rebrand the OAuth agent name hint and align its test` | B2-5 | ai | — |
| 12 | `feat(ai): add per-thinking-level sampling parameter overrides` | B3-1 | ai | — |
| 13 | `feat(ai): mark Claude Haiku 5.5 as an adaptive thinking model` | B3-2 | ai | #6（可选） |
| 14 | `feat(ai): add LoginOptions.agentName for branded OAuth consent` | B3-3 | ai | #11 |
| 15 | `feat(ai): rename azure-openai-responses to azure and add Foundry completions` | B4-1 | ai | 场景触发 |
| 16 | `fix(ai): retry Bedrock HTTP/2 stream interruptions` | B4-2 | ai | 场景触发 |
| 17 | `feat(ai): add the openai-decisions classifier API` | B4-3 | ai | 场景触发 |

说明：

- #7 与 #8 可合并审查但**分开提交**：#7 是前向兼容的编解码修复，#8 revert 时 #7 可独立留存。
- #9 与 #10 无相互依赖，但都在 #8 之后提交以保持批次内 tg-ai → tg-agent-core 顺序。
- 批次 3/4 的 # 仅为基线预留序号，实际触发时按当时 HEAD 重排，不插队到批次 1/2 之前。
- 每 commit 附带对应包 `CHANGELOG.md` `[Unreleased]` 条目（见第 8 节）。

## 7. 回滚矩阵

| 条目 | revert 单元 | 耦合与注意事项 |
| --- | --- | --- |
| B1-1 OAuth | 自身 | 无耦合；revert 后竞态缺陷回归，回归测试同 commit 反转 |
| B1-2 server_busy | 自身 | 与 B1-3 同文件（`retry.ts`），revert 互不影响（不同 pattern 条目） |
| B1-3 Mistral | 自身 | 同上 |
| B1-4 estimate 3.5 | 自身 + 测试期望 | revert 会回摆 gibraltar compaction 切点，属预期 |
| B1-5 Radius | 自身 + 测试反转 | 离线回落路径不受影响 |
| B1-6 定价层 | 源码 + **再生成产物** | 严禁手改 `models.generated.ts` 回退；必须 `bun run generate:models` |
| B2-1 帧编解码 | 自身 | revert 后若 B2-2 仍在，`durationMs` 在帧路径被吞（回到修复前状态），对象本身不受影响 |
| B2-2 durationMs(ai) | 自身 | **必须先 revert #10（B2-4）**；类型可选，无生产代码依赖字段存在性 |
| B2-3 streamProxy | 自身 | 最安全；恢复私有类副本即可 |
| B2-4 durationMs(agent) | 自身 | 先于 #8 revert；事件与 outcome 均为可选字段 |
| B2-5 合规 | 自身 | revert 恢复 `"Pi"`，同时违反 house standard——revert 前先确认动机 |
| B3-x / B4-x | 自身 | B4-1 revert 同样需再生成模型产物，并处理凭据键遗留 |

回滚验证：每次 revert 后跑 `bun run check` + 对应包 `bun run test`；B1-6 / B4-1 的 revert 额外跑
`bun run --cwd packages/ai generate-models --strict` 确认产物一致。

## 8. 验证协议（每 commit 强制）

1. `bun run check`（house standard + 格式 + 类型 + 相对导入）。
2. `bun run test packages/ai`（或 `packages/agent`；改动涉及两包则依序都跑）。
3. **禁止** `bun test`（绕过各包 Vitest/node:test 配置）。
4. 环境变量中有 endpoint/auth 配置时**禁止**从包根跑全套——e2e 会真花钱（`packages/agent/test/e2e.test.ts`
   按 env 激活）。
5. **先探后断言**：任何新测试断言的值（如 B1-4 的 1149/4755、B2-2 的 durationMs 取值范围）必须先用
   `bun -e` 对真实模块实测，再落进断言；`console.log` 探针不得随 commit 提交。
6. 每个修复类条目（批次 1 全部 + B2-1）的回归测试须**修复前失败、修复后通过**。
7. Changelog：`packages/ai/CHANGELOG.md` / `packages/agent/CHANGELOG.md` 的 `[Unreleased]`，
   按序并入 `Breaking Changes` / `Added` / `Changed` / `Fixed`；agent 包顺手归并重复的 `### Added` 段。
8. 行为手册：凡改动 `docs/ops-manual.md` 已描述的行为（重试判定、消息字段），同 commit 更新手册。
9. Git：显式路径 staging，禁 `git add -A`；只提交本会话改动；`git status` 核对后再提交。

## 9. 兼容性结论汇总表

| 条目 | 上游版本 | 上游类型 | 本地 Breaking | 持久化/存储影响 | 测试面 | v1 修复资格 |
| --- | --- | --- | --- | --- | --- | --- |
| B1-1 OAuth 竞态 | 1.0.3 | Fixed | 否 | 凭据文件行为修正，无格式变化 | +1 回归测试 | **有**（凭据生命周期缺陷） |
| B1-2 server_busy | 1.1.0 | Fixed | 否 | 无 | +1 回归测试 | 有（错误终止缺陷） |
| B1-3 Mistral 终止 | 1.1.0 | Fixed | 否 | 无 | +2 分类断言 | 有 |
| B1-4 估算 3.5 | 1.1.0 | Fixed | 否 | 无（估算值变化属修正） | 2 处期望更新 | 有 |
| B1-5 Radius 覆盖 | 1.1.0 | Fixed | 否 | 无 | 1 处断言反转 | 有 |
| B1-6 定价层 | 1.1.0 | Fixed | 否 | 生成产物再生成 | +1 tier 断言 | 有（计费错误） |
| B2-1 帧白名单 | 1.1.0（衍生） | Fixed | 否 | 帧路径新增字段透传 | +1 往返测试 | 有（数据丢失缺陷） |
| B2-2 durationMs(ai) | 1.1.0 | Breaking→**否** | 可选字段，JSON 行增量，无迁移 | +2 断言 | 无（新能力） |
| B2-3 streamProxy | 1.1.0 | Breaking→**否**（纯类型） | 无 | 0（现有覆盖） | 无 |
| B2-4 durationMs(agent) | 1.1.0 | Breaking→**否** | 可选字段，transcript 增量 | +2 断言 | 无 |
| B2-5 断言合规 | 本地 | Fixed | 否 | 无 | 1 处更新 | 无（品牌合规） |
| B2-OPT span 属性 | 1.1.0（衍生） | Added | 视 schema 版本决策 | 无 | 可选 | 无 |
| B3-1 等级采样 | 1.0.2 | Added | 否 | 无 | 扩展现有测试 | 无 |
| B3-2 Haiku 5.5 | 1.1.0 | Added | 否 | 模型产物再生成 | 扩展现有测试 | 无 |
| B3-3 agentName | 1.1.0 | Added | 否 | 无 | +1 用例 | 无 |
| B4-1 Azure 改名 | 1.0.3 | **Breaking** | **是**（凭据键孤儿化） | 凭据文件遗留键 | 多文件重命名 | 无 |
| B4-2 Bedrock 重试 | 1.0.4 | Fixed | 否 | 无 | 扩展 bedrock 系列 | 有（仅当启用 Bedrock） |
| B4-3 openai-decisions | 1.1.0 | Added | 否 | 无 | 新增 | 无 |

`tg.*` kind 字符串与 SQLite schema 在全部条目中**零变化**；gibraltar / tui 的移植（含
`Storage.order`/`ScanOrder`、`TaskRuntime.context()`、`startedAt`/`endedAt`、`Terminal.setProgramStatus`）
不在本档案范围，仍以审核表为准。

## 10. 与既有文档的关系

- [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)：调研来源与 gibraltar/tui 依据；
  其 tg-ai / tg-agent-core「推荐」列已被本基线取代。
- [`p1-3-telemetry-wiring.md`](p1-3-telemetry-wiring.md)：`AssistantMessageEventStream` 契约
  （`settled()` 不 reject、`result()` 给终态消息）仍是流类型语义的权威描述，本基线不改动该契约。
- [`provenance.md`](provenance.md)：vendored 包（codemode/mcp）1.1.0 re-sync 已完成，不在本档案范围。
