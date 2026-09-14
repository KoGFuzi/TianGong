# Effect v4 化演进规划（pi 上游架构 × opencode Effect 化参照）

> 参照基线 1：`/run/media/J/Workspace/Code-Testing/pi-main/packages`（pi 上游 0.85.1，2026-09-05 发布，快照 09-12）
> 参照基线 2：`/run/media/J/Workspace/Code-Testing/opencode-dev/packages`（opencode Effect 化新版，effect 4.0.0-beta.83 + 补丁）
> 前置：`docs/agent-catchup-plan.md`（agent 对齐上游，已全部关闭）与 `docs/sqlite-bun-port-plan.md`（已完成）。
> 本计划承接其后：**在现有模块基础上做 Effect 化演进，不推倒重来**。
> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成 / `[!]` 受阻（附原因）

## 0. 背景与定位

追赶上游的两大工程（agent 对齐 pi 0.85.1 的 runtime/v4-session、sqlite-bun 移植）均已关闭，全仓 5 包测试绿。当前的新目标来自两股推力：

1. **风格分裂需要收敛**：ai（25 文件）/telemetry（6 文件）已有真实 Effect 使用（`Effect.tryPromise`×29、`Context.Service`×6、models 层 3 处 `Layer.Layer`），而 agent/chord/sqlite-bun 声明了 `effect@4.0.0-rc.111` 依赖却零使用——半 Effect 化状态不可长期维持。
2. **下游路线需要地基**：TUI、进程分离（上游已有实验性 `pi-protocol` v8 / `pi-server` / `pi-client`）与服务化组合，都要求可装配的运行时；opencode 已在同一形态的产品上（Bun 单仓 + SQLite 会话 + agent loop）验证了 Effect v4 的生产级模式，可直接借用法则而非自行发明。

**关键认知（决定本计划的边界）**：pi 的 `runtime/drive` 是"持久化过程 + Storage 提交"模型，本质是一套手写的 durable runtime；opencode 的对应物是 Effect 原生（`uninterruptibleMask` / `FiberSet` / EventV2 事件溯源）。二者领域语义同构、机制实现不同。本计划用 Effect 替换**机制层**（并发原语、错误通道、服务装配），**不改写 pi 的领域过程**（drive/lane/structural/Storage 契约）。

## 1. 现状盘点（Effect 足迹，2026-09-14）

| 包 | effect 依赖声明 | src 实际使用 | 备注 |
|---|---|---|---|
| ai | rc.111 | 25 文件：tryPromise×29、Context.Service×6、Effect.gen×2、models 层 Layer×3 | 已半 Effect 化，是全仓风格基准 |
| telemetry | rc.111 | 6 文件：Context.Service×2、tryPromise×2 | 跟随 ai |
| agent | rc.111 | **0** | 与上游 0.85.1 同构（drive/ 12 模块、reducer、effect-gate、v4 session 全套 + conformance） |
| chord | rc.111 | **0**（src+test 均无 import） | 声明未用，疑似冗余依赖 |
| sqlite-bun | rc.111 | **0** | 上游 sqlite-node 移植 + bun:sqlite 适配器（bunfs 纯 Bun 化），conformance 兜底 |

## 2. 上游调研结论

### 2.1 pi 上游（结构已对齐，本计划不再同步结构）

- agent 与上游 0.85.1 逐文件同构（`runtime/reducer.ts`、`runtime/drive/`×12、`execution/effect-gate.ts`、`session/values.ts`、`mutation-line.ts`、`jsonl/legacy-v3.ts` 均在位）；上游快照无 0.85.1 之后的源码变更。
- 上游"effect"词汇（`effect-gate.ts`、`assistant.effect_pending`、deferred-effect permits）是领域术语，与 Effect-TS 无关——agent 包保持零 effect import 是上游现状，Effect 化是下游主动决策。
- 值得远期引入的上游包（均实验性/另案）：`protocol`（v8 CBOR 帧协议）、`server`（Session/Harness 远程服务化）、`client`、`coding-agent`（产品层）、`tui`。本计划仅保证事件形状可序列化（catchup 5.2 已达成），不提前引入。

### 2.2 opencode Effect 化模式清单与采用判定

| # | opencode 模式 | 位置 | TG 判定 |
|---|---|---|---|
| 1 | `class Service extends Context.Service<Service, Interface>()("@app/X")`（v4 已无 Context.Tag） | core/src/location.ts 等 63 处 | **adopt**——ai/telemetry 已在用，扩展为全仓 idiom |
| 2 | `Layer.effect(Service, Effect.gen(...))` + `Service.of({...})` | 同上 | **adopt** |
| 3 | LayerNode DAG：服务声明为带类型 deps 的 Node，惰性编译成 Layer（环检测/记忆化/替换） | core/src/effect/layer-node.ts（333 行） | **defer**——chord 已是组合运行时（facets/services），Phase 5 做 ADR 后再定 |
| 4 | `ManagedRuntime.make` + service-use Proxy（`tag.use(...)`）桥接非 Effect 调用点 | core/src/effect/runtime.ts、service-use.ts | **adopt**——混合代码库渐进化的关键 |
| 5 | `#sqlite` 条件导入 bun/node 双胞胎 | core package.json imports + sqlite.bun.ts/sqlite.node.ts | **skip**——TG 单 Bun 运行时，sqlite-bun 已 Bun 专用 |
| 6 | Effect `SqlClient` + vendored Drizzle adapter | effect-sqlite-node、effect-drizzle-sqlite | **skip（记录结论）**——pi 的 `Storage`/`SessionRepo` 契约已被 conformance 验证，引 Drizzle 会推翻 `001_initial.sql` 体系；sqlite.bun.ts（183 行）仅作机制参考 |
| 7 | EventV2 持久事件溯源（per-aggregate seq、事务内 commit hook、`Effect.catchDefect` 幂等对账） | core/src/event.ts（638 行） | **adapt（不引入第二事件源）**——pi 已有 durable operation records；仅吸收其不变量（见 3.3） |
| 8 | SessionStore/SessionRunner/SessionExecution 分层 + "no layer takes a Session ID" | core/src/session/store.ts、AGENTS.md V2 invariants | **adopt（作为边界规则）** |
| 9 | durable admission inbox（`session_input`） | core/src/session/input.ts | **skip**——pi drive 的 checkpoint/deferred 已覆盖同等语义 |
| 10 | 工具执行：`FiberSet` + `uninterruptibleMask` 结算区 | core/src/session/runner/llm.ts | **skip（重写）/ adapt（词汇）**——pi `drive/tools.ts` 已有批次执行+恢复语义，禁止重写 |
| 11 | keyed run-coordinator / keyed-mutex | core/src/session/run-coordinator.ts、effect/keyed-mutex.ts | **adopt**——对应 pi `mutation-line` 的 Effect 化形态 |
| 12 | LLM Route/protocol/provider 拆分；`stream: Stream<LLMEvent, LLMError>`、`generate: Effect<LLMResponse, LLMError>` | packages/llm | **adapt**——ai 包已有 providers/api 同构拆分，Effect 化时把 stream 边界收成 Service 即可，不重写协议层 |
| 13 | Effect HttpApi/HttpRouter server | opencode/src/server | **defer**——TG 无 server 包 |

## 3. 总体策略（三原则）

1. **领域架构不换血**：pi 的 lane/drive/Storage/conformance 是已验证资产；Effect 只换机制层，任何 drive/lane/structural 内核重写提案一律拒绝（见 4-Phase2 禁区）。
2. **服务边界先行**：先把跨包/跨进程的面（LLM stream、harness 事件、session 读取、组合运行时）收成 Effect Service + Layer，包内实现按需渐进。
3. **conformance 是安全网**：sqlite-bun storage/session-repo conformance、agent drive/lane 全套测试是每阶段验收线；Effect 化不得降低测试语义，测试文件随实现改动最小化。

### Effect v4 翻译词典（增补 opencode 条目，承接 agent-catchup-plan 的词典）

| opencode 写法 | TG 约定 |
|---|---|
| `Context.Service<Service, Interface>()("@opencode/X")` | 同款，tag 命名 `@tg/X`（ai 包 `AuthResolverService` 先例） |
| `makeGlobalNode` / LayerNode | 暂以手工 `Layer.provideMerge` 组合；chord 定位 ADR 后再评 |
| `ManagedRuntime.make` + `service-use` Proxy | 新增 `agent/src/harness/effect-runtime.ts`（Phase 2.4），桥接 chord/未来 server 的非 Effect 调用点 |
| `Stream.runForEach` | 既有 `EventStream` 提供 Stream 适配，不迁移既有消费方签名 |
| `Effect.fn("name")` 可观测 span | tg-telemetry span 约定（`tg.*` 命名空间） |
| `keyed-mutex` | `mutation-line` 串行化屏障的 Effect 实现（语义等价替换，conformance 兜底） |
| `Effect.catchDefect` 幂等对账 | 用于 Storage 提交后的发布路径（Phase 3.3） |
| SqlClient / Drizzle | 不引入；`Storage`/`SessionRepo` 契约与 `001_initial.sql` 不变 |

## 4. 分阶段计划

### Phase 0 — 基线整顿（0.5–1 人日）

- [ ] 0.1 effect 版本定版：全仓 `4.0.0-rc.111`（新于 opencode 的 beta.83+patch）；在本文档记录 beta→rc 间已知的 API 差异面（`Context.Service` 取代 `Context.Tag`/`Effect.Service` 已确认），后续升级 effect 只允许全仓同版本原子变更
- [ ] 0.2 清理声明未用的 effect 依赖：chord（src/test 零 import，Phase 5 决策前先移除）；agent/sqlite-bun 视 Phase 2/3 落地时间决定移除或保留（保留须在本表登记用途）
- [ ] 0.3 ai/telemetry Effect 使用盘点收编为风格基准（tryPromise 错误分型、Service tag 命名、Layer 组合层级），并入 §3 词典
- [ ] 验收：全仓 typecheck 0 错误 + 5 包测试绿（基线：agent 590 / ai 1860 / chord 162 / telemetry 16 / sqlite-bun 105）

### Phase 1 — ai 包收口为 LLM Service（2–3 人日）

- [ ] 1.1 定义 `LLMClient` 形态服务（opencode llm 的 Interface/Service/layer 三件套）：`stream: Stream<...>` / `generate: Effect<...>`；落点 `packages/ai/src`，整合 models 层既有 3 个 Layer 与 `.lazy` api 层，协议/供应商拆分保持不动
- [ ] 1.2 `stream-fn.ts` 默认流函数边界收编：默认实现走 Service，保留 `setDefaultStreamFn` 兼容别名（agent proxy/streamProxy 依赖此面，不得破坏）
- [ ] 1.3 错误分型统一：`LLMError`/`NonRetryableError`/`AbortedError` 沿既有分类收进 Effect error channel，29 处 tryPromise 补齐类型标注
- [ ] 验收：ai tsc 0 + 全测试绿；agent 包零回归（agent 以公共 API 消费 ai，接口形状变化须同步）

### Phase 2 — agent 服务边界 Effect 化（3–5 人日，不动 runtime 内核）

- [ ] 2.1 `harness/context.ts` 的 `Context`/`ContextKey` 正式化为 `Context.Service`（catchup 1.3 已做语义对齐，此步只收 API 形状）
- [ ] 2.2 `events.ts` 总线增加 Effect PubSub/Stream 适配层：保留 `HarnessEventBus` 现有 API，内部双轨——为 TUI/进程分离铺路（事件形状仍须可序列化）
- [ ] 2.3 `execution/assistant.ts` + `execution/tools.ts`：Effect.tryPromise 包装规范化（abort 传播统一走 ai 包 `raceWithAbortSignal` 助手；工具批次的持久化语义不动）
- [ ] 2.4 新增 `harness/effect-runtime.ts`：ManagedRuntime + service-use Proxy 桥，供非 Effect 调用点（chord facets、远期 server）消费 agent 服务
- [ ] 2.5 **禁区**：`runtime/drive/**`、`lane.ts`、`structural.ts`、`reducer.ts` 不改写——手写持久化过程是上游资产，重写即重放语义回归风险
- [ ] 验收：agent tsc 0 + 48 文件测试绿；drive/lane 恢复语义测试**零改动**

### Phase 3 — 会话层 Effect 化（2–3 人日）

- [ ] 3.1 `SessionStore` 形态只读服务（opencode store.ts 模式）：包装 `SessionReader` 面；pi 的 `Session` 自带 id 保留，"no layer takes a Session ID" 仅约束服务定位器不接收会话 id 参数
- [ ] 3.2 `mutation-line` 串行化屏障替换为 keyed-mutex 的 Effect 实现（可回退开关；替换前后 conformance 全绿为准）
- [ ] 3.3 提交后发布不变量固化：post-commit publish 不得先于事务提交；幂等对账走 `Effect.catchDefect`（opencode ADR 不变量直接引用）
- [ ] 验收：storage/session-repo conformance 全绿 + sqlite-bun 105 项零回归

### Phase 4 — sqlite-bun 机制现代化（1–2 人日，可与 Phase 3 并行）

- [ ] 4.1 PRAGMA 收口：`journal_mode=WAL`、`busy_timeout` 等统一在 adapter 打开路径设置（对齐 opencode `database.ts` 惯例），migrations 内的 PRAGMA 逐条核对归属
- [ ] 4.2 评估不落地：Effect `SqlClient` 内部适配（对照 opencode `sqlite.bun.ts` 183 行：1-permit Semaphore 连接获取、`Effect.addFinalizer(close)`、fiber Context 传 SafeIntegers）；结论写回本文档 §2.2#6
- [ ] 4.3 验收：adapter/repo/storage/sql conformance 全绿 + 纯 Bun 化回归（`grep "from \"node:"` 保持零命中）

### Phase 5 — 组合运行时与远期（另案入口，本轮只出 ADR）

- [ ] 5.1 chord 定位 ADR：chord（facets/services 组合运行时）与 LayerNode DAG 的关系——互补（chord 管插件/manifest，LayerNode 管 Effect Layer 图）还是替代；决定 chord 是否引入 effect
- [ ] 5.2 上游 `protocol`/`server`/`client` 引入评估（依赖 chord 与 Phase 2.4 的运行时桥）；TUI 路线图另案
- [ ] 5.3 telemetry → `@effect/opentelemetry` 桥评估（opencode 同款依赖已验证）

## 5. 依赖关系与里程碑

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3 ──► Phase 5
                │                       ▲
                └──► Phase 4 ───────────┘（4.1 可与 3 并行；4.2 结论喂给 5.1）
```

- 总量约 9–14 人日；Phase 1/2 是主干，Phase 3/4 是会话机制收尾，Phase 5 全部 ADR 化后另案。
- 每阶段收尾动作统一：全仓 `tsc --noEmit` 零错误 + 5 包测试绿 + conformance 全绿；禁止跨任务留红。

## 6. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| effect rc.111 与 opencode beta.83+patch 的行为差异 | 借用的模式在新版上失效 | 每个 adopt 模式落地时以 opencode 源文件为规格、TG 测试为准；差异写回 §2.2 |
| 双轨期 API 分裂（Effect 服务 vs plain API 并存） | 调用方困惑、泄漏两套风格 | Phase 2.4 的运行时桥统一入口；旧 API 标记 deprecated 并给出迁移路径 |
| Effect 化诱发 drive 内核重写冲动 | 重放/恢复语义回归（catchup 3d 的 3.2k 行是最大单点风险） | §4-Phase2.5 明文禁区；评审时以"测试零改动"为硬标准 |
| conformance 语义漂移 | 会话兼容性破坏 | Phase 3/4 每步跑 conformance；mutation-line 替换带可回退开关 |
| chord 定位摇摆（组合运行时 vs LayerNode） | Phase 2/5 重复建设 | 5.1 ADR 先行，ADR 未决前不往 chord 加 Effect 代码 |

## 7. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-14 | 初版：基于 pi-main 0.85.1 快照（agent/sqlite-bun 追赶已完成，见另两份 plan）与 opencode-dev Effect 化调研（core/effect-*、llm、specs ADR）制定；采用判定 13 项（adopt 5 / adapt 3 / defer 3 / skip 2 / 记录结论 1 反射自 §2.2），分六阶段，总量 9–14 人日 |
