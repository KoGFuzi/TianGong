# agent 包追赶上游规划（Effect v4 架构）

> 对照基线：`/run/media/J/Workspace/Code-Testing/pi-main/packages/agent`（下称"上游"）
> 目标：将 TG `packages/agent` 对齐上游现行架构，全程保持 Effect v4 化，为 TUI 落地备齐地基。
> 状态标记：`[ ]` 未开始 / `[~]` 进行中 / `[x]` 完成 / `[!]` 受阻（附原因）

## 0. 背景与现状

| 指标 | TG | 上游 |
|---|---|---|
| 代码量 | 17,543 行 / 71 文件 | 24,282 行 |
| 执行核心 | `harness/drive/` + `effect.ts` + `operation.ts` + `reducer.ts`（约 1,250 行，Effect 化的旧版结构） | `harness/runtime/` + `execution/`（约 7,900 行，现行架构） |
| 会话层 | 旧版 jsonl/memory | 新增 values、mutation-line、commit、fork、legacy-v3 迁移、conformance/benchmark 测试体系 |

**关键事实**：上游 `runtime/` 不是实验分支——`agent-harness.ts` 已是 `runtime/harness.ts` 的门面（`createAgentHarness` 自 runtime 导入），必须跟进。

**核心决策**：
1. TG `drive/` 的价值是 Effect 惯用法（作"翻译词典"），逻辑已过时；Phase 3 以上游 `runtime/` 为基准重放 Effect 化，完成后整体替换旧 `drive/`。
2. chord 解耦成本极低：上游 agent 仅 3 个文件、纯类型导入（`Context`/`ContextKey`、`JsonValue`、`JsonRepresentation`）。
3. 所有消息/事件形状保持可序列化，为未来 TUI/agent 进程分离留门。

**前置已就绪**（ai 包同步完成）：`assistant-message-frame`、`providerThinkingLevel`、`uuidv7(timestamp)`、`streamDeferred`。

## Effect v4 翻译词典（全程适用）

| 上游写法 | TG 约定（均有先例） |
|---|---|
| Promise 链 + AbortSignal 手工竞速 | `Effect.tryPromise` + `raceWithAbortSignal`（ai 包模式） |
| 事件回调订阅 | Effect `Stream` / `AssistantMessageEventStream` |
| chord `Context` / `ContextKey` | `Context.Service` + `Layer`（`AuthResolverService` 先例） |
| chord `JsonValue` / `JsonRepresentation` | 本地 `JsonValue`（types.ts）+ 边界校验 |
| 命名 `Pi*` / `pi-*` | `TG*` / `tg-*`（tg-messages 重命名先例） |
| vitest 测试 | 直接 import `bun:test`；少量 conveniences 走各包 `test/utils/testing.ts`（poll/waitFor/advanceTimersByTimeAsync/stubGlobal/expectTypeOf/mockModule/hoisted/stubEnv 等） |

每阶段收尾动作统一为：`packages/ai` + `packages/agent` 双包 `tsc --noEmit` 零错误 + 相关测试绿。

---

## Phase 1 — 类型与协议对齐（低风险，约 1-2 人日）

- [x] 1.1 对齐 `harness/session/types.ts`（漂移 887 行）；chord `JsonValue` 改为本地导入，re-export 同步调整
- [x] 1.2 对齐 `harness/types.ts`（158）与 `harness/events.ts`（411）
- [x] 1.3 移植上游新增 `harness/context.ts`：chord `Context`/`ContextKey` 用 Effect `Context.Service` 表达，语义对齐（取消传播 + 调用作用域值）
- [x] 1.4 移植上游新增 `harness/config.ts`
- [x] 1.5 旧类型若与新结构冲突，先加兼容别名过渡，Phase 3e 统一清理
- [x] 1.6 验收：双包 typecheck 零错误；现有测试全绿

## Phase 2 — 会话存储层（中风险，约 3-5 人日）

- [x] 2.1 移植新文件 `session/values.ts`（会话值类型，衔接 `assistant-message-frame`）
- [x] 2.2 移植 `session/mutation-line.ts` + `session/commit.ts`（变更行与提交语义）
- [x] 2.3 移植 `session/fork.ts` + `fork-policy.ts`（会话分叉）
- [x] 2.4 移植 `session/in-memory-storage-state.ts`、`session/jsonl/index.ts`
- [x] 2.5 移植 `session/jsonl/legacy-v3.ts`（旧格式迁移，依赖 `uuidv7(timestamp)` follower id——已就绪）
- [x] 2.6 消化漂移：`jsonl/repo.ts`（617）、`jsonl/storage.ts`（583）、`jsonl/codec.ts`（328）
- [x] 2.7 消化漂移：`session/memory.ts`（566）、`session/session.ts`（890）
- [~] 2.8 处置 TG 独有旧文件：已全部迁入 `session/legacy/`（连同 legacy jsonl/testing），能力盘点与删除推迟到 3e 随旧 harness 核心一并清理
- [x] 2.9 引入上游测试体系：`session/testing/conformance/{session-repo,storage}.ts`、`benchmark/*`
- [x] 2.10 验收：conformance 套件绿；会话写入/读取/恢复回归通过

## Phase 3 — 执行核心重构（最难，约 14-22 人日，分五步）

### 3a execution/ 拆分层（1-2 人日）
- [x] 移植 `execution/assistant.ts`（LLM 调用）、`execution/effect-gate.ts`、`execution/tools.ts`（工具执行），约 600 行
- [x] 用它校准 Effect 化手感：`Effect.tryPromise` 包装、错误分型（`LLMError`/`NonRetryableError`/`AbortedError`）
- [x] 验收：现有 bash/read/write/edit 工具在新执行层下测试绿

### 3b runtime 骨架——TUI 地基，优先级最高（3-4 人日）
- [x] 移植 `runtime/types.ts`、`runtime/index.ts`、`runtime/reducer.ts`（232）
- [x] 移植 `runtime/harness.ts`（408，Harness 管理 lanes 但自身不是 lane）
- [x] 移植 `runtime/progress.ts`（渲染进度——TUI 实时显示依赖）
- [x] 移植 `runtime/transcript.ts`（转写重放）与 `runtime/restore.ts`（会话恢复）
- [x] 验收：progress/transcript/restore/watch 测试绿（runtime 测试全部移植并通过）

### 3c drive 内核（4-6 人日）
- [x] `runtime/drive/boundary.ts`（259）、`generation.ts`（302）：代际管理与边界
- [x] `runtime/drive/response.ts`（484）：响应处理（含 `providerThinkingLevel` 透传）
- [x] `runtime/drive/tool-placement.ts`（326）+ `drive/tools.ts`（692）
- [x] `runtime/drive/deferred.ts`（287）：延迟响应（衔接 ai 包 `streamDeferred`——已就绪）
- [x] `runtime/drive.ts` 主循环
- [x] 验收：drive-public/drive-generation/drive-retry-deferred/drive-tools 等测试绿

### 3d 高级恢复语义（5-8 人日，单独立项、独立验证）
- [x] `runtime/lane.ts`（2,012）：lane 执行模型
- [x] `runtime/drive/structural.ts`（1,221）：结构化重放
- [x] `drive/checkpoint.ts`（190）、`recovery.ts`、`retry.ts`、`terminal.ts`、`reconcile.ts`
- [x] 验收：lane.test、drive-structural.test、drive-terminal.test、drive-reconcile.test 绿

### 3e 门面合并与旧结构清除（1-2 人日）
- [x] `agent-harness.ts`（漂移 1,562）改为 runtime 门面（对齐上游做法）
- [x] 删除 TG 旧结构：`harness/drive/`、`harness/state/`、`harness/effect.ts`、`harness/operation.ts`、旧 `harness/reducer.ts`、`legacy-hooks.ts`、`session/legacy/` 全部
- [x] 清理 Phase 1 的过渡别名（legacy-types.ts 已随 session/legacy 一并删除）
- [x] 验收：index.ts 对齐上游导出；全量测试绿

## Phase 4 — 横切收尾（低风险，约 2-3 人日）

- [x] 4.1 `harness/hooks.ts`（漂移 552）——因 3a 测试依赖提前完成，旧 `HarnessHookRegistry` 移入 `legacy-hooks.ts` 过渡
- [x] 4.2 `harness/compaction/compaction.ts`（359）——含 branch-summarization/utils，随 runtime 依赖提前完成
- [x] 4.3 `harness/env/nodejs.ts`（341）
- [x] 4.4 `utils/shell-output.ts`（241）、`tools/bash.ts`（178）
- [x] 4.5 验收：全量测试绿

## Phase 5 — 测试体系与总验收（持续）

- [x] 5.1 按既有流程批量移植上游 agent 测试（bun-test shim + 命名替换）；TG 独有旧测试随旧结构删除，上游测试全部就位
- [x] 5.2 总验收清单（即 TUI 前置能力）：
  - [x] progress：实时渲染进度事件流
  - [x] restore：会话恢复
  - [x] transcript：转写重放
  - [x] assistant-message-frame：紧凑渲染帧
  - [x] 事件形状可序列化（进程分离后门保持打开）

---

## 并行与依赖关系

```
Phase 1 ──► Phase 2 ──► Phase 3a ──► 3b ──► 3c ──► 3d ──► 3e ──► Phase 4 ──► Phase 5
                                    (3a/3b 可与 pi-tui 组件库移植并行,互不依赖)
```

- pi-tui 移植（另案）零 agent 依赖，可与 Phase 1/2、3a/3b 并行
- Phase 3d 前必须 3b/3c 全绿；lane + structural 合计 3.2k 行是全计划最大单点风险

## 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| `lane.ts`/`structural.ts` 恢复语义移植失真 | 中断恢复/重放出错 | 放最后、独立验证、先移植上游对应测试做规格 |
| Effect 化与上游演进方向冲突（上游后续再重构） | 返工 | 每阶段完成后打 tag；跟进上游时按文件级 diff 增量同步 |
| TG 独有文件（effect-handle/instrumented 等）承载自定义能力 | 误删 | 2.8 逐个盘点：能力已覆盖→删；独有→并入新结构 |
| 双包 typecheck 在中间态长期红 | 无法定位回归 | 每个任务收尾即恢复绿；禁止跨任务留红 |

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-06 | 初版：基于 pi-main@2026-09-03 快照的全量 diff 制定 |
| 2026-09-12 | Phase 3b/3c/3d/3e + 4.2 + 5.1/5.2 完成：runtime 全层（含 lane/structural）与上游 622 行门面整体移植；旧 harness 核心（operation/reducer/effect/state/drive/legacy-hooks/session-legacy）删除；compaction 对齐上游；chord `JsonRepresentation` 以本地映射类型替代；bun-test shim 扩展（不对称匹配器/toMatchObject/expect.poll/fake timers）；已知怪癖：bun test 个别文件全绿后进程不退出，用 `scripts/test-per-file.sh` 按文件跑（48 文件全绿）；测试 704 项全过，双包 tsc 零错误 |
| 2026-09-12 | Phase 3a 完成：execution/ 层与测试移植；事件词汇对齐上游（HarnessEventPayload 等定义移入门面，events.ts 只留总线，旧事件载荷形状更新）；telemetry.ts 一并对齐（span 名 pi.→tg.，参考文档已重新生成）；4.1 hooks.ts 提前完成 |
| 2026-09-12 | Phase 2 完成：旧 session 层整体迁入 `session/legacy/`（供旧 harness 核心继续运行，3e 删除），上游新 session 层（values/mutation-line/commit/fork/fork-policy/in-memory-storage-state/memory/session/jsonl 全套 + testing conformance/benchmark）已移植，存储命名空间 `pi.*`→`tg.*`，`messages.ts` 的 `fromId` 放宽为 `string | null`；测试从 475 增至 667 |
| 2026-09-12 | Phase 1 完成：1.1 旧 session 类型移入 `session/legacy-types.ts` 过渡（3e 清理），`values.ts` 随 1.1 提前移植；1.2 级联提前完成 Phase 4.3（`env/nodejs.ts`）与 4.4（`utils/shell-output.ts`、`output-capture.ts`、`adaptive-publisher.ts`、`truncate.ts`、`tools/*`、`skills.ts`、`prompt-templates.ts`）；根 tsconfig 移除 `noUncheckedIndexedAccess` 以对齐上游编译口径；ai 包 kimi-coding 既有 typecheck 错误顺手修复 |
| 2026-09-12 | 总验收（5.2/Phase 4 收尾）完成，全计划 Phase 1–5 关闭：4.3 补漏 `pi-output-`→`tg-output-` 临时文件前缀重命名并同步测试 mock；4.3/4.4 与上游归一化 diff 仅该前缀 1 行（shell-output/bash 为 0），`runtime/transcript.ts` 与上游一致；agent 包按文件跑 48 文件全绿（drive-reconcile 系 runner 不退出怪癖，按脚本规则判定），ai 包 142 文件 1860 项测试 0 失败（852 项凭证类 e2e skip），双包 `tsc --noEmit` 零错误 |
| 2026-09-12 | 修复 bun test 不退出怪癖，`test-per-file.sh` 的 timeout 兜底不再是必需品：根因是 bun 1.3.14 mock clock 的缺陷——假时钟激活期间只要有真定时器回调触发（drive-reconcile 的 `vi.waitFor` 轮询即此），mock clock 的 native timerfd 残留，进程在 `epoll_pwait2` 上永久挂起；修复为 drive-reconcile 改用 `spyOn(Date, "now")` 冻结时钟（该用例只需要 Date.now 恒定，不需要 mock clock），bun-test shim 的 `waitFor`/`poll` 固定用模块加载时捕获的真时钟（轮询工具语义上不参与假时钟）。验收：`bun test test` 整目录 2s 自然退出（589 pass/0 fail/48 文件），按文件跑 48/48 零超时杀，agent 包 tsc 零错误 |
| 2026-09-12 | agent 测试完成 vitest 兼容层退役（"vitest 换成 bun test"）：`test/bun-test.ts` shim 删除，48 个测试文件 + session-test-utils 直接 import `bun:test`（`vi.fn`→`mock`、`vi.spyOn`→`spyOn`、timers→`jest.*`、`mock.restore()`）；无原生对应的少量能力收敛为纯 bun 逻辑助手 `test/utils/testing.ts`（`poll`/`waitFor`/`advanceTimersByTimeAsync`/`stubGlobal`/`unstubAllGlobals`/`expectTypeOf`）；`expect.not.stringMatching`（shim 语义=精确不等）改写为 `not.toBe`；两处嵌套在 toMatchObject 普通对象里的非对称标记改为独立断言（bun 不支持嵌套标记，已在 testing.ts 头部注明）；shim 松类型移除后暴露 4 处严格类型收窄（`!`/`as unknown` 收尾）。验收：根级 `bun test packages/ai/test packages/agent/test` 自然退出（1597 pass/0 fail/190 文件/5.8s），agent tsc 零错误。ai 包仍有自己的 shim（`vi.mock`×28、`vi.hoisted`×25、`stubEnv`、54 处 advanceTimersByTimeAsync），退役需迁移 mock.module 语义，另案 |
| 2026-09-12 | ai 包 vitest 兼容层退役完成（承接上一条"另案"）：`packages/ai/test/bun-test.ts` 删除，136 个测试文件直接 import `bun:test`；`vi.mock`→`mockModule`（保留 afterAll CJS require 恢复钩子，非 isolate 组合跑防跨文件 mock 泄漏）、`vi.hoisted`→恒等 `hoisted`、timers 助手原样保留 shim 的"激活即冻结 Date.now"语义（20 个 OAuth/重试用例依赖，bun 的 jest.setSystemTime 覆盖不到该行为）、`stubEnv`/`unstubAllEnvs`/`stubGlobal`/`waitFor`/`poll` 收敛进 `test/utils/testing.ts`；`describe.sequential`（shim 中本就恒等 describe）与 `describe.skipIf`（bun 原生已支持）直接平替。验收：ai 全量 `bun test --isolate` 1008 pass/0 fail/142 文件 17s 与迁移前基线一致；根级非 isolate 组合跑 2450 项测试全绿 5.9s（恢复钩子路径实测）；src/test 双 tsc 零错误。至此两包测试全部原生 bun:test 化，vitest 兼容层清零 |
| 2026-09-12 | 全仓验收（4/5 绿）：ai 1860 项 0 fail（17s，src+test tsc 零错误）、agent 590 项 0 fail（2s，tsc 零错误）、chord 162 项 0 fail（tsc 零错误）、telemetry 16 项 0 fail（tsc 零错误）；根级非 isolate 双包组合 2450 项全绿 6s。**已知问题：`session-backends/sqlite-bun` 红**（测试 5 pass/14 fail/14 errors + 约 300 处类型错误）——整包按 Phase 2/3 之前的旧 session API 编写，被追赶重构甩下：运行时 `Export 'SessionError' not found` 崩溃，旧 `Session.appendMessage/commit/getRegister` 等方法、`createSessionBackendConformance` 装置、`BranchSummaryEntry.fromHook`/`CommitResult.stats`/`storageVersion` 等形状均需对齐新 API。处置：本轮记录不修，**待办：sqlite-bun 新 session API 移植（Phase-2 级别工作量）** |
| 2026-09-12 | sqlite-bun 移植完成（方案见 `docs/sqlite-bun-port-plan.md`，参照上游 pi sqlite-node v0.85.1 + opencode effect-sqlite 交叉参考）：旧 TG 特有实现（lanes/registers/facts/writer-leases 等）整体废弃，上游 1,850 行 src + 6 个测试文件搬入并做 pi→TG 重命名；新写 bun:sqlite 适配器替代 node:sqlite，修复 3 处运行时行为差异（get() 空结果 null→undefined 归一、`{create:false}` 缺陷改 readwrite 组合、命名参数前缀语义）；tsconfig 对齐 workspace 源码 paths + DOM lib。**全仓验收 5/5 绿**：sqlite-bun 105 项 0 fail（0.7s，tsc 零错误）+ ai 1860 + agent 590 + chord 162 + telemetry 16 全绿，根级双包组合 2450 项全绿 |
| 2026-09-12 | sqlite-bun 纯 Bun 化（移除全部 node: 依赖）：新增 `src/sqlite/bunfs.ts`（Bun.file/write/Glob/fileURLToPath + Bun.$ 内建 mkdir/rm + realpath + POSIX 路径原语 + createTempDirectory）；`repo.ts` 弃用 `wx` 预留文件（事务守卫覆盖受测语义，失败清理改 `filePreExisted` 守卫）、`list()` 目录 realpath 单次提升；migrations.ts 与 3 个测试文件同步换用；`node:` 导入清零。验收：105 项全绿（1.0s）+ tsc 零错误 + build 含 migrations + 根级双包组合 2450 项全绿 |
| 2026-09-12 | 测试框架 all-in-bun 收尾确认：全仓 vitest/jest 零残留（package.json 依赖、bun.lock、配置文件、源码导入均为零；两处 bun-test shim 文件已删除；两个 `test/utils/testing.ts` 中 vitest 字样注释措辞清理；`jest` 仅作为 bun:test 自带 API 使用）。全部 6 个 test 脚本（5 包 + 根）均为 `bun test`。终态验收 5/5 包全绿：agent 590 / ai 1860 / chord 162 / telemetry 16 / sqlite-bun 105，0 fail |
