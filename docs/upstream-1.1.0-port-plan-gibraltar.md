# 上游 pi 1.0.1 → 1.1.0 移植工程基线（tg-gibraltar）

> 生成于 2026-10-11。上游参照物：`/run/media/J/Workspace/Code-Testing/pi-1.1.0/packages/durable`
> （`@earendil-works/pi-durable` 1.1.0，2026-10-07）。本文件是 `tg-gibraltar` 从上游 1.0.1 升到 1.1.0 的
> **唯一 cherry-pick 与回滚基线**，取代 [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)
> 中 `tg-gibraltar` 段的「推荐」列（该列对 `tg-tui` 仍然有效）。
>
> **两项决策升级（相对审核表）**
>
> 1. **`createPowerShellTool` 不暂缓**，纳入批次 3（决策与论证见 B3-5）。
> 2. **查询排序 `ScanOrder` 不再是「决策项」，直接加入**批次 2（论证与验收口径见 B2-1）：需求是
>    「最新任务优先」分页，而上游把同一机制铺到 conversation / entry / task / submission 四类扫描。
>
> 每个条目标注四项：**来源版本**（上游 changelog 版本）、**上游类型**（Added / Fixed / Changed /
> Breaking）、**本地落点**（本仓库实测 file:line）、**本地兼容性结论**（是否 breaking、是否触及持久化契约、
> 测试面大小）。本地行号按当前工作区（`V2`，commit `b6b0aa4`）实测；上游行号按上述 1.1.0 源码树实测。
>
> 落点分支：**V2**。`v1` 是交付分支且已冻结，本档案任何条目不直接落 `v1`；符合 v1 修复资格的子集在第 9 节
> 单独标注，是否回移植另议。
>
> 与 [`upstream-1.1.0-port-plan.md`](upstream-1.1.0-port-plan.md)（`tg-ai` / `tg-agent-core` 基线）的关系：
> B1-2 依赖该档案的 B2-2（`ToolResultMessage.durationMs` 类型先行）；其余条目互不依赖。

---

## 0. 基线勘误（先读）

审核表 `tg-gibraltar` 段的九行里，有五处与实测不符或口径不全。先纠正，再看批次。

1. **第 64 行「本地已有 schema v3，需叠加一版迁移」不成立。** 上游 1.1.0 的
   `src/storage/sqlite/migrations.ts:88` 仍是单条 `{ version: 1, statements: INITIAL_SCHEMA }`，1.1.0 **没有新增
   任何列**：`startedAt` / `endedAt` 只落在 `tasks.record` 这一列 JSON 里。本地的 v2（project 隔离）与 v3
   （删除审计）是本仓自有迁移，与上游无交集。**结论：本包全部条目零 schema 迁移，`storage.health()` 的
   `schemaVersion` 恒为 3。**
2. **工具结果 `durationMs` 与助手消息 `durationMs`（同 #10549）审核表未单列。** 上游在
   `src/harness/tool.ts:254-262` 打点、经 `:386-391` / `:463-476` 写进 `pi.tool-result` 消息；助手消息那一侧纯由
   `tg-ai` 盖章（ai 基线 B2-2），gibraltar 无需改动。本档案补为 B1-2。
3. **`settings.progress`（1.0.3）不是新机制，且本地实现比预想更完整。** 本地 `output.ts:208-274` 已有
   `MIN_PROGRESS_INTERVAL_MS = 100` + 按字节量反压（`PROGRESS_BYTES_PER_SECOND = 100 * 1024`）的自适应
   progress 提交，`generation.ts:108` 的 partial 节流同为 100ms。逐行 diff 后，本条的真实增量只剩四件：
   ① `Progress` 构造收 `minIntervalMs`（删 `MIN_PROGRESS_INTERVAL_MS` 常量）；② `settings.progress`
   参数化（`partialIntervalMs` / `outputIntervalMs`）；③ `OutputBuffer.push(chunk, skipped?)` + `#skip()`
   跳过计数；④ `ToolExecutionApi.outputWindow`。审核表把它当成大新增，高估了。
4. **`read` 工具重写（1.0.3 的 Changed 项）审核表未列。** 上游 `src/tools/read.ts` 由 111 行变 216 行，改为
   `openBinaryReader` + `scanLines` + 定位读（`:82-145`），并带 `test/tools-read-differential.test.ts`
   差分测试（与「整文件读」参考实现逐字节比对）。它与 env 扩能是同一批的强耦合（不扩能就做不了），补为 B3-3。
5. **上游仍有 `src/storage/jsonl`，本地已按房规删除 append-only JSONL 后端。** 移植时**不得**把 jsonl 带回
   （见 `AGENTS.md` 存储章节：只保留 SQLite 一个生产文件格式）。逐文件 diff 后，本地相对上游的自有特性
   **必须在每次合并时保护**，清单如下（漏任何一条都是回归）：
   - `types.ts` 的 `ConversationDeletion` 审计类型与 `Storage.deleteConversation` 文档（v3 删除审计）；
   - `storage/memory.ts` 的 `deletions: ConversationDeletion[]` 状态，以及 fork 祖先缺失时的**优雅降级**
     （本地返回 `undefined` 结束可见历史；上游 1.1.0 在此处是非空断言 `!`——照抄会在删除过的 fork 链上崩）；
   - `storage/sqlite/storage.ts` 的 `project` 字段、每条查询的 `project_id = ?`、
     `SCOPED_DOCUMENTS` 谓词、`health()` / `checkpoint()`；
   - `index.ts` 的 `ProjectUsage` / `projectUsage` 导出（上游只有 `UsageDoc` / `UsageState`）；
   - `package.json` 无 `./storage/jsonl*` 与 `./storage/sqlite/cloudflare` 子路径。
   上游 durable **没有项目隔离**，其扫描 SQL 不带 `project_id`；合并扫描代码时**以本地为准**
   （`docs/ops-manual.md:100-106` 描述的跨项目不可见行为必须保持）。
6. **上游两个 e2e 文件花真钱，不得原样进本地默认套件。** `test/system-order-cache-e2e.test.ts`（真实
   Anthropic）与 `test/provider-session-cache-e2e.test.ts`（真实 OpenAI Codex）经 `resolveApiKey(...)` 取真
   token。房规明确 `packages/gibraltar/test/**` 只用 faux provider：移植时把其核心断言改写成 faux 版进默认
   套件，真 provider 版不搬（需要时另起 env 门控的 e2e，且严禁在有凭证的环境里从包根跑全套）。

---

## 1. 执行主线与批次结构

依赖序是唯一执行主线：**批次内部按依赖排列，批次之间不并行**。批次 3 体量最大（env 侧约 1500 行新增与改写），
单独成段，必要时按条拆分提交。

| 批次 | 内容 | 性质 | 提交粒度 |
| --- | --- | --- | --- |
| 批次 1 | 修复与纯增量：system 消息排序（#10542）、工具结果 `durationMs`、`settings.progress` + `outputWindow`、工具/钩子取 `models`、provider session UUID | 上游 Fixed / Added，**本地均非 Breaking** | 每条一 commit |
| 批次 2 | 公共签名变更：`ScanOrder` + 方向游标、`runtime.context()` options 签名、`Conversation.context({at})`、任务 `startedAt`/`endedAt` | 含 **1 条上游 Breaking** + 1 条新能力 | **B2-1 单独成 commit**（回滚面最大），其余每条一 commit |
| 批次 3 | env 1.0.3 / 1.0.4 扩能：接口、Node 实现（watch / binary / dir reader）、`read` 有界读、输出窗口修复、`powershell` 工具、env 一致性套件 | 上游 Breaking（`FileSystem` / `BinaryReader` / `Shell.exec`）+ Added + Fixed | 接口与实现分两条，其余每条一 commit |
| 批次 4 | 上下文缓存：`settings.contextRetentionMs` + `runtime.context()` 增量派生 | 上游 Changed，本地非 Breaking | 单独一 commit（触及上下文正确性） |

暂缓：`openDurableObjectSqliteStorage`（上游 `src/storage/sqlite/cloudflare.ts`，139 行）。理由见第 6 节。

---

## 2. 批次 1：修复与纯增量（不改公共签名）

### B1-1 首条 system 消息置前（#10542） — 来源 1.1.0 · Fixed · 本地非 Breaking

**缺陷**：一轮生成先提交用户输入 entry，再渲染 system baseline（`generation.ts:139` 读 view → `:165-182`
append system entry），因此 transcript 头部是 user，`deriveContext` 直接把 user 消息排在最前
（`context.ts:81`）。而 provider 只把**首条** system 消息当初始 prompt 与工具集：`tg-ai` 的
`api/anthropic-messages.ts:1136-1139` `getInitialSystemMessage` 只认 `messages[0].role === "system"`，
cache breakpoint 打在 system / 最后一个 tool / 最后一个 user 上（`:1177-1195`、`:1208-1233`、`:1487-1513`）。
system 掉到 user 之后，后续工具变更就要重写整段请求，prompt cache 全废。

**上游落点**：`src/harness/context.ts:171-178` `leadWithSystem()`，由 `:138-152` `deriveRange` 与
`:154-168` `extendRange` 两处调用。

**变更规格**（单文件、约 10 行）：`src/harness/context.ts` 新增 `leadWithSystem(messages: Message[])`：
`index = messages.findIndex((m) => m.role !== "user")`；`index <= 0 || messages[index]!.role !== "system"` 时原样返回；
否则返回 `[messages[index]!, ...messages.slice(0, index), ...messages.slice(index + 1)]`。
`:81` 改为 `messages: leadWithSystem(orderToolResults(contributions.flat()))`。

`tg-ai` 侧**不动**：adapter 已假定首条为 system，修在组装侧才是根治。

**与 B4-1 的联动**：缓存批次会把这次调用搬进 `deriveRange` / `extendRange`。先落本条、后落 B4-1；
回滚顺序相反（先回 B4-1）。

**回归测试**：`test/harness-context.test.ts` 新增「user entry 先于 baseline system entry」用例，断言
`messages[0].role === "system"` 且 user 消息相对顺序不变。修复前失败、修复后通过。先用 `bun -e` 走
`readContext` 复现现状，再写断言。

**回滚**：单 commit revert，安全。

### B1-2 工具结果 `durationMs`（#10549） — 来源 1.1.0 · Added · 本地非 Breaking

**依赖**：ai 基线 B2-2 必须先落地（`ToolResultMessage.durationMs?: number` 类型）。

**上游落点**：`src/harness/tool.ts:253-263`——`const startedAt = performance.now()` 在 `tool.execute` **之前**，
`try { execute } finally { durationMs = Math.round(performance.now() - startedAt) }`；`:281` 传入 settle、
`:386-391` `appendToolResult(...)`、`:463-476` 写进结果消息（`...(durationMs === undefined ? {} : { durationMs })`）。
上游注释钉死了口径：「Execution time of this attempt; **a rerun after recovery measures only itself**」。
**只要进入了 `execute()` 就有值**——包括抛错退出的调用（非零退出、超时）；没有值的只有从未执行到
`execute()` 的调用（参数校验失败、`beforeTool` 阻断、执行前已中止）。

**变更规格**：`src/harness/tool.ts` 的 `run()`（`:169` 起）在 `:245-246` 的 `tool.execute` 调用外套
`try/finally` 打点（**不是**只在成功路径打点），把值沿现有 settle → `appendToolResult` 链透传到
`tg.tool-result` entry 的 model 消息。时钟用全局 `performance.now()`（Bun/Node 均有；房内先例
`packages/codemode/src/runtime/host.ts:270,305`），**不新增 util 模块**。助手消息那一侧由 `tg-ai` 盖章，
gibraltar 只需让 entry 照常序列化（record 走 `omitUndefinedProperties`）。

**持久化**：仅 `record` JSON 增量字段，**无迁移**（同勘误 1）。

**回归测试**：`test/harness-tools.test.ts` 加两条——(a) 一个内部 sleep ~100ms 的假工具，结果 entry 的
`durationMs >= 100`；(b) **抛错退出**的调用（工具内 throw）也带 `durationMs`，而参数校验失败 / 被
`beforeTool` 阻断的调用没有该字段。上游没有为该字段单独建测试文件，用例自己写；先用 `bun -e` 实测
`performance.now()` 在本仓 Vitest 环境可用，再写断言。

**回滚**：单 commit revert；须在 ai 基线 B2-2 之后回滚。

### B1-3 `settings.progress` + `outputWindow` + 跳过计数 — 来源 1.0.3 · Added / Changed · 本地非 Breaking

**现状**：节流机制已存在（见勘误 3）：`output.ts:208-274` 有 `MIN_PROGRESS_INTERVAL_MS` + 字节反压的
`Progress`，`generation.ts:108` 有 `PARTIAL_THROTTLE_MS`。缺的是：间隔不可配置、`ToolExecutionApi` 拿不到
保留窗口、env 无法上报「我省略了多少输出」。另有一个**排序依赖**必须先解决：`ToolExecutionApi.outputWindow`
的类型 `ShellOutputWindow` / `ShellOutputSkip` / `ShellOutputInfo` 按上游定义在 `src/env/index.ts`
（`harness/types.ts:16` 从 env 导入），而 env 接口扩能在批次 3——**故本条 commit 顺带把这三个纯类型加进
`env/index.ts`**（纯新增、非 breaking），批次 3 的 B3-1 直接消费，不再重复定义。

**上游落点**：`harness/types.ts:393-403` `ProgressPolicy`、`:420`、`:438`；`harness/agent.ts:33-36`
`DEFAULT_PROGRESS_POLICY`（100 / 100）、`:63-67` **逐字段** `??` 解析（1.0.4 修复：显式 `undefined`
保留默认）；`generation.ts:372` `const interval = runtime.settings.progress.partialIntervalMs`（`:398`、
`:408` 两处 timer 使用）；`tool.ts:193-206` `models`（见 B1-4）+ `output(chunk, skipped)` +
`outputWindow`（`retain === "tail"` 时给窗口，否则 `undefined`）、`:338` `publishProgress` 第四参；
`output.ts`：`Progress` 构造收 `minIntervalMs`（删 `MIN_PROGRESS_INTERVAL_MS`）、导出
`PROGRESS_BYTES_PER_SECOND`、`OutputBuffer.push(chunk, skipped?)` + `#skip()`。

**变更规格**：

1. `src/env/index.ts` 新增 `ShellOutputWindow` / `ShellOutputSkip` / `ShellOutputInfo` 三个类型
   （上游 `:258-296` 逐字对齐；只加类型，**不加** `ShellExecOptions.window` 字段——那是 B3-1 的 breaking 部分）。
2. `harness/types.ts` 加 `ProgressPolicy`、`HarnessSettings.progress`、`Settings.progress`；
   `ToolExecutionApi` 加 `outputWindow` 与 `output(chunk, skipped?)`（文档照抄上游，含
   「wrapper 替换 `output` 时必须把 `outputWindow` 置 `undefined`」的约束，`harness/types.ts:184-188`）。
3. `harness/agent.ts` 加 `DEFAULT_PROGRESS_POLICY` 与逐字段 `??` 解析。
4. `generation.ts` 删 `PARTIAL_THROTTLE_MS`，改读 `runtime.settings.progress.partialIntervalMs`。
5. `harness/tool.ts`：`outputWindow`（`limits.retain === "tail"` 时
   `{ maxBytes, maxLines, minIntervalMs: settings.progress.outputIntervalMs, bytesPerSecond: PROGRESS_BYTES_PER_SECOND }`，
   否则 `undefined`）；`output` 透传 `skipped`；`publishProgress` 收间隔参数。
6. `harness/output.ts`：`Progress` 构造收 `minIntervalMs`（`:227-282` 区域）、`PROGRESS_BYTES_PER_SECOND`
   改导出、新增 `import type { ShellOutputSkip }`、`push(chunk, skipped?)` 与 `#skip()`。
   **跳过语义钉死**（上游 `:139-167`）：`skipped` 只在 `retain === "tail"` 时合法，否则抛
   `"Skipped output requires tail retention"`；`#skip` 把跳过量计入总量并重置已存 chunks（被跳过的文本
   必然超出保留窗口，窗口内的旧内容全部作废）；`push` 在「字符串 chunk 或带 skipped」时先 flush 解码器
   的 incomplete 字符（变 U+FFFD），字节 chunk 维持 `stream: true`。

**本条不含** `ShellExecOptions.window` 字段与 bash 工具的 `window:` 透传——那是 env 侧（B3-1 / B3-5）。
本条落地后 `api.outputWindow` 在批次 3 之前无人消费，属预期，不得因此把 env 侧提前。

**回归测试**（上游有现成文件，**移植优先于新写**）：

- 新文件 `test/harness-output-skip.test.ts`：上游 4 个用例——「progress 快照时机不改变保留尾」
  （`keeps the same tail whenever progress snapshots happen`，同时是 B3-4 的验收）、「任意合法跳过模式与
  全量流一致」、「跳过字节 / 行 / 末尾换行计数精确」、「head 保留拒绝 skips」。
- `harness-generation.test.ts` 加「`settings.progress.partialIntervalMs` 改变 partial 提交次数」
  （faux provider 计 commit 次数，先探后写）。
- `harness-tools.test.ts` 加「`retain: "head"` 的工具 `outputWindow === undefined`」。
- `harness-live-deltas.test.ts` 与 `harness-tools.test.ts` 中依赖节流的断言需逐条跑过。

**回滚**：单 commit revert（含 `env/index.ts` 的三个类型）；若 B3-5 已落，`bash.ts` 传 `window: undefined`
无害。B3-1 之后的批次依赖这三个类型存在，revert 前须确认 B3-1 未开始或一并回退。

### B1-4 `ToolExecutionApi.models` / `HookApi.models` — 来源 1.1.0 · Added · 本地非 Breaking

**现状**：模型目录只在 `HarnessOptions.models`（`harness/types.ts:425`）与 `TaskRuntime.models`
（`src/types.ts:184`）。`ToolExecutionApi`（`harness/types.ts:166-195`）与 `HookApi`（`:583-588`）拿不到，
工具要调模型只能起子任务绕路。

**上游落点**：`harness/types.ts:174-175`（`ToolExecutionApi.models`）、`:617-624`（`HookApi.models`）；
`tool.ts:193` `models: runtime.models`。

**变更规格**：两个接口各加 `readonly models: Models`；`harness/tool.ts:187-239` 的 api 对象补
`models: runtime.models`。**`HookApi` 无需任何接线**：本地把 `runtime` 本身当 `HookApi` 传
（`generation.ts:197,447,512,608`、`tool.ts:67,346`、`compaction.ts:128`），而 `TaskRuntime` 已声明 `models`。
零行为变化，纯扩大类型面。

**回归测试**：移植上游现成用例——`test/harness-tools.test.ts:115`
「gives tools and hooks the Harness's models」（同一引用断言），外加 `harness-generation.test.ts` 中
hook 侧用例。

**回滚**：单 commit revert，安全。

### B1-5 每会话 provider session UUID（#10424） — 来源 1.0.2 · Fixed · 本地非 Breaking

**现状**：gibraltar 全包无 session 持久化；`ConversationStreamOptions`（`harness/types.ts:350-360`）没有
`sessionId` 字段，`generation.ts:201-205` 组装 options 时也不带。`tg-ai` 侧 `StreamOptions.sessionId?`
已存在并由 `buildBaseOptions`（`packages/ai/src/api/simple-options.ts:58`）透传，消费点：
Anthropic 会话亲和头（`api/anthropic-messages.ts:1043-1045`）、OpenAI `prompt_cache_key`
（`api/openai-responses.ts:338`）、faux provider 的缓存键（`providers/faux.ts:242-254`）。

**上游落点**：新文件 `src/harness/provider.ts`（39 行）——`ProviderDoc`（`scope: "conversation"`、
`history: "latest"`、`fork: "initial"`、`initial: () => ({ sessionId: uuidv7() })`、`checkpointWhen: () => true`）
与 `ensureProviderSessionId(runtime, context)`（先 `runtime.snapshot` 读；读不到时用一个 commit 让
`tx.doc()` 触发 `initial()`，即旧会话的一次迁移提交）；`generation.ts:34` import、`:204`
`sessionId: await ensureProviderSessionId(runtime, context)`；`index.ts:42` 导出。此外
`harness/harness.ts` 的内建创建钩子同步播种：与 `tg.live` / `tg.inbox` / `tg.usage` / `tg.agent` 并列，
`await tx.doc(ProviderDoc, record.id)`——**新会话在第一次请求前就有 UUID，不走迁移路径**。

**变更规格**：

1. 新增 `packages/gibraltar/src/harness/provider.ts`。**kind 字符串必须是 `tg.provider`**（房规：落库 kind
   带 `tg` 前缀；上游 `pi.provider` 不得照抄）。
2. `import { uuidv7 } from "@OnePanda-TgSec/tg-ai"`——`packages/ai/src/index.ts:54` 已在根 barrel 导出，
   不需要新增子路径导出。
3. `harness/harness.ts` 的内建创建钩子（`#create` 的 conversationCreated 段）加
   `await tx.doc(ProviderDoc, record.id)`，与既有四个内建文档并列。
4. `generation.ts:201-205` 在 `...streamOptions` 与 `signal` 之后加
   `sessionId: await ensureProviderSessionId(runtime, context)`（与上游同序：hook 已可替换 messages，
   但身份与消息内容无关）。`ensureProviderSessionId` 只服务**旧会话**的补写。
5. `src/index.ts` 导出 `ProviderDoc` 与 `type ProviderState`。

**fork 语义**：上游 `fork: "initial"` —— 每个 fork 拿新 UUID（fork 是新会话，prompt cache 本就不共享）。保持一致。

**持久化**：新增一个 conversation 文档。既有会话在首次 prepare 时由 `ensureProviderSessionId` 补写一个
`tg.provider` 文档（一次 commit）。**不回写任何已有 kind，不加兼容 shim**（房规：持久化标识不是兼容层）。

**回归测试**：`session-forks.test.ts` 加「fork 后 `ProviderDoc` 是新 UUID、`fork:"initial"` 不拷贝父值」、
「创建钩子在首次请求前已播种 `tg.provider`」；`harness-generation.test.ts` 加「prepare 后 `tg.provider`
存在，且后续请求复用同一 sessionId」（faux provider 捕获 options；先用 `bun -e` 确认 faux 的捕获点再写
断言）。上游 `test/provider-session-cache-e2e.test.ts` 是真实 OpenAI Codex 的缓存探测 e2e（见勘误 6），
**不原样移植**；其核心不变量「同一会话的多次请求带同一 sessionId」已由上述 faux 用例覆盖。

**回滚**：单 commit revert。已落库的 `tg.provider` 文档成为孤儿数据（读取无消费者，不影响任何行为）；
**不得**为此写清理迁移。

---

## 3. 批次 2：公共签名变更

顺序即依赖：`ScanOrder` 改的是查询接口与游标，先落；`context()` options 签名是纯机械改动；
`startedAt`/`endedAt` 需要 `createSession({ now })` 一条新管线，放在最后不影响前两条。

### B2-1 `ScanOrder` + 方向游标（#10546） — 来源 1.1.0 · **Breaking** · 决策：加入

**决策论证**：需求是「最新任务优先」分页。`tasks.id` 单调递增，`order: "descending"` 即最新在前；游标必须
**携带 order** 才能保证跨页方向一致（否则第二页会把第一页的结果再吐一遍）。上游把同一机制铺到
conversation / entry / task / submission 四类扫描，本地照搬：只给 tasks 加会造成 `Storage` 接口自相矛盾，
而 `Storage` 是公开接口（`package.json:8-58` 导出 `./storage/memory`、`./storage/sqlite`、
`./storage/sqlite/node`），第三方实现会立刻踩到。上游一致性套件已覆盖两种方向，照搬即得同等信心。

**上游落点**：

- `src/types.ts:621` `export type ScanOrder = "ascending" | "descending"`；四个查询类型各加
  `order?: ScanOrder`（`:628` / `:639` / `:650` / `:658`）并注明默认值（conversations / tasks / submissions
  升序，entries 降序）；`Cursor` 文档改为「携带扫描方向」；Storage 接口注释同步（`:1027,1054,1065,1076`）。
- **新文件 `src/storage/scan.ts`（38 行）**：`ScanStart`、`scanStart(requested, cursor, fallback)`
  （非法 order 抛 `TypeError`；旧游标无 order 时回落 `fallback`；游标方向与 query 冲突抛
  ``The cursor continues a ${order} scan; the query asks for ${requested}``）、`nextCursor(id, order)`。
- `src/storage/memory.ts`：`:204-208` `page(values, limit, order)`、`:211-216` `scanIndexes(ids, start)`、
  `:523-539` `scanEntries` 分派 + `:704+` `visibleEntriesAscending()`（按 fork 链分段、根在前）、四处 `scanStart`。
- `src/storage/sqlite/storage.ts`：`:78-82` `page(values, limit, order)`、`:85-92` `scanDirection(start)`、
  `:332-368` 降序路径、`:370-408` 新增 `readEntriesAscending()`（fork 链 segments **反序**后从根会话向前扫）、
  四处 `scanStart`。
- `src/testing/storage-conformance.ts:438-460`：ascending 三页 + 区间 + 冲突方向 rejects。

**变更规格**（本地）：

1. `src/types.ts:606` 附近新增 `ScanOrder`；`:609-655` 四个查询类型加 `order?: ScanOrder`；`Cursor` 文档更新；
   `TaskRecordBase`、Storage 各 scan 的文档注释同步（以上游 diff 为准逐字搬运；`scanDocuments` 签名不变）。
2. 新增 `src/storage/scan.ts`，与上游逐行对齐（无 tg 命名差异）。
3. `src/storage/memory.ts:427-636`：四处 scan 换 `scanStart` / `nextCursor`；`page()` 加 `order` 形参
   （**默认 `"ascending"`**，`scanDocuments` 照原样调用、游标形状不变）；新增 `scanIndexes(ids, start)` 生成器
   与 `visibleEntriesAscending()`（按 fork 链分段、根在前）。**保护点**：本地的 `deletions` 状态与
   `visibleEntries*` 里「fork 祖先缺失时返回 `undefined` 结束可见历史」的降级必须保留——上游 1.1.0 在该处是
   非空断言 `!`（它无删除审计，祖先缺失不可能发生），照抄会在本地删除过的 fork 链上抛 TypeError（见勘误 5）。
4. `src/storage/sqlite/storage.ts`：`:68-73` `cursorId()` 与 `:75-79` `page()` 改为 `scanStart` / `nextCursor` /
   新增 `scanSql(start)` helper（id 条件 + 方向，`{ clause: "id > ?" | "id < ?", param, direction }`）；
   `:375-412` `readEntries` 按上游拆成降序路径 + `readEntriesAscending`（segments 反序、根会话向前）。
   **合并规则**：`scanSql` 的 clause 必须与本地 `project_id = ?` 组合（上游没有项目隔离），本地的
   `record_ids` 治理、fork 父链缺失容错（`:404-410`「A missing ancestor ends the visible history」）、
   `SCOPED_DOCUMENTS` 谓词必须保留。
5. `src/testing/storage-conformance.ts` 搬上游 `:438-460` 用例，并保留本地既有的 project 隔离断言
   （`ops-manual.md:100-106`：会话不可见时 `scanEntries` 抛 `Unknown conversation`）。
6. `harness/harness.ts:126-138` `entries()` 透传 `query.order`（上游 `:137` 即这一行：
   `...(query.order === undefined ? {} : { order: query.order })`）。

**不影响面**：harness 现有调用方全部依赖默认值，**一行不改**——`context.ts:117` 的 `entries.reverse()`、
`task-graph.ts:139` 的显式 `sort((a, b) => a.id - b.id)`、`scheduler.ts:239` 与 `#loadScopes`、`events.ts:152`、
`usage.ts:102`、`generation.ts:166`。

**验收口径（「最新任务优先」）**：

- `scanTasks({ order: "descending" }, limit, cursor, context)` 连翻三页：全局 id 严格递减、无重复、无遗漏，
  `next` 在最后一页为 `undefined`。
- 带 cursor 换方向 → 抛 `TypeError`，消息含 `cursor`。
- `scanEntries({ order: "ascending" })` 跨 fork 链返回最旧在前，且区间 `minEntryId`/`maxEntryId` 仍然生效。
- `Conversation.entries({ order: "ascending" }, …)` 与 `scanEntries` 同序。

**回归测试（上游现成用例，移植优先）**：一致性套件上游 `:438-460`（升序三页 + 区间 + 冲突方向 rejects，
memory / sqlite 两个驱动共用）；`test/harness-tasks.test.ts:861`
「`tx.scanTasks({ order: "descending" }, 2)` 分页取最新任务」；`test/harness-conversations.test.ts` 中
`entries({ order: "ascending" })` 用例。

**持久化**：游标是纯 JSON、不落库，**零 schema 迁移**。

**Breaking 范围**：`Storage` 与 `Tx` 的实现方必须支持 `order`。本仓实现只有 `MemoryStorage`
（`src/storage/memory.ts`）与 `SqliteStorage`（`src/storage/sqlite/storage.ts`），无第三方实现。

**回滚**：单独 commit。revert 后旧游标（无 order）被当作旧格式处理，回落默认方向，不会读错数据；
唯一代价是「最新任务优先」分页能力消失。

### B2-2 `TaskRuntime.context()` 收 options 签名 — 来源 1.1.0 · **Breaking**（上游）

**上游落点**：`src/types.ts:223` `context(conversationId, context, options?: { readonly at?: EntryId })`。

**变更规格**（机械改动，7 个落点）：

1. `src/types.ts:223` 第三参 `at?: EntryId` → `options?: { readonly at?: EntryId }`。
2. `harness/scheduler.ts:1170-1171` runtime 实现改读 `options?.at`。
3. 全部调用点：`generation.ts:139`（无 at，保持两参）、`:195`、`:460`、`:550`、
   `compaction.ts:115`、`:153`。

**本地 Breaking 判定**：名义上 breaking（公开 `TaskRuntime`），实际构造方只有 harness 内部
（`TaskScheduler.#runtime()`，`scheduler.ts:1048`），风险面是这 6 处调用点与测试。

**回归测试**：全量 harness 套件即为回归网；额外在 `harness-generation.test.ts` 确认带 cutoff 的读
（`:195`）行为不变（cutoff 用 `{ at: cutoff }` 传）。

**回滚**：单 commit revert，代价是与其后的 B2-3 无耦合。

### B2-3 `Conversation.context(context, { at })`（#10512） — 来源 1.1.0 · Added

**上游落点**：`src/harness/types.ts:544`；文档写明「与 `fork(at)` 会开始的视图相同，但不创建会话」。

**变更规格**：`harness/types.ts:510` `context(context)` 加 `options?: { readonly at?: EntryId }`；
`harness/harness.ts:122-124` 透传给 `readContext`。底层能力已存在（`context.ts:42-51` 的 `at` 参数，
`captureContextBounds` `:33-37` 已校验可见性并在不可见时抛 `Entry ${at} is not visible from conversation ${id}`）。

**回归测试**：移植上游 `test/harness-context.test.ts` 中 `{ at }` 相关用例；核心断言为
「`conversation.context(context, { at })` 的结果与 `fork(at)` 后新会话的首个上下文等价，且会话数不变」。
参照 `harness-conversations.test.ts:173` 已有的 fork as-of 用例。先探后写：以 `fork` 产物的 `messages`
做等价断言，不凭名字推断。

**回滚**：单 commit revert。

### B2-4 任务 `startedAt` / `endedAt`（#10549） — 来源 1.1.0 · Added · 本地非 Breaking

**勘误联动**：见第 0 节第 1 条，**零 schema 迁移**。

**上游落点**：`src/types.ts:538-545` 两个可选字段（含「`startedAt` 跨 wait 与 reopen 保留」文档）、
`src/session/transaction.ts:949-963` `#stampTimes(value, candidate)` + `:472` 在 `setTask` 里套用、
`src/session/session.ts:48-50,69` `createSession(storage, { now })`、`src/harness/harness.ts:177`
`super(storage, options.now)`。

**变更规格**：

1. `src/types.ts:523-538` `TaskRecordBase` 加 `readonly startedAt?: number;` 与 `readonly endedAt?: number;`。
2. `src/session/session.ts:49-51` `createSession(storage, options?: { readonly now?: () => number })`；
   `SessionImpl` 构造（`:69`）收 `now = Date.now` 并放进 `#host`；`TransactionHost` 类型同步加 `now(): number`。
3. `src/session/transaction.ts:458-472` `setTask` 内套用 `#stampTimes`：candidate 已有值优先，其次已提交记录的
   值，否则在状态转入 `running` / `terminal` 时取 `this.#host.now()`；无变化时原样返回 value。
   字段缺失时用 `...(x === undefined ? {} : { x })`，与 `TABLE_JSON_COPY_OPTIONS`（`:83`）的
   `omitUndefinedProperties` 一致。
4. `src/harness/harness.ts:175` `super(storage)` → `super(storage, options.now)`。
   `HarnessOptions.now` 已存在（`harness/types.ts:436`），`:179` 的 submissions 时钟复用同一值。
5. `inspect()` 与 task-graph 透传 record 即可，无需改动。

**回归测试**（上游现成用例，**移植优先**——它们用 `HarnessOptions.now` 注入假时钟拿确定性值，
不要写范围断言）：

- `test/harness-tasks.test.ts:311`「stamps startedAt at the first run and endedAt when terminal, keeping
  startedAt through a wait」：注入 `now` 返回 2_000 / 5_000，断言
  `[settledHeld?.startedAt, settledHeld?.endedAt]` 精确等于 `[2_000, 5_000]`，且 `inspect()` 的记录带同样值。
- `test/harness-tasks-recovery.test.ts:148`「keeps a task's startedAt across close and reopen and stamps
  endedAt when it settles」：重启后 `startedAt` 仍为 2_000、 settle 后 `endedAt` 为 9_000。

注入点是 `HarnessOptions.now`（`harness/types.ts:436`，已存在）——`harness.ts:175` 的
`super(storage, options.now)` 落地后，Session / scheduler / submissions 共用同一时钟。

**持久化**：仅 `tasks.record` JSON 增量；`storage.health()` 的 `schemaVersion` 仍为 3；
`docs/ops-manual.md:180` 的示例输出仍成立。

**回滚**：单 commit revert；已落库记录里的两个字段成为无人读取的额外键。

---

## 4. 批次 3：env 1.0.3 / 1.0.4 扩能（含 PowerShell）

这一批是本档案体量最大的部分：上游 `env/index.ts` 174 → 327 行、`env/node.ts` 957 → 1226 行，
另有三个新文件（`node-watch.ts` 522 / `line-scan.ts` 145 / `decode.ts` 30 行）。**先接口、后实现、再工具**，
每条独立可编译可回滚。

### B3-1 env 接口扩能（Breaking） — 来源 1.0.3 · **Breaking**

**本地差异**：`src/env/index.ts:96-140` 的 `FileSystem` 无 `openBinaryReader` / `openDirReader` / `watch()`；
`BinaryReader` / `LineScan` / `DirReader` / `WatchTarget` / `WatchChange` / `FileWatcher` 六个类型**不存在**；
`Shell.exec`（`:165-172`）只收字符串；`ShellExecOptions`（`:155-163`）无 `window`，`onOutput` 只有两个参。
（`ShellOutputWindow` / `ShellOutputSkip` / `ShellOutputInfo` 已在 B1-3 落地，本条**不重复定义**。）

**上游落点**：`src/env/index.ts:100-135`（`BinaryReader`）、`:108-118`（watch 三型）、`:139-152`（`LineScan`）、
`:154-161`（`DirReader`）、`:186-192`（`openBinaryReader`）、`:216`（`openDirReader`）、`:218-226`（`watch`）、
`:245-251`（`onOutput` 第三参 `ShellOutputInfo`）、`:254-268`（`ShellExecOptions.window`）、
`:301-310`（`exec(command: string | readonly string[], …)`）、`:325-326`（文件尾 re-export
`rangeDecoder` / `StreamDecoder` / `startsWithBom` / `LineScanner`）。

**变更规格**：逐条对齐上游签名与文档。`Shell.exec` 是**加宽**（字符串仍可用），`onOutput` 是**加宽**（第三参
可选），其余三个是 `FileSystem` 上的**新必填方法**——这三条对自定义 env 实现是 breaking。本仓唯一实现是
`NodeExecutionEnv`（`src/env/node.ts:437`）：全仓 `implements ExecutionEnv` / `implements FileSystem`
只此一处，测试中也没有第二个 env 实现，故本地 breaking 面为零。
`package.json` **零改动**（`./env` 子路径导出已存在，re-export 走同一路径）。

**下游同步义务**：`src/tools/read.ts`（B3-3）、`src/harness/tool.ts`（B1-3 已备好 api 面）、`src/tools/bash.ts`（B3-5）。

**回归测试**：`test/env-node.test.ts` 随 B3-2 补齐；`bun run check` 保证无残留实现缺口；验收网是 B3-6 的
一致性套件。

**回滚**：接口 revert 后 B3-2 / B3-3 / B3-5 必须同步 revert（回滚矩阵见第 8 节）。

### B3-2 Node 实现：binary reader / dir reader / watch — 来源 1.0.3 + 1.0.4 · Added / Fixed

**上游落点**：新文件 `src/env/node-watch.ts`（522 行）、`src/env/line-scan.ts`（145 行）、
`src/env/decode.ts`（30 行）；`src/env/node.ts` 扩到 1226 行。1.0.4 的 watch 修复**在新功能首版里就成立**
（上游是在 1.0.3 的 watch 之上修的），逐条：

- 无读权限的目标或被监听目录 → `permission_denied`（1.0.3 之前当缺失处理）；
- 同路径目录被替换 → 换新原生 watcher；
- 目标是文件的符号链接 → 上报被指向文件的变化；
- 非递归目标不阻断重叠的递归目标覆盖子目录；
- rescan 过程中 close 不泄漏 watcher。

**平台策略**（落地时保留，不要「简化」）：Windows、网络与 FUSE 文件系统走 polling 模式（原生 watcher 会持有
目录句柄，导致父目录改名失败）；macOS 安装原生 watcher 后短延时 rescan（FSEvents 漏掉 `fs.watch` 返回瞬间的变更）；
`watch` 选项控制模式、轮询间隔与目录上限。测试用能力探测跳过不适用平台，并写明条件。

**1.0.3 的 Node 修复**（落点：本地 `src/env/node.ts:373-435` `NodeTextLineReader` 与 shell 输出解码路径）：
shell 输出与文本行 reader 不再丢跨 chunk 边界的 U+FEFF；Windows 上 `flushFile()` 目录返回 `is_directory`。

**回归测试**（上游现成文件，移植优先）：新增 `test/env-line-scan.test.ts`（`LineScanner` 的纯函数用例，
无平台依赖）；`test/env-node.test.ts` 补 BOM 跨 chunk 与 `flushFile` 目录用例；watch 行为由 B3-6 的一致性
套件覆盖（上游没有独立的 `env-node-watch.test.ts`，watch 断言在 `env-conformance.ts` 里，按平台条件跳过——
`env-node-conformance.test.ts` 头部就是条件探测的范本）。**先探后写**：`fs.watch` 的实际回调形态用
`bun -e` 实测，别照抄断言。

**回滚**：与 B3-1 强耦合。

### B3-3 `read` 工具有界读 — 来源 1.0.3 Changed + 1.0.4 Fixed

**现状**：`src/tools/read.ts:32-34` 解析路径 → `:51-52` `env.readBinaryFile` 整文件读入 + `TextDecoder` + split。

**上游落点**：`src/tools/read.ts:82-145`：`openBinaryReader` → 一次 `scanLines` 定位所需行区间 →
定位读头与区间；1.0.4 修复「读取期间文件增长（活跃日志）不再失败，只有文件缩小或被原地重写才重读一次」。

**变更规格**：整份替换 `read.ts` 的读取路径；**工具输出必须逐字节不变**（现有 `tools.test.ts` read 用例是门槛）。

**回归测试**（上游现成文件，**移植优先**）：新增 `test/tools-read-differential.test.ts`——它保留「整文件读」
作参考实现（`referenceRead`），对随机文件 / 偏移 / limit 组合做差分比对；再加「读取期间追加内容不报错」
「缩小则重读一次」两条。先用 `bun -e` 走真实 `NodeExecutionEnv.openBinaryReader` + `scanLines` 确认偏移与
字节数，再写断言。

**回滚**：与 B3-1 / B3-2 耦合。

### B3-4 输出保留窗口修复 — 来源 1.0.3 / 1.0.4 · Fixed

**上游条目**：保留尾不得让 U+FEFF 卡在窗口开头；只在**字节输出最开头**丢 BOM；tail 保留的输出不再取决于
progress 提交时机（progress 快照曾把已保留输出压缩到窗口内，导致后续窗口首行位置漂移）。

**落点与精确改法**（逐行 diff 已核实）：`src/harness/output.ts`——顶部 `decoder` 与 `OutputBuffer.#decoder`
都改 `new TextDecoder("utf-8", { ignoreBOM: true })`；`OutputBuffer` 加 `#started` 标志，只有
「未开始 && 无 pending && 无 skipped」的第一个字节 chunk 才 `slice(1)` 掉 BOM；`Progress` 快照对
tail 保留改存 `tailMargin(stored, limits)`（超出窗口一字节 / 一行的最短后缀，新增该函数），不再存压缩后的
`kept.text`。`src/tools/edit-diff.ts:243-246` 的 `stripBom()` 是本地既有实现，保持。

**回归测试**：移植 `test/harness-output-skip.test.ts` 的「keeps the same tail whenever progress snapshots
happen」（与本条同 commit 或紧随 B1-3，见 B1-3 的测试清单）；`tools.test.ts:513` 已有的
「preserves BOM and CRLF line endings」（edit 路径）作对照。

**回滚**：单独 revert；与 B1-3 同文件但不同逻辑条目，互不影响。

### B3-5 `createPowerShellTool` — 来源 1.0.4 · Added · **决策：不暂缓**

**决策论证**（相对审核表「PowerShell 暂缓」的升级理由）：

1. **依赖已在批次内**：它 100% 依赖 argv 形态的 `exec`（B3-1/B3-2 必做），工具本体在 `src/tools/bash.ts` 里
   只有约 35 行（上游 164 行 vs 本地 90 行），额外成本极低。
2. **价值不只在 Windows**：harness 跑在 WSL / 容器里时 `pwsh` 是 Linux 发行版常见包，走 argv 直连不经 shell 解析，
   比 `bash -c` 更稳。
3. **不改则将来要重读一遍 env 语义**：那时正好赶上别的重构，回归成本更高。

**上游落点**：`src/tools/bash.ts:16-18`（`powershellSchema` + `PowerShellToolInput` + `PowerShellToolOptions`）、
`:63-113` 抽出的共享 helper（`validateTimeout`、`prepareExecution`、以及接受
`readonly (string | readonly string[])[]` 的 `runCommand`）、`:140-164` `createPowerShellTool`
（`UTF8_OUTPUT` 前置 + `["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-Command"]`，
`programs` 默认 `["pwsh","powershell"]`）；`src/tools/index.ts:7-13` 导出组。

**变更规格**：

1. 在 `src/tools/bash.ts` 内新增 PowerShell 部分，并按上游抽出共享 helper。`runCommand` 的
   「`spawn_error` 时试下一个 program」是 PowerShell 专用语义（bash 只有一个命令），共享实现必须保留
   `break` 条件（上游 `:99-102`）。
2. `src/tools/index.ts` 导出 `createPowerShellTool`、`type PowerShellToolInput`、`type PowerShellToolOptions`。
3. **不进 `CodingTools`**（上游 `:19-22` 明确该扩展只含 read / write / edit / bash），与上游一致。
4. 工具名 `powershell`，`outputLimits: { retain: "tail" }`，描述文案对齐上游（`DEFAULT_MAX_LINES` /
   `DEFAULT_MAX_BYTES` 来自本地 `src/truncate.ts`）。

**回归测试**（上游现成 describe，移植优先）：`test/tools.test.ts:549` 的 `describe("powershell")`——
用 `programsEnv` 注入假 `programs`（记录 argv、模拟启动失败），覆盖「UTF-8 输出」「fallback 到下一个
program 并上报最后的启动失败」「全部不可启动时抛错」；另加一条「命令以 argv 直接执行，`$`、管道等不经 shell
解析」。**先探后写**：先 `bun -e` 确认 argv 形态的 `exec` 在本地 env 上跑通，再写断言。

**回滚**：单 commit revert；env 侧不受影响。

### B3-6 env 一致性套件 — 来源 1.0.3 · Added

**上游落点**：`src/testing/env-conformance.ts`（511 行，`createEnvConformance:98`）、
`src/testing/runner.ts` 的 `registerEnvConformance`、`src/testing/types.ts` 的四个 `Env*` 类型、
`src/testing/index.ts` 导出组。1.0.4 追加的三项 watch 行为用例也在此套件内。

**变更规格**：本地 `src/testing/index.ts` 已导出 `registerStorageConformance`（同形态），照同一模式加
`registerEnvConformance` 与 `createEnvConformance`；`src/testing/types.ts` 加类型。

**回归测试**（上游现成文件，移植优先）：新增 `test/env-node-conformance.test.ts`——头部按平台做能力探测
（`process.platform`、`gitBash` 探测，Windows 上 `taskkill` 异步需重试删除临时目录），注册
`registerEnvConformance` 跑 `NodeExecutionEnv` 全量断言。这是 B3-1/B3-2 的验收网，必须在本批尾部转绿。

**回滚**：与 B3-1/B3-2 耦合。

---

## 5. 批次 4：上下文缓存

### B4-1 `settings.contextRetentionMs` + `runtime.context()` 增量派生 — 来源 1.1.0 · Changed · 本地非 Breaking

**现状**：`readContext`（`context.ts:42-51`）每次全量重扫（`scanRange:96-118`，`SCAN_PAGE_SIZE = 256`，
拉回来再 `reverse()`）。一轮生成至少 2 次、常见 3-4 次：`generation.ts:139,195,460,550`、
`compaction.ts:115,153`。

**上游落点**：`harness/agent.ts:53` `DEFAULT_CONTEXT_RETENTION_MS = 600_000`；`harness/types.ts:428`
`HarnessSettings.contextRetentionMs?`、`:442` `Settings.contextRetentionMs`；
`src/harness/context.ts:47-59` `ContextRange`（bounds / entries / view / edited / settled / open）、
`:67-104` `readContextFrom(..., previous)`（头 marker 相同则只扫 `previous.tail + 1 .. bounds.tail`）、
`:138-152` `deriveRange`、`:154-168` `extendRange`、`:202-215` `freezeJson`、`:217-227` `settle`；
`harness/scheduler.ts:191-200` `#contexts` Map + `idleSince`、`:430-435` `#contextRetentionMs()`、
`:442-462` `#settleIdle()`、`:464-480` `#scheduleExpiry()`、`:740` close 清理、`:1242-1272` runtime.context 的
缓存读写与保留策略。

**变更规格**：

1. `src/harness/context.ts` 按上游重构出 `ContextRange` / `readContextFrom` / `deriveRange` / `extendRange` /
   `freezeJson` / `settle`；`deriveContext` 保留为「无 previous 的一次性读」包装。
2. `harness/types.ts` 加 `contextRetentionMs`；`harness/agent.ts` 加 `DEFAULT_CONTEXT_RETENTION_MS = 600_000`
   与解析（`0` 表示空闲即丢）。
3. `harness/scheduler.ts` 增 `#contexts` / `#settleIdle` / `#scheduleExpiry` / close 清理；`#idle(conversationId)`
   已存在（`:1110`）直接复用。`TaskRuntime.context` 的 options 签名在 B2-2 已就位，本条只加 `previous` 参数。
4. **B1-1 联动**：重构会把 `leadWithSystem` 从 `deriveContext` 搬进 `deriveRange` / `extendRange`，语义不变。

**必须保持的语义约束**（本地 `context.ts:17-21` 已写明，移植时钉进注释与测试）：

- tail 以下的 entry 不可变 → 缓存可增量派生；
- 返回的 view 必须自有数组（上游 `:88-95` 复制 `entries` / `contributions` / `messages`）；
- 缓存条目跨读冻结（`freezeJson`），不得被 provider 或调用方就地改写；
- 新增的 entry 若带 `edits` 或 `head`，或命中既有 `edited` 目标 → 整段重新派生（上游 `extendRange` 的守卫）。

**调度器精确改动**（逐行 diff 已核实）：上游把既有的 `#resolveIdleWaiters()` 就地扩展为 `#settleIdle()`
（`scheduler.ts:442-462`）；新增 `#contexts: Map<ConversationId, { range: ContextRange; idleSince }>`
（`:191-200`）、`#contextRetentionMs()`（`:430-435`，**settings 抛错时经 `#report` 吞掉并返回 0**——缓存只是
缓存，绝不能让 settings 异常逃出 commit 监听 / 对账 / 定时器路径）、`#scheduleExpiry()`（`:464-480`，
仅定时器可 `unref` 的环境保 timer；`unref` 不可用的宿主不持有 timer）、close 时清空 `#contexts` 与
`#expiry`（`:740`）、`runtime.context` 的缓存读写与保留策略（`:1242-1272`）。`unref` 守卫照抄——它保护的是
「无 `unref` 的宿主不该持有 timer」的一般性，不只是 Cloudflare。

**回归测试**（上游现成用例，移植优先）：`test/harness-context.test.ts:603-672` 的
`countingSetup`（可计数 storage + 注入 `contextRetentionMs` 0 / 非 0 两组）——断言「同一 head marker 下
第二次读只扫增量」与「空闲超过保留期后缓存被丢弃、下次读重新全量扫描」；`harness-generation.test.ts` 加
「同一轮生成的两次 context 读不重复全量扫描」。时钟用注入的 `HarnessOptions.now`（`harness/types.ts:436`），
**不得**为测试真等十分钟。

**风险**：本批唯一触及上下文正确性的改动。`harness-context.test.ts`、`harness-compaction.test.ts`（2272 行）、
`harness-conversations.test.ts` 必须全绿；`docs/ops-manual.md` 若描述上下文读取行为，同 commit 更新。
上游 `test/system-order-cache-e2e.test.ts` 是真实 Anthropic 的缓存顺序探测 e2e（见勘误 6），不原样移植；
其「system 追加顺序与多次请求复用」不变量由 B1-1 的假 provider 用例覆盖。

**回滚**：单独 commit revert；先 revert 本条，B1-1 仍成立。

---

## 6. 暂缓项

| 项 | 上游落点 | 暂缓理由 | 触发条件 |
| --- | --- | --- | --- |
| `openDurableObjectSqliteStorage(ctx.storage)` | `src/storage/sqlite/cloudflare.ts`（139 行） | 无 Cloudflare Durable Object 部署；且该文件基于**无项目隔离**的上游 schema，若将来移植，必须把本地 v2（project 隔离）与 v3（删除审计）一并带上，不能直接照抄 | 决定部署到 CF Durable Object |

---

## 7. Cherry-pick 序（唯一基线）

提交顺序即下表。commit message 依房规
`{feat,fix,docs,refactor,chore}[(ai,tui,agent,gibraltar,chord,telemetry,mcp,codemode)]: <message>`。
每个 commit 落地前须通过 `bun run check` 与 `bun run test packages/gibraltar`（见第 9 节）。

| # | Commit message | 条目 | 依赖 |
| --- | --- | --- | --- |
| 1 | `fix(gibraltar): lead the model context with its first system message` | B1-1 | — |
| 2 | `feat(gibraltar): stamp tool result durationMs` | B1-2 | ai 基线 #8（B2-2） |
| 3 | `feat(gibraltar): make progress cadence configurable and expose the output window` | B1-3 | —（含 `env/index.ts` 三个输出窗口**类型**，见说明末条） |
| 4 | `feat(gibraltar): give tools and hooks the model catalog` | B1-4 | — |
| 5 | `feat(gibraltar): persist a provider session id per conversation` | B1-5 | — |
| 6 | `feat(gibraltar): add scan order and directional cursors` | B2-1 | — |
| 7 | `refactor(gibraltar): pass a context cutoff as an options object` | B2-2 | #6（`context.ts` 在 #6 之后改，避免与 `readEntries` 拆分冲突） |
| 8 | `feat(gibraltar): read the model context as of an entry` | B2-3 | #7 |
| 9 | `feat(gibraltar): stamp task start and end times` | B2-4 | — |
| 10 | `feat(gibraltar): extend the execution environment interface` | B3-1 | #3（消费 `outputWindow` 的类型） |
| 11 | `feat(gibraltar): implement binary, directory and watch capabilities in the node environment` | B3-2 | #10 |
| 12 | `fix(gibraltar): stop dropping a byte-order mark across chunk boundaries` | B3-2（修复部分） | #11 |
| 13 | `refactor(gibraltar): read files with bounded positional reads` | B3-3 | #11 |
| 14 | `fix(gibraltar): keep the retained output window independent of progress commits` | B3-4 | #3 |
| 15 | `feat(gibraltar): add the powershell tool` | B3-5 | #11 |
| 16 | `feat(gibraltar): add the environment conformance suite` | B3-6 | #11 |
| 17 | `feat(gibraltar): keep the derived conversation context in memory` | B4-1 | #7、#8、#1 |

说明：

- **#6 单独成 commit**：它是本档案回滚面最大的一条（改四个扫描实现 + 一致性套件 + 公开接口；documents
  扫描不变），与其余条目零耦合，回滚时不必牵动其他。
- **#10 与 #11 不可拆开发布**：接口先行、实现紧随，中间状态不可编译之外可用但无验收网；
  #16 是这条线的验收网，必须在本批尾部。
- **#12 从 #11 拆出**：watch / reader 的新增功能与 BOM / `flushFile` 的缺陷修复分开，便于判定「功能回滚」
  与「修复回退」是两件事。
- 批次 4 的 #17 放在最后：它与 #1 触及同一文件，且依赖 #7 / #8 的签名。
- 每 commit 附带 `packages/gibraltar/CHANGELOG.md` `[Unreleased]` 条目（见第 9 节）。
- **#3 顺带在 `src/env/index.ts` 落三个纯类型**（`ShellOutputWindow` / `ShellOutputSkip` / `ShellOutputInfo`）：
  `ToolExecutionApi.outputWindow` 的类型按上游定义在 env 侧，而 env 接口扩能在批次 3——把类型先行拆进 #3
  （纯新增、非 breaking），#10 直接消费、不再重复定义；#10 只含方法级 breaking 变更。这是本档案唯一的
  跨批次类型前置。

---

## 8. 回滚矩阵

| 条目 | revert 单元 | 耦合与注意事项 |
| --- | --- | --- |
| B1-1 system 置前 | 自身 | 与 B4-1 同文件；**先 revert B4-1**，revert 后回退到「user 在前」的修复前行为 |
| B1-2 tool `durationMs` | 自身 | 须在 ai 基线 B2-2 之前 revert；`performance.now()` 打点无残留依赖 |
| B1-3 progress / outputWindow | 自身 | 与 B3-4 同文件（`output.ts`）不同条目；commit 含 `env/index.ts` 三个类型——**若 B3-1 已落，须先 revert B3-1..B3-6**；若 B3-5 已落，`bash.ts` 仍会传 `window: undefined`，安全 |
| B1-4 `models` | 自身 | 无耦合；revert 后工具与钩子重新拿不到 catalog |
| B1-5 provider UUID | 自身 | 已落库的 `tg.provider` 变孤儿数据；**不得**为此补清理迁移（房规：不加兼容层） |
| B2-1 ScanOrder | 自身 | 旧游标（无 `order`）回落默认方向，不读错数据；revert 后「最新任务优先」分页消失 |
| B2-2 context options | 自身 | 须在 B2-3 / B4-1 之前 revert |
| B2-3 `context({at})` | 自身 | 底层 `at` 能力仍在，不影响 B2-2 |
| B2-4 任务时间戳 | 自身 | 依赖 `createSession({ now })` 管线；revert 后该管线可留（无害）也可同退 |
| B3-1 env 接口 | **必须先 revert B3-2、B3-3、B3-5、B3-6** | 接口先行是硬约束；`FileSystem` 三个新方法消失后 Node 实现会编译失败 |
| B3-2 Node 实现 | 自身（建议与 B3-1 同时） | 含平台策略，revert 后 watch 能力整体消失 |
| B3-3 `read` 有界读 | 自身 | 与 B3-4 触及同一路径，revert 顺序不限 |
| B3-4 输出窗口修复 | 自身 | 与 B1-3 同文件不同逻辑 |
| B3-5 PowerShell | 自身 | 独立；revert 不影响 bash 工具 |
| B3-6 env 套件 | 自身 | 与 B3-1/B3-2 配套 |
| B4-1 上下文缓存 | 自身 | **须先 revert**（它把 B1-1 的修复搬进了新结构） |

回滚验证：每次 revert 后跑 `bun run check` + `bun run test packages/gibraltar`。

---

## 9. 兼容性结论汇总表

| 条目 | 上游版本 | 上游类型 | 本地 Breaking | 持久化 / 存储影响 | 测试面 | v1 修复资格 |
| --- | --- | --- | --- | --- | --- | --- |
| B1-1 system 置前（#10542） | 1.1.0 | Fixed | 否 | 无 | +1 回归测试 | **有**（prompt cache 命中率缺陷） |
| B1-2 tool `durationMs`（#10549） | 1.1.0 | Added | 否 | record JSON 增量字段 | +2 断言 | 无（新能力） |
| B1-3 progress / outputWindow | 1.0.3 | Added / Changed | 否 | 无 | 新文件 `harness-output-skip.test.ts`（4 用例）+ 节流 / 窗口断言 | 无 |
| B1-4 `ToolExecutionApi/HookApi.models`（#10395） | 1.1.0 | Added | 否 | 无 | 移植上游 `harness-tools.test.ts:115` 用例 | 无 |
| B1-5 provider session UUID（#10424） | 1.0.2 | Fixed | 否 | **新增 `tg.provider` 文档**，旧会话一次迁移提交 | 创建钩子 + fork + faux 捕获用例（真 provider e2e 不移植，见勘误 6） | 有（缓存失效；可择小口径回移植） |
| B2-1 `ScanOrder`（#10546） | 1.1.0 | **Breaking** | **是**（`Storage` / `Tx` 实现方） | 游标为纯 JSON，不落库 | 一致性套件扩面（两个实现共用） | 无（新能力） |
| B2-2 `context()` options | 1.1.0 | **Breaking** | 名义是；实现方只有 harness 内部 | 无 | 6 处调用点 | 无（纯签名） |
| B2-3 `context({at})`（#10512） | 1.1.0 | Added | 否 | 无 | +1 等价性用例 | 无 |
| B2-4 `startedAt` / `endedAt`（#10549） | 1.1.0 | Added | 否 | **零迁移**（仅 record JSON） | 移植上游 `harness-tasks.test.ts:311` / `harness-tasks-recovery.test.ts:148`（注入 `now` 精确断言） | 无（新能力） |
| B3-1 env 接口 | 1.0.3 | **Breaking** | **是**（自定义 env 实现） | 无 | 随 B3-6 | 无 |
| B3-2 Node 实现 | 1.0.3 / 1.0.4 | Added / Fixed | 否 | 无 | 新文件 `env-line-scan.test.ts` + `env-node.test.ts` 增量（watch 行为由 B3-6 覆盖） | 修复部分可有 |
| B3-3 `read` 有界读 | 1.0.3 / 1.0.4 | Changed / Fixed | 否 | 无 | 新文件 `tools-read-differential.test.ts`（差分比对）+ 现有 read 用例 | 修复部分可有 |
| B3-4 输出窗口修复 | 1.0.3 / 1.0.4 | Fixed | 否 | 无 | `harness-output-skip.test.ts` 的 tail 稳定性用例 | **有**（数据正确性） |
| B3-5 PowerShell | 1.0.4 | Added | 否 | 无 | 移植上游 `tools.test.ts:549` `describe("powershell")`（假 programs 注入） | 无 |
| B3-6 env 一致性套件 | 1.0.3 | Added | 否 | 无 | 新文件 `env-node-conformance.test.ts`（平台条件探测） | 无 |
| B4-1 上下文缓存 | 1.1.0 | Changed | 否 | 无（纯内存） | 移植 `harness-context.test.ts:603-672` countingSetup 用例 + compaction 全量 | 无（性能） |

**`tg.*` kind 字符串与 SQLite schema 在全部条目中只有一处新增**：`tg.provider`（B1-5），且是**新** kind 而非
改名；`SQLITE_MIGRATIONS` 保持 v1/v2/v3 三条不变，`storage.health().schemaVersion` 恒为 3。

---

## 10. 验证协议（每 commit 强制）

1. `bun run check`（house standard + 格式 + 类型 + 相对导入）。
2. `bun run test packages/gibraltar`。
3. **禁止** `bun test`（会绕过各包的 Vitest / `node:test` 配置）。
4. 环境变量里有 endpoint / auth 配置时**禁止**从包根跑全套——e2e 会真花钱。房规钉死：`packages/gibraltar/test/**`
   只用 faux provider；上游两个真 provider e2e 文件（`system-order-cache-e2e`、`provider-session-cache-e2e`，
   见勘误 6）**不移植**进默认套件，其核心不变量改由 faux 用例覆盖。
5. **先探后断言**：任何新断言的值（`durationMs` 取值范围、`scanLines` 的偏移与字节数、`fs.watch` 回调形态、
   保留窗口首字节）必须先用 `bun -e` 对真实模块实测，再落进断言；`console.log` 探针不得随 commit 提交。
6. 每个修复类条目（B1-1、B3-4、B3-2 的修复部分、B3-3 的增长文件修复）的回归测试须**修复前失败、修复后通过**。
7. **一致性套件优先**：B2-1 / B3-6 的验收网是 `src/testing/storage-conformance.ts` 与
   `src/testing/env-conformance.ts`，两个后端实现都必须跑通，不允许只跑 SQLite。
8. Changelog：`packages/gibraltar/CHANGELOG.md` `[Unreleased]`，按序并入
   `Breaking Changes` / `Added` / `Changed` / `Fixed`；`Storage` / `FileSystem` / `TaskRuntime` 的签名变更
   进 `Breaking Changes`。
9. 行为手册：凡改动 `docs/ops-manual.md` 已描述的行为（project 隔离下的扫描可见性、`health()` 的
   `schemaVersion`、SQLite 唯一后端）必须在同 commit 更新手册。
10. Git：显式路径 staging，禁 `git add -A`；只提交本会话改动；`git status` 核对后再提交。

---

## 11. 与既有文档的关系

- [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)：调研来源；其 `tg-gibraltar` 段的
  「推荐」列已被本基线取代（含 PowerShell 与排序两项决策升级）。该表对 `tg-tui` 仍然有效。
- [`upstream-1.1.0-port-plan.md`](upstream-1.1.0-port-plan.md)：`tg-ai` / `tg-agent-core` 基线。
  本档案 B1-2 依赖其 B2-2（`ToolResultMessage.durationMs` 类型）；B2-4 与其 B2-2/B2-4 同属 #10549，
  三处计时（助手消息、工具结果、任务时间）**口径一致**：`performance.now()` 单调时钟用于耗时，
  `HarnessOptions.now` 墙钟用于生命周期时间。
- [`ops-manual.md`](ops-manual.md)：SQLite 唯一后端、project 隔离、`health()` 契约的行为手册；
  本档案不改其描述的行为。
- [`provenance.md`](provenance.md)：`tg-gibraltar` 的上游来源与采纳版本。