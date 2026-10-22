# sec-agent → gibraltar 接线复盘：durable 缺口与 agent loop 契约比对

状态：审查完成，未开始修复
分支：`V2`（V1 冻结不适用于本批工作）
前置：接线已在工作区落地，**未提交**（`packages/sec-agent/src/core/harness/` 为新增目录，`sdk.ts`/`agent-session.ts` 已改）
日期：2026-10-22
证据基线：`bun run check:types` 通过；`bun run check:house-standard` 通过（8 house + 2 vendored）；`bun run test packages/sec-agent` = 2613 passed / 6 failed / 50 skipped，12 个测试文件失败

---

## 0. 结论摘要

1. **接线只完成了一半**：引擎的"调度壳"换成了 gibraltar 的 `Harness`，但 durable 那半完全没接上——生产路径恒为 `MemoryStorage`，没有会话定位键，`resume()` 从未调用，`retry`/`compaction`/`env`/documents 一律关闭或不用。会话唯一真相源仍是 sec-agent 自己的 JSONL。
2. **旧 loop 的运行时代码已摘除，但契约没有**：`AgentEngine = Pick<Agent, 26 个成员>`，桥接层 2112 行的实质是逐条复刻 `agent-loop.ts` 的行为；`runToolCall` 仍在嵌套工具调用路径上被真实执行；且 `dist/` 是接线前的旧产物——**现在跑 `tg` 二进制跑的还是旧循环**。
3. **桥接层有 3 个 P0 已核实缺陷**（事件溢出丢批、监听器抛错报废引擎、submit 拒绝永久卡死队列）和 1 个已核实的可达退化（`finishTurn` 的 `end` 被忽略）。零专属测试，现有套件抓不到任何一条。

---

## 1. 接线现状

| 方面 | 事实 |
| --- | --- |
| 新增 | `packages/sec-agent/src/core/harness/`：`harness-agent.ts` 1635 行、`harness-events.ts` 248、`engine-tools.ts` 110、`harness-preflight.ts` 99、`engine-models.ts` 20 |
| 入口切换 | `sdk.ts:412` `new Agent({...})` → `await openHarnessAgent({...})`；`streamFn` 参数改名 `streamFunction` |
| 类型改动 | `AgentSessionConfig.agent` / `AgentSession.agent` 由 `Agent` → `AgentEngine`（`agent-session.ts:253,380`） |
| 新增依赖 | `package.json` 增加 `@OnePanda-TgSec/tg-gibraltar`、`@OnePanda-TgSec/chord`（`bun.lock` 已同步） |
| 分工声明 | 引擎桥拥有事件翻译与工具适配；`AgentSession` 继续拥有 retry、compaction、自己的 JSONL 文件（`CHANGELOG.md` Unreleased/Breaking 段） |

---

## 2. 旧 agent loop 依赖判定

| 层面 | 判定 | 证据 |
| --- | --- | --- |
| `Agent` 实例化 | **已摘除** | `packages/*/src` 内 `new Agent(` 零命中；仅 `packages/agent/test/agent.test.ts` 自用 |
| 运行时函数 | **仍在依赖** | `agent-session.ts:28` 值导入 `runToolCall`，`:749` 实际调用，来源 `packages/agent/src/agent-loop.ts:961` |
| 契约形状 | **仍绑死** | `harness-agent.ts:156-179` `Pick<Agent, 26>`；`agent-session.ts` 使用 22 个 loop 形状成员（`state` 29 次、`hasQueuedMessages` 7 次、`steer/followUp/prepareRequest/prepareNextTurn/finishTurn/beforeToolCall/afterToolCall` 各 1–2 次） |
| 事件词汇 | **仍是公共 API** | `AgentEvent`/`AgentLoopTurnUpdate` 经 `extensions/types.ts` 转发给扩展作者；`agent-session.ts:1107,1289-1291` 处理 `agent_start` |
| 构建产物 | **旧循环** | `dist/` 全部 254 个 `.js` 早于 2026-10-21；无 `dist/core/harness/`；`dist/core/sdk.js` 内仍是 `new Agent(` |

结论：源码不再运行循环，但循环仍是权威规范；实际交付物尚未重新构建。

---

## 3. 缺陷登记册

### S0 — durable 半边未接（接线本身的缺陷）

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| S0-1 | 生产恒用 `MemoryStorage`，无人传 `storage` | `harness-agent.ts:1598`；`sdk.ts:412-448` 无 `storage`；`packages/sec-agent/src` 内 `openNodeSqliteStorage`/`openDefaultSqliteStorage` 零命中 | 会话/条目/任务/文档退出即失；`backup()` 抛错（`gibraltar/src/storage/memory.ts:801`）；`health()/checkpoint()` 不存在 |
| S0-2 | project 隔离形同不存在 | `MemoryStorage` 的 `State` 无 project 字段（`memory.ts:74-96`）vs `SqliteStorage.project` 且每读过滤 `project_id`（`storage/sqlite/storage.ts:156,256,272`） | 一个文件容纳多项目的设计未被使用 |
| S0-3 | 无会话定位键、`resume()` 从未调用 | `harness.root(context, { agent })` 不带 `init`（`harness-agent.ts:1609-1628`，`init` 支持见 `harness.ts:70,315-320`）；sec-agent 内 `.resume()` 只命中 `process.stdin.resume()` | 崩溃恢复（`scheduler.ts:289-315` 的 running→pending 复位、`abandonOnRestart`）结构性失效：不报错，只是空转 |
| S0-4 | gibraltar 的 `retry`/`compaction` 显式关闭 | `engineSettings`：`harness-agent.ts:228-230` | 与"引擎拥有调度"的分工一致，但意味着 Harness 只提供内存调度器 |
| S0-5 | 未使用的 gibraltar 能力 | `HarnessOptions.env` 未传（`:1597-1604`）→ 工具在进程内执行（`engine-tools.ts:74`）；documents/LiveDoc/InboxDoc 的 `tx.doc` 写、`tool-search`、`codemode`、`images`、`usage()` 总量均无调用点 | sec-agent 各自保留自备实现，重复且口径不一 |

### P0 — 桥接层已核实缺陷（对照 `agent-loop.ts` 判定）

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| P0-1 | 事件积压超 100 帧时整批被丢弃 | `observation.ts:233-238`（`MAX_PENDING_WATCH_FRAMES = 100`，`:16`）+ `events.ts:184` 溢出以单个 `snapshot` 事件替换；桥接 `observe()` 无 snapshot 分支，落 `default: continue`（`harness-agent.ts:994-995`） | 被折叠的 `message_end`/`tool_execution_end`/`turn_end` 永不到达监听器 → 消息不落盘（`agent-session.ts:1148`）、回合不闭合、placement 不释放。触发条件：慢监听器（TUI）+ 输出突发 |
| P0-2 | 任一监听器抛错使引擎永久报废 | `observation.ts:266-271` `#terminate({reason:"listener_error"})`；桥接在 watch 回调内 `await` 监听器（`harness-agent.ts:1393`） | `waitForIdle()` 永不 resolve，回合卡死且无错误。loop 走 `handleRunFailure` 后仍可用（`agent.ts:541-545`） |
| P0-3 | `submit()` 被拒后所有队列永久卡住且完全静默 | `harness-agent.ts:1108-1110`（`.then(写 id, this.#report)`）→ placement 留 `queued:true, id:undefined` → `#submissionPending():1178-1183` 恒真 → `#requestRun():1191` 直接 return；且 `#report = options.onReport ?? (() => {})`（`:358`），`sdk.ts` 不传 `onReport` | 之后每一次 `steer`/`followUp` 无声无效。loop 的队列 push 不可能失败（`agent.ts:312-319`） |
| P0-4 | 提交前放弃的失败被伪装成正常 stop | `#finishTurnBoundary` 兜底 `#emptyMessage("stop")`（`:1061`）→ `#faulted=false`（`:1072`）→ `#continueRun` 可能再请求（`:1214`） | 回合以干净的 `stop` 结束，模型与用户都看不到失败。`CHANGELOG.md` 已自认，但低估了影响 |
| P0-5 | `finishTurn` 的 `{action:"end"}` 被忽略 | `harness-agent.ts:1078` 只记 `continue`；loop 见 `end` 立即 `agent_end` 返回（`agent-loop.ts:326-329`）。可达性已证实：`agent-session.ts:892` 原样返回 `previousDecision`（含 `end`） | 扩展无法终止运行 |

### P1 — 数据面与钩子面失真

| # | 缺陷 | 证据 |
| --- | --- | --- |
| P1-1 | `tool_execution_end` 的 `details` 张冠李戴：gibraltar 把工具真正的 `details/usage/durationMs` 放进 entry 的 `model[0]`，`data` 只装 `{diagnostics}`（`harness/tool.ts:851-858`），桥接却交 `details: entry.data`（`harness-events.ts:146`）→ TUI 渲染器读到诊断壳、工具 token/耗时归零（`modes/interactive/interactive-mode.ts:3613-3630`） |
| P1-2 | 流式工具输出二次方膨胀：`reportPartial` 每次把全量快照喂给追加语义的 `api.output()`（`engine-tools.ts:105-106` vs `harness/tool.ts:305-308`），而 `src/core/tools/bash.ts:287-319` 本来就报全量 |
| P1-3 | `tool_execution_update` 的 `args` 传 `{}`（`harness-agent.ts:933`），loop 传真参数（`agent-loop.ts:930`） |
| P1-4 | `abort()` 摧毁持久队列：`:502-504` → `conversation.abort()` → `withdrawQueuedInputs`（`harness/inbox.ts:160-168`）；loop 跨 abort 保留两个队列（`agent.ts:354-356`），而 UI 仍显示（`agent-session.ts:1123-1140`） |
| P1-5 | `beforeToolCall` 未必被询问：`#assistantByCall` 未命中即 `return undefined`（`:833-836`），`#afterTool` 以 `{} as AssistantMessage` 喂钩子（`:863`）；loop 每个 call 必问（`agent-loop.ts:863-872`）→ 恢复态/无 placement 的调用绕过权限与 block 钩子 |
| P1-6 | 引擎侧抛错不被捕获：`#askBeforeTool`（`:829-852`）与 `#afterTool`（`:855-873`）没有 loop 那样的 try/catch（`agent-loop.ts:860-921`、`:1037-1068`），扩展钩子抛错会变成 Harness 任务失败而非 error tool result |

### P2 — 契约细节偏离

| # | 项 | loop | 桥接 |
| --- | --- | --- | --- |
| P2-1 | `state.messages` 赋值 | 它就是 transcript（`agent.ts:104`） | 只换本地数组、不 sync、不进 Harness（`harness-agent.ts:1361`）；而 `agent-session.ts:942` 每次 compaction/branch 整体替换它 → durable 侧永远留着压缩前/被丢弃的条目 |
| P2-2 | `convertToLlm` 生效时机 | 每 run 取公开字段（`agent.ts:509` → `agent-loop.ts:432`） | 只在构造时拷贝，读 `#convertToLlm`（`:775`）→ 构造后赋值无效（当前无赋值者，潜在） |
| P2-3 | `getApiKey` | 每请求解析并作为 `apiKey` 下传（`agent-loop.ts:437-442`） | 字段收了（`:369/:399`）但 `dispatch`（`:588-600`）从不传 → 契约成员是死的 |
| P2-4 | `prepareRequest` 的 `model` 范围 | 写回 config，本 run 后续请求仍有效（`agent-loop.ts:248-260`） | `#requestModel` 只作用一次请求（`:578/:770`） |
| P2-5 | `prepareRequest` 的 `thinkingLevel` | 只改 `config.reasoning`，不碰 `_state` | 写回 `#thinkingLevel`（`:772`）→ 泄漏进 `state.thinkingLevel` |
| P2-6 | `continue()` 的队列 drain | 真 drain 队列并以其为新 prompt，含 `skipInitialSteeringPoll`（`agent.ts:407-421`） | 只 `#drainLocal`（`:557-558`），durable inbox 中的消息不搬入 |
| P2-7 | `reset()` | 清消息/队列/流式态（`agent.ts:369-380`） | 抛错条件一致，但不清 `#placements`/`#assistantByCall`，durable 条目不动 → 重开同一 conversation 带回 reset 前历史 |
| P2-8 | length 截断回合 | 整批判失败并回喂 "Re-issue the tool call"，回合继续（`agent-loop.ts:282-283,515-548`） | `generation.ts:480` 把 `length` 与 `stop` 同等对待：calls 被丢弃、无任何 tool result → **不会执行坏参数（比 loop 安全），但丢了重发反馈**，用户看到"调了工具却什么都没发生" |
| P2-9 | `hasQueuedMessages` 即时性 | 纯内存（`agent.ts:338`） | durable 半边只在 `submission` 事件到达时更新（`#notePlacements:1009`）→ submit 后到事件前返回 false |
| P2-10 | 失败回合的 `turn_end.toolResults` | 固定 `[]`（`agent-loop.ts:318`） | 带真实 `#turnToolResults`（`:1075`） |
| P2-11 | 未知工具文案 | `Tool X not found` 裸文本（`agent-loop.ts:855`） | `Tool X is not available` 套 `<harness>[error]` 信封 |

### P3 — 工程收尾

| # | 项 | 证据 |
| --- | --- | --- |
| P3-1 | `dist/` 未重建，`bin/tg` 仍跑旧循环 | 254 个 `.js` 全部早于 10-21；无 `dist/core/harness/`；`dist/core/sdk.js` 含 `new Agent(` |
| P3-2 | 桥接层零专属测试 | 仅两个 fixture 引用（`test/suite/harness.ts:195`、`test/test-harness.ts:411`）；无单测覆盖 `harness-events.ts`/`engine-tools.ts`/`harness-preflight.ts`；无任何测试传入真实 `Storage` |
| P3-3 | `docs/`+`examples/` 被物理删除，12 个测试文件因此失败 | `Cannot find module .../examples/extensions/*`（plan-mode、jev-router、trigger-compact、custom-compaction、git-merge、input-transform、subagent 回归、extensions-discovery、tool-renderer-examples）；`docs/docs.json`、`docs/models-configuration.md` ENOENT（documentation、references）。**与桥接无关** |
| P3-4 | 删除未收尾 | `package.json` 的 `files` 仍列 `docs`/`examples`；`tsconfig.examples.json` 仍 `include: examples/**`；README 2 处 docs 链接；`CHANGELOG.md` 反称这些文件"已随包本地化" |
| P3-5 | 边界声明与校验不一致 | `AGENTS.md` 正文未把 `chord` 记入 sec-agent 依赖（实际 `package.json` 声明且 `harness-agent.ts:1-2`、`engine-tools.ts:1`、`harness-events.ts:1` 在导入）；`check:house-standard` 不校验依赖边（`scripts/check-house-standard.ts:220-241`）；`packages/chord/test/boundary.test.ts:15,26-32` 只证明 chord 是叶子 → "边由 boundary 测试验证"对新边不成立；`packages/sec-agent/tsconfig.build.json` paths 缺 `chord`/`tg-gibraltar`（构建靠 `node_modules`→`dist` 兜底） |
| P3-6 | 引擎所有操作跑在 `BACKGROUND_CONTEXT` 下 | `harness-agent.ts:357`、`:1607`——取消/截止/追踪是否应按会话作用域传播，待判定 |
| P3-7 | 会话目录写读不一致（**既有问题，非本轮引入**） | 写：`getDefaultSessionDirPath` 用 `getAgentDir()` → `~/.config/TianGong/sessions/…`（`session-manager.ts:589-594`）；读：`SessionManager.listAll` 扫 `getSessionsDir()` → `~/.local/share/TianGong/sessions`（`:1949`），调用点 `main.ts:273`、`interactive-mode.ts:5718`。仅设 `TG_CODING_AGENT_DIR` 时两者重合。按 AGENTS.md，机器生成态属 data 目录，写侧选错 |

---

## 4. 已核实一致（无需改动，作为回归基线）

`state` 的 `systemPrompt/model/thinkingLevel/tools/isStreaming/streamingMessage/pendingToolCalls/errorMessage` 形状与写入时机；`subscribe`/退订；`signal`；`waitForIdle` 语义；`steeringMode/followUpMode` 读写；`peekQueuedMessages` 优先序；`clearAllQueues` 效果；`prompt()` 冲突抛出文案与输入归一化；`continue()` 三种抛出文案；`reset()` 抛错条件与 baseline 保留；`agent_start`/`agent_end` 归属与 `agent_end.messages` 只含本次新增；失败 assistant 消息的字段形状（`#emptyMessage` ↔ `agent.ts:549-559`）与四连事件；`transformContext`；`sessionId/transport/thinkingBudgets/maxRetryDelayMs/onPayload/onResponse/onProviderStreamEvent/reasoning` 下传；`declareToolChanges` 的 loadout 声明（逐行同构）；`afterToolCall` 的合并语义（含 `structuredContent` 三态删除）；block 调用的 terminate 保形。

---

## 5. 审查过程中的更正（先前过度断言）

1. `length` 截断**不是**"可能执行被截断的参数、写坏文件"：gibraltar 根本不执行这些 call（`generation.ts:480`）。真实退化见 P2-8。
2. `#begin()` 未重置 `#failures/#nextTurn/#continueRequested`：非缺陷——`#finish`（`:1315-1331`）在每次 invocation 结束已全清，`#begin` 只在 `#active === undefined` 时进入。同理 `#partial` 跨调用污染不成立（`:1318-1319`）。
3. `afterToolCall` 对被 block 的调用：与 loop 等价（loop 的 immediate 路径同样不跑 afterToolCall，`agent-loop.ts:880-890`）。
4. 权限三成员（`permissionRules/onPermissionAsk/permissionGrants`）未进 `AgentEngine`：无影响——sec-agent 全仓零引用，`agent-session.ts:749` 的 `runToolCall` 也未传。权限层目前是 loop 侧的死面。
5. "失败时 `turn_end` 三连重复"：未证实，降级为待探针。
6. 早前一条口径错误已纠正：`bun run test packages/sec-agent` **不是**全绿（管道退出码掩盖了真实结果），实际 6 个测试失败 / 12 个文件失败，原因见 P3-3。

---

## 6. 待运行时探针（每条应写成先失败后通过的回归测试）

| # | 探针 | 关联缺陷 |
| --- | --- | --- |
| 探-1 | `finishTurn` 返回 `{action:"end"}` 时运行是否真被终止 | P0-5（可达性已确认，效果未观测） |
| 探-2 | `#submitMarker` 的空文本 durable input 在 `submission` 事件与 `message_end` **分属两批**时，是否经 `#endMessage:1019` 的 `entry.model[0]` 回落而真的发出并落 JSONL | 契约项：loop 的 context-only 续跑回合（`agent-loop.ts:348-351`） |
| 探-3 | TUI 慢监听下 100 帧溢出是否真能触发 | P0-1 |
| 探-4 | `#assistantByCall` 在长会话（数千次工具调用）下的驻留量 | `harness-agent.ts:1030` 只有 `.set`，`#finish`/`reset` 均不清 |

---

## 7. 修复排序

前三项加 P0-5 属桥接侧独立改动，可先于 durable 决策进行：

1. **监听器隔离**（P0-2）：`#emit` 内逐个 try/catch，抛出转 loop 等价的 `handleRunFailure` 路径，绝不让单个扩展拖死引擎。
2. **submit 拒绝回滚**（P0-3）：拒绝时删除/复位 placement 并抛给可见出口；同时让 `sdk.ts` 传 `onReport`（当前 `#report` 是空函数 sink）。
3. **snapshot 事件分支**（P0-1）：`observe()` 处理溢出快照——重投快照并补齐未闭合回合。
4. **遵守 `finishTurn` 的 `end`**（P0-5）。
5. **数据面**（P1-1/P1-2/P1-3）：`details/usage/durationMs` 取自 entry 的 `model[0]` 而非 `data`；partial 改为增量；补 `args`。
6. **钩子面**（P1-5/P1-6）：每个 call 必问 `beforeToolCall`；给 `#askBeforeTool`/`#afterTool` 加 loop 同形的 try/catch。
7. **abort 保留队列**（P1-4）。
8. **durable 决策**（S0 全部）：传真实 SQLite storage、以 `init` 写会话定位键、启动时 `resume()`；然后回答 P2-1 的单一真相源问题——要么 JSONL 降级为导出格式、由 Harness entries 承担，要么明确 Harness 只做 task 层并删掉 `MemoryStorage` 默认值。
9. **收尾**（P3 全部）：`bun run build`；决定 `docs/`+`examples/` 是恢复还是连带清理测试与 `files`/`tsconfig.examples.json`/README；同步 `AGENTS.md` 依赖清单与边图。

---

## 8. 本次审查执行过的验证

| 命令 | 结果 |
| --- | --- |
| `bun run check:types` | 通过（两个 type program 均无错） |
| `bun run check:house-standard` | 通过（8 house、2 vendored，vendored 冻结项断言成立） |
| `bun run test packages/sec-agent` | 2613 passed / 6 failed / 50 skipped；12 文件失败，全部为 P3-3 的 `docs/`+`examples/` 连带 |
| 静态核对 | `AgentEngine` 26 成员逐一对照 `agent.ts`/`agent-loop.ts`；`MemoryStorage`/`storage` 传参全仓 grep；`resume()`/`init`/`onReport` 传参点全仓 grep；`runToolCall` 引用点；`dist/` 时间戳与内容 |
