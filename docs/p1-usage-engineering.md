# P1 工程方案：usage 落账收尾、storage 生命周期、telemetry 接线

状态：已批准（§5 决策点三项已拍板：P1-1b 方案甲、delete 记审计事件、span 前缀 `tg.span.*`）
分支：`V2`（V1 冻结不适用于本批工作）
前置：P0 已交付（凭证持久化、provider 韧性、权限模型）

---

## 0. 总览与排序

| 项 | 一句话 | 工作量判断 | 排序 |
| --- | --- | --- | --- |
| P1-1 usage 落账收尾 | 口径回归锁死 + 跨会话聚合查询 | 小（主体已存在） | 1 |
| P1-2 storage 生命周期 | delete / export / backup | 中（Storage 接口扩展 + 双实现 + 一致性套件） | 2 |
| P1-3 telemetry 接线 | 第一批 span：`tg.provider.request` | 中（词表定义 + 挂点 + InMemory 断言） | 3 |

P1-1 最先做：它一半是回归测试（风险最低），且是计费/配额的唯一数据源。
P1-2 其次：用户数据权利（删除/导出/备份），产品化前必须有。
P1-3 最后：纯增量观测，不阻塞任何功能。

---

## 1. P1-1：usage 落账收尾

### 1.1 现状盘点（已存在，勿重复建设）

账的骨架三层都已落地：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| L1 单条账 | `packages/ai/src/types.ts:427` `Usage`；`AssistantMessage.usage`（`:559`） | token 计数 + `cost{input,output,cacheRead,cacheWrite,total}` 随每条 assistant 消息走 |
| L2 定价 | `packages/ai/src/models.ts:1242` `calculateCost` | tiers 选档（`inputTokensAbove`）、1h cache write 单列 2×、写回 `usage.cost`；各 adapter 收到 usage 时调用 |
| L3 会话台账 | `packages/gibraltar/src/harness/usage.ts` | `UsageDoc`（`kind: "tg.usage"`，`scope: conversation`，`history: latest`，`fork: initial`）；`UsageState = { models: Record<provider/model, Usage>, tools: Record<toolName, Usage> }`；`recordUsage` / `addUsage` / `addUsageState` |

写入点全部与 entry append **同 commit 原子**：

- `harness/generation.ts:655` `appendAssistant` → `recordUsage(tx, …, "models", provider/model, message.usage)`
- `harness/tool.ts:458` → `recordUsage(tx, …, "tools", toolName, result.usage)`
- `harness/compaction.ts:184` 摘要尝试计入 models bucket

事件面：`harness/events.ts` 已有 `usage_changed: { usage: UsageState }`。

**per-turn 粒度天然存在于 transcript**：`AssistantEntry`（`kind: "tg.assistant"`，entries 表 `record` 列存完整 `AssistantMessage` 含 `usage`）。与 opencode "消息内嵌 + step part 明细"等价——我们的 assistant entry 就是它的 step 粒度。

### 1.2 口径核实结论（已全部对齐，本项只剩"锁死"）

| adapter | 处理 | 证据 |
| --- | --- | --- |
| anthropic-messages | API 本身不含 cache，直接取值 | `api/anthropic-messages.ts:680-687` |
| openai-completions | `input = prompt_tokens − cached − cache_write`（OpenAI/OpenRouter/DeepSeek/Kimi 四方言兼容，写不重复扣） | `api/openai-completions.ts:1522-1538` |
| openai-responses-shared | `input = input_tokens − cached_tokens − cache_write_tokens` | `api/openai-responses-shared.ts:560-570` |
| mistral-conversations | `input = promptTokens − cachedPromptTokens` | `api/mistral-conversations.ts:606` |

结论：**无需改 adapter 代码**。缺口是没有回归测试钉住这个口径——将来新增 adapter 或改 usage 解析时最容易悄悄破坏的就是"cache 是否含在 input 里"。

### 1.3 工作项

**P1-1a：usage 口径回归测试（已落地，`packages/ai/test/usage-accounting.test.ts`，12 条）**

只断言**已观察到的**行为：

1. openai-completions 三种方言（`prompt_tokens_details.cached_tokens` / DeepSeek `prompt_cache_hit_tokens` / Kimi 顶层 `cached_tokens`）都从 input 中扣减，`input + cacheRead + cacheWrite === provider 上报的 prompt 总量`。
2. openai-responses-shared 同口径（扣 cached + cache_write）。
3. anthropic-messages：`input_tokens` 原样保留（该 API 本身不含 cache），`totalTokens === input + output + cacheRead + cacheWrite`。
4. mistral-conversations：`input = prompt_tokens − cached`。
5. `calculateCost`：分档定价按 `inputTokensAbove` 选档（阈值下/上各一条）；**tier 判定把 cache token 也算进总量**（150k uncached + 60k cacheRead = 210k 触发 200k 档）；1h cache write 按 2× input 计价。

写测试时的两处实测修正：
- `gpt-4o-mini` 在 catalog 里解析到 `openai-responses`，completions adapter 用例必须显式钉 `api`；
- tier 判定含 cache token 这条是我最初断言写反（以为只看未缓存 input），实测代码按总量选档——代码正确，改正断言。

**P1-1b：跨会话聚合查询（方案甲，已落地）**

目的：产品化后"本项目总共花了多少、按模型分布"不能再靠扫全部 transcript。
两个方案：

- 方案甲（**已批准并实现**）：**只读聚合函数**，不动存储。gibraltar 新增导出：

  ```ts
  // packages/gibraltar/src/harness/usage.ts
  export async function projectUsage(storage: Storage, context: Context): Promise<ProjectUsage>
  export type ProjectUsage = { readonly conversations: number; readonly usage: UsageState };
  ```

  实现：按 `scanConversations` 游标分页（每页 200）→ 对每个 conversation 读 `tg.usage` 的 current 文档 → `addUsageState` 折叠。读时聚合，账仍只有一份（tg.usage），不引入第二份写路径。

  实现期发现并已处理的三处与设计稿的偏差：
  1. **project 不是参数**：storage 实例本身就是项目视图（`scanConversations` 以 `project_id` 过滤），且 chord 的 `Context` 不带 projectId。故签名是 `(storage, context)`。
  2. **`conversations` 只算有花费的会话**：`createConversation` 会物化一份空的 `tg.usage`（两个 bucket 都是 `{}`），按"有文档即计入"会把每个新建会话都算进去。故按 bucket 非空判定。
  3. **两次读之间可能消失**：`findDocument` 之后、`document` 之前文档可能被换 incarnation 或删除，此时跳过而非报错。
- 方案乙：项目级 `tg.usage.project` 文档，写入时双写。否决理由：两份账必然漂移；append-only 文档还会随每次 turn 膨胀重写。

**P1-1c：per-turn 反查 API（可选，随产品需要再上）**

`Storage.entry` 扫描 + `AssistantEntry.is()` 过滤即可满足；若 UI 需要高频访问再考虑在 harness 层加缓存视图。**先不做**，避免为假想的 UI 提前优化。

### 1.4 验收

- `bun run test` 全绿，`usage-accounting.test.ts` ≥ 10 条断言落在真实 adapter 输出上。
- `projectUsage` 在 MemoryStorage 与 SqliteStorage 上一致（用同一 conformance 数据断言相等）。

---

## 2. P1-2：storage 生命周期

### 2.1 现状

- `packages/gibraltar/src/types.ts:993` `Storage` 接口：只有 `commit / mintId / conversation / scanConversations / entry / …` 读与追加。
- `SqliteStorage` 全部方法为读/追加（`storage.ts:130-574`），行级 `DELETE` 仅两处 document_revisions 级联（`:921/:946`，随文档重写）。
- **没有任何会话删除、导出、备份能力**。数据库只会增长。

### 2.2 接口扩展（三种能力，一个原则：显式生命周期 API，不进 commit 写路径）

`Storage` 接口新增三个方法（`MemoryStorage` 同步实现，保持一致性套件两侧同测）：

```ts
// packages/gibraltar/src/types.ts Storage 接口追加
/** Permanently remove one conversation and every row scoped to it. Returns false if absent. */
deleteConversation(id: ConversationId, context: Context): Promise<boolean>;

/** Serialize one conversation: schema header + all entries + latest docs, in a single JSONL stream. */
exportConversation(id: ConversationId, context: Context): Promise<ConversationExport | undefined>;

/** Write a consistent snapshot of the entire database to a new file (SQLite VACUUM INTO). */
backup(path: string, context: Context): Promise<void>;
```

### 2.3 deleteConversation 的级联清单（SQLite 侧）

按 `conversation_id` 外键逐表 DELETE，单事务内：

| 表 | 行为 |
| --- | --- |
| `entries` | `DELETE WHERE conversation_id = ?` |
| `tasks` | 同上 |
| `submissions` | 同上 |
| `documents` | 只删该 conversation scope 的文档行；**`document_revisions` 随既有级联逻辑清** |
| `conversations` | 最后删本体 |

约束：

- 删除前必须无运行中任务引用该会话（调用方责任，storage 只管持久层；在 doc 注释写明）。
- fork 关系：删除父会话**不**级联子会话（子会话 entries 自持有数据，ancestry 断链在读取侧已有处理）。测试要覆盖"删父读子"。
- ID 不回收：`record_ids` / `durable_metadata` 不动，保证 `mintId` 单调性与审计连续。
- 幂等：删不存在会话返回 `false`，不抛错。

### 2.4 exportConversation 的格式

```jsonl
{"v":1,"kind":"tg.export.header","projectId":"…","conversationId":"…","exportedAt":…,"schemaVersion":<durable_schema version>}
{"kind":"tg.export.entry","seq":…,"entry":{…EntryRecord}}
{"kind":"tg.export.doc","doc":"tg.usage","state":{…}}
…
```

原则：

- **JSONL，一行一记录**，流式可写，`head`/`fork` 关系保留在 entry record 原文里。
- header 行带 schema 版本，导入能力（P2）按版本拒收或迁移。
- docs 只导 `scope: conversation` 的 latest（`tg.usage` 等），全局表不进会话导出。
- 本期**只导不入**：导入涉及 ID 冲突策略（重新 mint 还是保留原 ID），单独评审。

### 2.5 backup

- SQLite：事务内 `VACUUM INTO ?`（生成一致快照，无需停写；比文件拷贝安全——文件拷贝在 WAL 模式下会丢尾）。
- 限制：`VACUUM INTO` 目标文件必须不存在，存在则报错（SQLite 语义，直接透传）。
- MemoryStorage：序列化全量状态到 JSON 文件（仅供测试对称性，产品路径只有 SQLite）。
- 实现位置：`SqliteStorage.backup` 包在 `admitRead` 之外的自有锁里（快照期间不拒读，VACUUM INTO 自身保证一致性）。

### 2.6 测试计划

新增 `packages/gibraltar/test/storage-lifecycle.test.ts`（faux 数据，双实现同测）：

1. delete 后 `conversation()` 返回 undefined、`scanConversations` 不再出现、`health().integrity_check === "ok"`。
2. delete 父会话后子会话可读（ancestry 断链不破坏读取）。
3. delete 不存在的会话 → `false` 不抛。
4. export 行数 = entries + docs + header；round-trip：导出文本可被 `JSON.parse` 逐行还原（导入不做，只验结构）。
5. backup 文件可被 `openNodeSqliteStorage` 打开且 `health()` 通过、行数与源一致。
6. 备份目标已存在 → 报错且源库无损。

### 2.7 风险与边界

- **append-only 审计语义**：delete 是显式生命周期操作，不等价于"静默改史"。`durable_metadata` 记录 delete 审计事件（新 key，如 `deleted_conversations`，值为 `{conversationId, deletedAt}`）——**不改已冻结的 V1 schema**（entries/documents 等表结构零变更，本项无 migration）。
- `MemoryStorage` 同步实现，否则 conformance 套件会拉爆。

### 2.8 落地修订（2026-10-09）

本节已按 `docs/p1-2-storage-lifecycle.md` 落地，五处口径修正：

1. **审计载体**：`durable_metadata` 新列 `deleted_conversations`（迁移 v3，单表 `ALTER TABLE`）。原"本项无 migration"表述修正——singleton 表加 key 机械上必须走迁移；"冻结数据表零变更"的意图保留。
2. **delete 返回值**：`Promise<ConversationDeletion | undefined>`（原写 boolean），审计对象让 conformance 双实现可直接断言，不必裸查 SQL。
3. **export**：返回 `readonly string[]`；行范围在 header+entries+docs 之外增加 task/submission 行，与 delete 级联完全对称；header 带会话 record，doc 行带 `key`/`version`/`taskId`。
4. **ancestry 断链**：原"读取侧已有处理"不成立（五处 walk 会抛 `TypeError`），已硬化：父行缺失视为可见历史终点，以独立 `fix` 落地。
5. **backup**："事务内 `VACUUM INTO`"修正为事务外单语句（实测事务内直接报错）；`MemoryStorage` 因包根导出图零 Node 导入的机械约束（`test/storage-runtime-boundary.test.ts`）改为**拒绝文件备份**，原"写 JSON 投影"方案作废。

---

## 3. P1-3：telemetry 接线（第一批 span）

### 3.1 现状

- 契约完整：`packages/telemetry/src/index.ts` — `TelemetryContext / TelemetrySpan`、`NOOP_TELEMETRY_CONTEXT`（零开销默认）、`InMemoryTelemetryContext`（测试断言用）、`createTypedSpanStarter`（schema 化 span 词表）。
- **全仓没有任何真实 span 被创建**。`tg-ai` 只在 `types.ts:135` 持有 `telemetryContext?: TelemetryContext` 字段、`api/simple-options.ts:32` 透传，没有消费者。
- agent/tui 层不感知 telemetry。

### 3.2 span 词表（第一批 3 个）

定义在 `packages/telemetry/src/index.ts` 现有 `TelemetrySpanDefinition` 体系里新增一份 schema 常量（导出给 ai/agent 引用）：

| span | 层 | parent | 关键属性（全部低基数） |
| --- | --- | --- | --- |
| `tg.span.provider.request` | ai | root | `provider`、`api`、`model`、`stopReason`、`errorName`、`retried`（bool）、`tokens.input/output/cacheRead/cacheWrite`、`cost.total` |
| `tg.span.agent.turn` | agent | root_or_external | `provider`、`model`、`stopReason`、`toolCallCount` |
| `tg.span.agent.tool` | agent | `tg.span.agent.turn` | `toolName`、`isError` |

命名遵循 house standard：持久化/事件 kind 用 `tg.` 前缀，span 名同族（`tg.span.*`），与 `tg.user`/`tg.assistant`/`tg.usage` 同一拼法体系。

**隐私边界**：span 属性**只放计数与枚举，不放内容**——不进 prompt 文本、工具参数、路径。`model` 用 catalog id（`claude-sonnet-5-5`），非自由文本。

### 3.3 挂点

**ai 层（核心）**：`packages/ai/src/models.ts` `createProvider` 组装 `provider.stream / generateImages / classify` 的包装处（`provider.stream = …` 赋值点，同文件已有 dispatch 逻辑）——包一层 span：

```
stream(model, context, options) →
  ctx.startSpan({ name: "tg.span.provider.request", attributes: {provider, api, model} }, span =>
     原始 stream 完成时（EventStream settled）→ span.setAttributes({stopReason, tokens…}) / setStatus
  )
```

- `telemetryContext` 从 `StreamOptions.telemetryContext`（`types.ts:135` 已有字段）取，缺省 `NOOP_TELEMETRY_CONTEXT`。
- 与 P0 韧性层的组合：span 外层包住 retry + concurrency gate，`retried` 属性由 `provider-retry.ts` 回写——一次 request span 对应一次完整逻辑调用（含重试），重试次数进属性而不是嵌套 span（第一批保持扁平）。

**agent 层**：`packages/agent/src/agent-loop.ts` turn 循环处包 `tg.span.agent.turn`，`runToolCall` 包 `tg.span.agent.tool`（context 从 `AgentLoopConfig` 新字段 `telemetryContext` 传入，默认 NOOP，权限三字段同款透传模式，嵌套 runner 自动继承）。

### 3.4 测试计划

`packages/agent/test/telemetry.test.ts` + `packages/ai/test/telemetry.test.ts`：

1. `InMemoryTelemetryContext` 跑一次带工具的 turn，断言 span 树：`turn ⊃ provider.request*`、`turn ⊃ tool`，属性齐全。
2. 默认（不配 telemetryContext）路径与现状 byte-identical——NOOP 无副作用断言。
3. provider 报错时 `provider.request` 的 `setStatus({status:"error"})` 与 `errorName`。
4. 权限拒绝的 tool call：`tg.span.agent.tool` 仍产生，`isError: true`。

### 3.5 非目标

- 不接 OpenTelemetry SDK exporter（产品化需要时再加一个 `TelemetryContext` 实现包）。
- 不做 span 采样、批量导出、进程外转发。
- 不给 tui 挂 span（UI 观测走它自己的性能路径）。

### 3.6 落地记录（2026-10-10）

本节已按 `docs/p1-3-telemetry-wiring.md` 落地（`bun run check` / `build` / `test` 全绿），
五处相对父规划原稿的口径修正：

1. **span 数 3→4**：详规 D1 拍板新增 `tg.span.provider.acquire`（并发门排队/拒绝观测），
   词表落 `packages/telemetry/src/spans.ts` 的 `TG_SPAN_SCHEMA`，经 index 再导出。
2. **形态非扁平**：`Models.holdSlot` 包 `limiter.acquire()`，acquire span 作为下层请求的
   `telemetryContext`，实际树形为 `turn ⊃ acquire ⊃ request`（§3.3 草图的扁平单 span 未采用，
   详规 §2.5 偏差清单已列）。
3. **retried 实现**：`ProviderRequestOptions.onRetry` 内部管线（重试两守卫通过后、退避等待前
   同步触发），8 个适配器调用点机械透传；`retried` = 重试次数 > 0。
4. **agent 依赖面**：`tg-agent-core` 新增对 `tg-telemetry` 的运行时依赖（AGENTS.md 边界图已
   同步）；`RunToolCallOptions` 增可选 `telemetryContext` 供嵌套调用挂父 span；
   `examples/mcp-codemode` 的嵌套 runner 暂不传该字段（记档缺口，宿主接入点）。
5. **默认零开销**：不配 telemetryContext 时全链 NOOP 直通、与原路径同形，事件序列不变
   （T5/A3 断言）。

测试矩阵：telemetry 词表 V1-V3、ai T1-T7、agent A1-A4，共 14 条新用例。

---

## 4. 实施顺序与提交切分

| 步 | 内容 | 提交 | 依赖 |
| --- | --- | --- | --- |
| 1 | P1-1a usage 口径回归测试 ✅ | `test(ai): pin usage accounting semantics across adapters` | 无 |
| 2 | P1-1b `projectUsage` ✅ | `feat(gibraltar): add cross-conversation usage aggregation` | 步 1 |
| 3 | P1-2 生命周期三方法 + conformance | `feat(gibraltar): add conversation delete/export and database backup` | 无 |
| 4 | P1-3 telemetry 词表 + ai 挂点 | `feat(ai,telemetry): wire the first provider request spans` | 无 |
| 5 | P1-3 agent 层 span | `feat(agent): wrap turns and tool calls in telemetry spans` | 步 4 |

每步独立绿：`bun run check` + `bun run build` + `bun run test` 全过再进下一步；每步一个 commit，CHANGELOG 按 house 规则入 `## [Unreleased]`。

## 5. 决策点（已全部拍板）

1. **P1-1b 采用方案甲**（只读聚合 `projectUsage`，不双写账）——已批。乙的双写漂移风险否决。
2. **delete 记审计事件**（`durable_metadata` 新 key 记"何时删了何会话"）——已批。`deleteConversation` 落地时同步实现，测试覆盖断言审计行存在。
3. **span 命名前缀 `tg.span.*`** ——已批。与 `tg.usage` 等 kind 同族不同段，已登记进 AGENTS.md 命名表（"Telemetry span name" 行）；机械校验随 P1-3 落地：span 词表以 `TelemetrySpanDefinition` schema 声明，`packages/telemetry` 的测试断言词表全部匹配 `^tg\.span\.[a-z][a-z0-9.]*$`，词表之外无 span 名可用（typed starter 类型上即拒）。

## 6. 非目标（本期不做）

- 导入（import/restore）：ID 冲突策略未定，P2 评审。
- `retryAssistantCall`（`packages/ai/src/utils/retry.ts:186`）接线：会改变 per-turn 重试语义（3×3 复合），等显式决策。
- 跨 provider failover、app 化（protocol/client/server）、`credentialId` 多租户：维持 P0 时的延后结论。
- OpenTelemetry exporter。
