# 上游 pi 1.1.0 → 1.3.0 移植工程基线（tg-gibraltar）

> 生成于 2026-10-17。上游参照物：本地 `F:/Code-Testing/pi-1.3.0`（已拷贝到 Fedora `/tmp/pi-130/packages/durable`；`@earendil-works/pi-durable` 1.3.0，2026-10-15）。本文件是 `tg-gibraltar` 从上游 1.1.0 升到 1.3.0 的**唯一 cherry-pick 与回滚基线**，覆盖上游 1.2.0 与 1.3.0 两个版本。
>
> 前置已就位：**vendored codemode/mcp = 1.3.0**（`sandbox.start()` 确定性重放是 G6 的依赖）；**chord = 1.3.0 wholesale**（2250212：`@OnePanda-TgSec/chord/output` 已可导入，`/context` `/delta` root 面不变）。
>
> 落点分支：**V2**。每批次独立可 revert 的 commit。命名规则照旧最高约束：`pi.*` 消息种 → `tg.*`、`Pi*` 标识符/错误名 → `Tg*`、`@earendil-works/pi-durable` → `@OnePanda-TgSec/tg-gibraltar`、`PI_*` → `TG_*`；**数据/协议字面量不翻译**。
>
> **结构对账**（2026-10-17 实测）：gibraltar `src/` 与上游逐文件对应（`harness/` 21 文件同名一一对应）；上游新增顶层 `codemode/`、`images/`、`search.ts`、`tool-search/`，`storage/sqlite/` 增 `schema.ts`（+ `cloudflare.ts` **不带回**），`tools/` 增 `image-processor.ts`，测试新增 harness-nested-tools(-restart)/structured-output/callers/cancellation-barrier/input-entries/storage-failure/scheduler-indexes/scheduler-retention/session-document-retention(+setup)/document-append-bench/scheduler-fanout-bench/scheduler-memory-bench/session-document-cache-bench/nested-tools-bench/nested-images-bench/heap-retained/codemode 四件/tool-search/tools-images/images-wasm-module。

---

## 0. 保护清单（每次合并必须保住，漏一条即回归）

1. **SQLite-only**：上游 `storage/jsonl/*` 一律不带回（房规已删，provenance 有记录）；`storage/sqlite/cloudflare.ts` 延续 1.1.0 计划的暂缓决定，不带回。
2. **project 隔离**：每行 `project_id`、每次读过滤；schema **本地 v2（隔离）+ v3（删除审计）** 与上游 `schema.ts` 拆分合并时保住，`storage.health()` 的 schemaVersion 语义不变。
3. `openDefaultSqliteStorage()`（`~/.local/share/TianGong/session.sqlite`，无路径参数）、`storage.health()`/`storage.checkpoint()`、`PRAGMA foreign_keys=ON` + 启动 `wal_checkpoint(PASSIVE)`。
4. **删除审计**（`ConversationDeletion` 类型 + `Storage.deleteConversation` 文档）与存储生命周期（delete/export/backup）、跨会话 usage 聚合。
5. `src/harness/output.ts` 的本地反压实现语义（`MIN_PROGRESS_INTERVAL_MS=100` + 字节量反压、`ToolExecutionApi.outputWindow`）——G4 收敛到 `chord/output` 时**行为必须等价**，`harness-output.test.ts`/`harness-output-skip.test.ts` 保持绿（可改 import 源，不可弱化断言）。
6. `tg.*` 持久化消息种（写入 transcript/document/SQLite 迁移的字符串）——新代码路径写消息一律 `tg.*`。
7. JSONL 无读者是声明过的后果，不得为"兼容上游"偷偷加回。

## 1A. 实施期勘误（2026-10-17，G1 落地后以实测为准）

1. **G1-1 判别联合改期到 G2**：`ToolTaskInput/ToolTaskResult` 的 `{ kind: "nested" }` 变体落地时，
   `tool.ts` 的 `readCall` 等读取函数立刻需要 nested 分支与 `NestedCallDoc` 文档族——那些是 G2-1 的
   行为面。半套联合造成 12+ 连锁错误，实测不成立。**G1 保留 model 单形态**（`tool.ts:35` 注释已标注），
   联合、`MADE_NESTED_CALLS`（房规名 `tg.tool.madeNestedCalls`）、`generation.ts` 对 `result.kind` 的
   nested 判定，**全部并入 G2-1 一起落地**。G1 提交正文已注明此归属。
2. **GuardedStorage 房规生命周期**：G1 引入上游 `GuardedStorage` 包装（SessionFailed 语义的落点）时，
   丢了本仓 `Storage` 接口独有的 `deleteConversation/exportConversation/backup` 转发（保护清单 #4），
   由复核补齐（`session.ts` scanConversations 之后三个 `#call` 转发 + `ConversationDeletion` 导入）。
   **教训：wholesale 语义改造引入上游新类时，必须按本仓扩展接口逐方法核对实现面。**
3. **通道现实**：agent-plan 全系与 opencode 默认模型周配额至 2026-10-19 重置；alibaba-cn 账号被拒；
   opencode-go 未登录。执行统一钉 `opencode/glm-5.3-flash-free`（有小时级限流窗口，撞墙后短等重试）。
4. **验证现实**：G1 终局 check 四项全绿；gibraltar 48 文件 920 passed/2 skipped、chord 517/517、
   agent 118/118 全绿（均 Node 下 vitest）。

## 1. 批次结构（唯一 cherry-pick 序）

### G1 结构基座（Breaking，先行；跨 harness/types/storage 契约）
| # | 条目（来源） | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G1-1 | `ToolTaskInput`/`ToolTaskResult` 改判别联合 `{kind:"model"|"nested",...}`；`tg.tool` v2 迁移在途 v1 任务（1.2.0） | `tasks.ts`、`harness/tool.ts`、`session/*` | 序列化兼容：读旧 kind 缺省视为 model |
| G1-2 | `ToolExecutionResult.content` → `output` + 新增 `structuredOutput`（1.2.0） | `harness/tool.ts`、`harness/types.ts` | 本仓 output.ts 消费点同步改名 |
| G1-3 | `bash`/`powershell` 非零退出返回带 `exit_code` 诊断的错误结果而非抛出（1.2.0） | `tools/bash.ts`、`tools/powershell`（本仓若无 powershell 工具则跳过并报告，1.1.0 B3-5 曾纳入 `createPowerShellTool`，实测为准） | |
| G1-4 | Storage 任意抛错（含读）→ Session 失败关闭：后续调用与 pending wait 全部以 `SessionFailed{cause}` 拒绝、不重试；删 `StorageRejected`，新增 `StorageRequestError`（无效请求只失败该调用）；调度器自身提交与 Harness 组件 commit 监听者抛错同样失败 Session（1.2.0） | `session/*`（harness/scheduler.ts、session 门面）、`errors.ts` | 测试 `harness-storage-failure.test.ts` 移植 |
| G1-5 | `subscribeCommits()`/`subscribeClose()` 监听者抛错/拒绝 → 走 `onReport` 而非失败当次操作（1.2.0） | `harness/harness.ts` | |
| G1-6 | 仅展示写提交（只有 `kind`+`data`，无 `model`/`head`/`edits`）立即追加并 settle done，busy/queued 也放行；仅排队 reset 还拦（1.2.0 #10407） | `harness/inbox.ts`、`harness/submissions.ts` | 测试 `harness-input-entries.test.ts`（与 G2-5 同文件） |
| G1-7 | `onReport` 自身抛错不再顶替被报告错误；`now()` 抛错报告一次并回落 `Date.now`；watch 监听错误报 `listener_error` 外还结束 watch（1.2.0 Fixed） | `harness/util.ts`、`session/*` | |

### G2 嵌套调用与结构化输出（**第②步子会话内核地基**）
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G2-1 | `ToolExecutionApi.executeTool(name,args,ctx,{key?,progress?})`：工具发嵌套调用，独立 `tg.tool` 任务归调用方，走校验/`ToolHookCall.parent` 钩子/输出上限/replay policy，返回 `NestedToolExecutionResult`（taskId/structuredOutput/details/diagnostics/usage/isError/durationMs，无模型 output）；每次嵌套调用是 `NestedCallDoc` 任务级文档族成员（key 默认调用位次，可重放重连；非 replay-safe 调用者重启后未完成嵌套调用弃置）；`tg.live.nestedTools` 展示参数与完成 summary；工具事件带 `parentToolCallId`/`parentTaskId`，所有事件带 `taskId`；调用方 settle 前弃置在跑的嵌套调用（1.2.0） | `harness/tool.ts`、`documents.ts`、`harness/live.ts`、`harness/events.ts`、`harness/task-graph.ts` | 测试 harness-nested-tools(-restart)、nested-tools-bench |
| G2-2 | 结构化工具输出：`structuredOutputSchema` 声明 + `structuredOutput` 返回，Harness 校验后给程序；无 schema 时受限输出（一文本→string、一图像→本体、否则列表，错误同）；错误结果保留 schema 工具自身值；嵌套调用非法 structuredOutput→错误，模型调用→仅丢并 report；`api.retainedOutput()`；bash/powershell 返回 `{output,truncated,fullOutputPath?,exitCode}`（1.2.0） | `harness/tool.ts`、`tools/bash.ts` | 测试 harness-structured-output |
| G2-3 | `ToolRegistration.callers`（model/tools/both 默认）与 `tg.agent` `modelTools`；`Agent.callable`；`addTools` 扩展 modelTools（1.2.0） | `harness/agent.ts`、`harness/types.ts` | 测试 harness-callers |
| G2-4 | 延迟工具：`ToolRegistration.deferred`、`modelTools.add({remove?,add?})`、`control.addTools` 写 add、加载顺序追加声明、`Agent.deferred`；`/tool-search`（`search.ts` BM25）提供 `tool_search`；codemode 段不含延迟工具（1.2.0） | `harness/agent.ts`、`search.ts`(新)、`tool-search/`(新) | 测试 tool-search |
| G2-5 | 输入提交 `entry:{kind,data}`（`InputEntry`，kind 不得 `pi.`/本仓 `tg.` 前缀开头），入队项在 `tg.inbox` 带 entry（1.2.0 #10407） | `harness/inbox.ts`、`entries.ts` | 与 G1-6 同测试文件 |
| G2-6 | `TaskOptions.abandonOnRestart`（标记 `abortReason:"restart"` 级联；嵌套调用与非 replay-safe 调用者的 `api.createTask()` 子任务默认；带弃置意图的任务之下不再起 run 阶段）；`TaskRuntime.abortOwned(id,context)`；`ownedTasks(context)`（1.2.0） | `harness/scheduler.ts`、`task-graph.ts` | 测试 scheduler-indexes 部分 |
| G2-7 | `pi.live.compactionFailure`→`tg.live.compactionFailure` 保留最近压缩失败直到出摘要；agent 事件快照带 `compactionFailure`；`compaction_end` 带 `error`（1.2.0） | `harness/compaction.ts`、`live.ts` | |

### G3 调度与文档缓存性能
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G3-1 | 调度器不再每遍访问全部在跑任务：弃置级联只从有取消意图任务起；owned live work/idle scope 走内存所有权索引；reservation/finalization/failFast 各自候选集（1.2.0 Fixed） | `harness/scheduler.ts`、`task-graph.ts` | 测试 scheduler-fanout-bench/scheduler-memory-bench、harness-cancellation-barrier |
| G3-2 | 所有权索引受 live work 约束：会话所有权与已结束任务仅在下方仍有 live 工作时保留，否则从存储重链；排队输入不再全扫排队提交（1.2.0） | `harness/scheduler.ts` | |
| G3-3 | 文档缓存受使用约束：`documentRetentionMs`（`HarnessSettings`/`createSession()`，默认 600000，0=用后即弃），无 watch/document state 观察且超时未读写即离开内存、下次重装载（1.2.0） | `harness/harness.ts`、`session/*` | 测试 session-document-retention(+setup-document-retention)、session-document-cache-bench |
| G3-4 | 文档数组追加不再每次全数组行走（chord delta tracker 已在 G… chord wholesale 里到位）+ `storage/sqlite/schema.ts` 拆分合并（保住本地 v2/v3 迁移） | `storage/sqlite/schema.ts`(新)、`migrations.ts` | 保护清单 #2 |
| G3-5 | wait 闭环（经 waits+held owners）被 `runtime.commit()` 拒绝并指名环，不再永挂；后台任务可等自己会话的 owner（1.2.0 #10411/#10533） | `harness/scheduler.ts` | |

### G4 output 收敛（chord/output）
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G4-1 | `OutputBuffer`/`Progress`/`boundOutput`/`sanitizeOutput`/`characterEnd`/`utf8ByteLength`/`OutputLimits` 等从 durable 移入 `@OnePanda-TgSec/chord/output`（1.3.0 已在本仓）——删 `src/harness/output.ts`，改 import；`settings.progress` 参数化（`partialIntervalMs`/`outputIntervalMs`）、`Progress` 收 `minIntervalMs`、`OutputBuffer.push(chunk,skipped?)`+`#skip()`、`ToolExecutionApi.outputWindow` 语义与本地反压**等价合并**（保护清单 #5） | chord/output 导入点：`harness/generation.ts`、`tool.ts`、`live.ts`、`output 相关` | 测试 harness-output(-skip) 保绿、可改 import 源 |

### G5 二进制感知（图片）
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G5-1 | `read` 图片返回单个 image 块（PNG/JPEG/GIF/WebP 在模型图像限制内原样，默认 2000x2000/4.5MB base64；`createCodingTools({images})` 下方向修正/转换/缩放）；无图像输入的模型得到诊断说明（1.2.0） | `tools/read.ts`、`tools/image-processor.ts`(新)、`tools/index.ts` | 测试 tools-images |
| G5-2 | `@OnePanda-TgSec/tg-gibraltar/images`：Photon(WASM) 图像处理 + `/images/node`（worker 线程预处理、30s 空闲退出、不导入不加载）与 `/images/cloudflare`（**cloudflare 端与 CF 暂缓一致：不带回，报告里注明**）（1.2.0） | `images/*`(新) | 依赖 `@silvia-odwyer/photon`；测试 images-wasm-module |
| G5-3 | `toBase64` 改 8KiB 分段+`btoa`，3MiB 图不再吃 140MB 堆（1.3.0 #10923） | `images/` 与 `tools/` 相关 | |
| G5-4 | `ExecutionEnv.listFiles(path,options,context)` 有界、gitignore 感知树列举（`ListFilesOptions`/`FileListing`/`FileListEntry`），`registerEnvConformance` 加 `listFiles` 覆盖（1.2.0） | `env/*`、`testing/*` | |

### G6 codemode 扩展（依赖 vendored codemode 1.3.0 `sandbox.start()`）
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G6-1 | `/codemode` 入口：`createCodemodeExtension({sandbox})` 的 `codemode` 工具——脚本把会话工具当嵌套调用调、重启后从 journal 确定性重放并 reconnect 嵌套调用；分歧/沙箱指纹/模块版本变化/超时终止；prompt 段列可调用工具（namespaces、内联 token 预算）、`searchTools()/describeTool()/describeNamespace()`；结果布局（header/文本项标记/console 块/`max_output_tokens` 截断+spill 文件/保存图像）；脚本得 `models.*`（目录 + `classify()`/`generateImages()` 走内部工具嵌套调用，至多 4 并发）；声明 Lark grammar；失败调用 reject（schema 工具错误值 resolve）；`store()/load()` 会话级、fork 分叉；结果 `details.calls`；live progress 在 `tg.live.nestedTools`（1.2.0，`npm run bench:codemode`） | `codemode/*`(新) | 测试 codemode(.describe/.models)+codemode-bench |

### G7 小修与收尾（1.3.0）
| # | 条目 | 上游落点 | 说明 |
| --- | --- | --- | --- |
| G7-1 | `SqliteStorage.open(database,{prefix})` 命名空间化全部表/索引；`openNodeSqliteStorage()` 转发（`openDurableObjectSqliteStorage` 属 CF，不带回）（1.3.0） | `storage/sqlite/*` | |
| G7-2 | 压缩后系统基线在保留历史含 assistant 消息时**领头**上下文（首条基线同样），不再夹在中间导致 Anthropic/Codex 把系统消息发成无初始 prompt 的中途消息（1.3.0 #10904） | `harness/compaction.ts`、`context.ts` | |
| G7-3 | 压缩摘要请求不再包含 thinking（重放 thinking 常不在 live 上下文，可能比被摘要上下文更大而"prompt too long"反复失败）（1.2.0 Fixed） | `harness/compaction.ts` | |
| G7-4 | blocking threshold 压缩失败/fault/orphan/abort 时该生成以 `model_error` 失败而非继续发请求（1.2.0 Fixed） | `harness/generation.ts`、`compaction.ts` | |
| G7-5 | fault 写失败的任务不再同进程重跑（1.2.0 Fixed） | `harness/scheduler.ts` | |
| G7-6 | `Session.closed`（close() 后 `{reason:"closed"}`、存储错误后 `{reason:"failed",error}`）；`WatchEnd` 增 `{reason:"session_failed",error}`；README 增 Errors 节（1.2.0） | `session/*`、README.md | |

## 2. 暂缓/不带回
- `storage/jsonl/*`（房规删除，永久）；`storage/sqlite/cloudflare.ts` 与 `/images/cloudflare`、DO 协同（无 CF DO 部署，延续 1.1.0 暂缓；若将来移植必须带本地 v2/v3 迁移）。
- 上游 package.json 的 `@silvia-odwyer/photon`、`diff`、`typebox` 依赖随 G5/G6 引入；exports 增 `./codemode` `./tool-search` `./images` `./images/node`（`./images/cloudflare` 不加）。

## 3. 验证协议（每批次 commit 前强制）
1. `bun run check` 全绿（house-standard 会盯 `tg.*` 消息种与 specifier 房规）。
2. `packages/gibraltar` 下 Node 跑 vitest：`PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$HOME/.bun/bin:$PATH" bun run test`；chord 与 ai 的既有套件回归顺带跑（chord 消费面在 G1/G2 会被触碰）。
3. 保护清单逐条自查（尤其 #1/#2/#5/#6）。
4. 每批次一个 commit：`feat(gibraltar)!:/fix(gibraltar): port upstream 1.3.0 batch Gn ...`，正文列条目与 issue 号。

## 4. 回滚矩阵
G1→G7 按序提交；G2 依赖 G1（判别联合与 output 改名先行）；G3-4 依赖 chord wholesale（已完成）；G6 依赖 G2-1（嵌套调用）+ vendored codemode 1.3.0（已完成）；G4 独立，可与 G2/G3 并行；G5/G7 独立。跨批文件冲突点集中在 `harness/tool.ts`/`scheduler.ts`——严格串行，不并行。
