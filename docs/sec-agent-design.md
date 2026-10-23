# sec-agent 工程文档（gibraltar 原生路线）

状态：设计定稿，待实施。实施侧 Fedora/qoderclicn。文档与代码不一致时代码是错的；实施前先读
真实签名核对本文档引用的 gibraltar API，出入以代码为准并回本文档勘误。

配套文档：`docs/sec-guard-design.md`（权限模块，本包的守卫来自该包）。

## 批3 落地勘误（2026-10-23，全部对照真实签名核实）

本文档定稿时若干 API 名称与行号是推断，落地时以代码为准。以下条目取代正文对应表述：

1. **入口是 `Harness.open`，不是 `openHarness`。** gibraltar 从未导出 `openHarness`；生产入口是
   `Harness.open(storage, options, context)`（`packages/gibraltar/src/harness/harness.ts:446`）。正文
   与批3表格中的 "openHarness" 均指此。
2. **fork 的真实位置。** 子会话分裂是 `Tx.forkConversation(parentId, at, { ownership })`
   （`packages/gibraltar/src/session/transaction.ts:291`，harness 内部在 harness.ts:351 调用）；正文
   "harness.ts:379 附近" 指的是 `conversationCreated` 创建钩子，不是 fork API。批3 Task 工具在
   `api.commit((tx) => tx.forkConversation(...))` 内落子会话并写 `tg.sec.action-tree` 种子文档。
3. **doc-kind 前缀不是硬校验。** documents 层只禁 input entry kind（`submissions.ts:152-159`），不强
   制 `tg.` 前缀。`tg.sec.mode`（sec-guard 已持久化）与 `tg.sec.action-tree` 文档族沿用 `tg.` 命名是
   house 规则，而非运行时校验；`defineDocFamily` 在 `packages/gibraltar/src/documents.ts:60`。
4. **attestation 落在首个真实 `beforeTool`，不在 bootstrap。** probe 7 需要一个真 `HookApi`
   （`taskId`/`memo`/`snapshotAsOf` 无诚实的启动期取值），所以 `guard.attest(...)` 由 core extension
   的首个 `beforeTool` 调用触发（gibraltar 在该处交出真 `HookApi`），失败即 block 该帧工具调用，标志位
   仅在成功后翻转。`openSecAgent` 本身不 attest——这是对原 bootstrap 设计的最小修正。
5. **一项目一库文件。** 同一 SQLite 文件内二次 `Harness.open` 会重建 reserved root 会话（ID 1），全局
   record-ID 认领使第二个 project 抛 `already belongs to conversation`（bootstrap.test.ts 钉死）。故默认
   必须一项目一文件。
6. **faux 工具回合必须显式 `stopReason: "toolUse"`。** 否则 faux 不会把 toolCall 交给执行面；测试里的
   工具回合都按 `fauxAssistantMessage([...], { stopReason: "toolUse" })` 构造。
7. **sec-agent 不依赖 `tg-env`。** env 解析器由 gibraltar 定型（`env/node` 的 `NodeExecutionEnv`、
   `EnvTarget`），接受宿主注入的远程 env 不给 sec-agent 增加对 env 包的边。批3 的真实依赖边集 =
   {chord, tg-ai, tg-gibraltar, tg-sec-guard, tg-telemetry}，见 `packages/sec-agent/test/boundary.test.ts`。

## 批4 落地勘误/决策（2026-10-24，全部对照真实签名与实跑核实）

正文「证据与审计」节定稿时以 ARTEX（Go + PostgreSQL）为行为参照；落地为 TS + gibraltar SQLite 时
以下条目取代或补齐该节表述：

1. **串行写：PG 咨询锁 + `SELECT FOR UPDATE` → SQLite 等价，零新依赖。** ARTEX 用
   `pg_advisory_xact_lock` + `FOR UPDATE`（finding_traffic.go:27-40,175）串行化同一主体的证据写。
   本轮改用 gibraltar 原生 `NodeSqliteDatabase.transaction()`（`BEGIN IMMEDIATE` 提前取写锁 +
   `openNodeSqliteDatabase` 的 `busy_timeout`（默认 5000ms）处理 `SQLITE_BUSY` + 进程内
   `SerialOperationQueue.runAsync` 天然串行），不引 proper-lockfile 等新依赖。乐观锁
   `evidence_version` 逐主体存于 `tg_sec_evidence_versions` 表；`bind` 的 `expectedVersion` 为
   `null` 时不校验（无条件追加），否则不符即抛 `TgSecEvidenceConflictError`。
2. **`ON CONFLICT DO NOTHING` + RowsAffected → SELECT-存在性-再-INSERT。** `run()` 在 gibraltar 侧不
   回传 RowsAffected，故 "changed"（是否真的新增了一条 binding）由「先 `SELECT 1` 探在否、不在才
   `INSERT`」判定；既有 binding 的 role/note 一律不被覆盖（与 ARTEX 一致）。反标记
   `unreferenced_at = NULL` 无条件发生。
3. **存储布局：证据与会话彻底分库。** 每项目一个独立证据索引 SQLite 文件
   `projects/<safe>/evidence/evidence.sqlite`，内容寻址 blob 落 `blobs/<hash[0:2]>/<hash>.bin`、
   写入暂存在 `.staging/`——三者在 `evidence/` 子树内、**均在 `session.sqlite` 之外**（config.ts:9-31）。
   会话 transcript 与取证证据因此有各自的生命周期、备份与 GC。目录 `0700`、blob `0600`。
4. **主体键泛化为 `subjectId: string`。** ARTEX 的 findings 主体、report 版本（`report_evidence_version`）
   属批5/6；本轮 store 自管版本表，调用方各自传字符串 id，不预置 findings 语义。
5. **证据层零 JSON（用户硬指令，限批4 证据子系统）。** ARTEX 用 canonical JSON 只为拿确定性字节做
   snapshot-ID preimage（finding_traffic.go:130-137）。本轮**不用 `JSON.stringify`**，改用**定序 + 长度
   前缀字节编码**（hashing.ts `encodeEvidenceSnapshotPreimage`）：域分隔 tag `tg.sec.evidence/v1\0` +
   固定字段序 + 每个变长字符串带 `uint32be` 字节长前缀 + 定宽大端数值（status `u32be`、req_len/resp_len
   `u64be`、captured_at `i64be`）+ 两个 32 原始 hash 字节；`ID`/`createdAt` 由构造排除。长度前缀使拼接
   无歧义（字段内容无法伪造字段边界），字段序入 ID（重排即变）。元数据在 SQLite 是列存、raw body 落
   文件 blob——皆非 JSON。回归见 evidence-hashing.test.ts（含「边界伪造 → ID 不同」用例）。
6. **两个哈希域不混。** blob key = `sha256(body 原始字节)`（header 从不计入）；snapshot id =
   `sha256(定序长度前缀 preimage)`。请求体/响应体是两个独立 blob。ID 在插入时校验、读回时再校验；
   hash 必须 64 位**合法小写 hex**（大写拒绝、不折叠）。
7. **fsync 为房内新增能力。** writeBody 序列（staging→边算 SHA-256→长度门→可选哈希门→fsync→close→按
   **算得的** hash 定位→存在则先 verify 再 `chtimes` 刷宽限；否则 mkdirAll+rename+父目录 fsync）有意
   超出房规既有模式（src 此前无 fsync 先例，仅 temp+rename / `wx` 认领）。不可变 blob 唯一被允许的原地
   改动就是那次 `chtimes` 宽限刷新。CHANGELOG 记录。
8. **GC 三段 + 宽限读文件 mtime。** `collect(now)`：先 `UPDATE ... SET unreferenced_at` 标记无 binding
   的快照，再删 `unreferenced_at < now - 24h` 者，最后遍历 `blobs/` 与 `.staging/`，凡不在存活 hash 并集
   （req∪resp）且 `now - mtime >= 24h` 者删除（EVIDENCE_GRACE_MS = 24h）。宽限计时以文件 mtime 为准。
9. **审计 span 全覆盖的本轮边界。** `TG_SPAN_SCHEMA`（telemetry/spans.ts）本轮新增两个 span：
   `tg.span.sec.evidence`（每 op 一条，属性只放 `op`/`subjectDigest`（截断单向摘要，绝不放原始
   subject/hash）/`outcome`/`changed`/`count`）与 `tg.span.sec.fork`（委派一条，`lane`/`outcome`/`depth`，
   **不带 intent 文本**）。fork span 经 `TelemetryContext` 从宿主穿到 Task 工具（task-tool.ts）；`depth`
   本轮恒为 1（批3 前台单跳，`ToolExecutionApi` 不暴露会话深度，不编造）。guard 判定/模式切换 span 批3
   已在。**scope 注册变更 span 延后批5**：当前 `createTgSecScopeRegistry` 是 build-once 只读、树上无注册
   变更调用点，本轮不为无消费者的场景造接缝。**redis 本轮不预置**（「必要的时候再选」）——SQLite +
   文件系统 blob 足够当下消费者。**span 覆盖 = 发射点存在且被 `InMemoryTelemetryContext` 观测**；生产
   exporter 属未来批次（tg-telemetry 目前只有 NOOP + InMemory）。

## 批5-A 落地勘误/决策（2026-10-24，全部对照真实签名与实跑核实）

批5 拆成可独立验证的切片，本切片（5-A）落纯 sec 工具面，不动房规治理文件。以下取代正文相关表述：

1. **本轮 = 纯 sec 工具面，MCP 桥推迟。** 落 `src/tools/` 三工具（`http_request` /
   `evidence_capture` / `traffic_query`），打包为一个宿主可安装的 `sec-tools` 扩展
   （`createSecToolsExtension`），与 `sec-core` 并列 install。MCP 桥需新增
   `sec-agent → @earendil-works/pi-mcp` 依赖边，直接违反 `test/boundary.test.ts` 禁列与
   AGENTS「mcp 是无人依赖的 vendored 叶子」；桥 + 其边界/AGENTS 修订单列下一轮，本轮不造无消费者的边。
2. **三工具恒 `deferred`。** `deferred:true` 使其不进 modelTools、须经 `tool_search` 点名才 offered；
   但 nested `executeTool` 恒可达（`callers:["model","tools"]`）。**`sec-core` 的 `beforeTool` 在
   `ToolTask` 层对每个注册工具都跑**，故新工具入册即被 guard 覆盖，零额外接线。
3. **`http_request` 的 scope 判定白送。** guard 的 `extractConnectionTargets` 遍历整个 `arguments` 树，
   `url` 属 declared-target → strong → host → `registry.outcome(host)`；scope 层在 mode dispatch 之前、
   **不 gate toolName**。故 `{url:"https://host/x"}` 的 host 被 scope 拦，**sec-guard 无需改**；
   `test/sec-http-scope.test.ts` 端到端证明（in-scope 放行、out forced ask、`tg.span.sec.guard` layer=scope）。
   传 `{"target":...}` 才需扩表，本轮就用 `url`。
4. **网络经注入的 `RequestExecutor` 接缝。** `src` 属 `node` 型程序，注入接口避开 Bun/Node 全局 `fetch`
   类型冲突（AGENTS「Type programs」）且保证测试零 egress。生产 `nodeRequestExecutor` 用
   `node:http`/`node:https`，**故意不跟随 redirect**：越界 3xx 必须留在调用方判断，不能成静默 hops。
5. **findings 主体 = evidence `subjectId`（字符串 findingId）。** 这是批4「泛化 subjectId」的第一个真实消费者。
   findings/report 表与版本属批6；本轮只确立「subject = findingId」契约。证据体只回 snapshotId + 字节数进
   transcript，body 原文不进（取证导向）。
6. **赛道 sections + 工具过滤。** `sections.ts` 加 per-lane `tools` 段（工具面 + 取证纪律，三赛道变体），
   `secLaneSections` 现返回 `{preamble, lane, tools, rubric}`；`secLaneToolFilter(lane)` 是 lane→surface
   契约。本轮三赛道都 surface 全三工具——门是 `deferred` 标志而非清单——宿主按 `configure` 的
   `modelTools.remove`/`tools` 收窄（设计文档「赛道条件化① 走 resolveAgent 的 tools 过滤」）。
   `test/sec-lane-filter.test.ts` 证：默认 deferred 不入 offered、nested callable 含之；`configure` add 后
   移入 offered 并退出 deferred。
7. **`secDeclaredTools` 扩列 → probe 4 同步。** attestation probe 4 是 registered==declared 的严格集合相等
   （缺名或多名都 fail-closed），故三工具入册即入 declared；`guard-wiring.test.ts` 与 `tg-sec` 冒烟 CLI 均
   install `sec-tools` 保持两集对齐。
8. **telemetry 本轮零改动、无新 span。** 工具经批4 store 自动发 `tg.span.sec.evidence`（`getSnapshot` 走
   既有 `read` op）；guard/mode/fork/evidence span 已在。**scope 注册变更 span 继续推迟**（注册表只读、
   树上无注册写调用点，与批4 同一「不造无消费者接缝」原则）；真有注册面批次时按 `tg.span.sec.mode`
   先例（非决策型审计 span）在 `TG_SPAN_SCHEMA` 加 `tg.span.sec.scope`。

## 背景与目标

sec-agent = 面向政务红蓝/公安对抗赛的安全攻防 agent，**彻底落在 gibraltar 上**：循环、持久化、
子会话、事件流全部是 gibraltar 原生件。

**2026-10-22 工作区现状（Fedora 实测，删除已落地未提交）**：`packages/agent`（tg-agent-core）与旧
`packages/sec-agent` 均已从工作区删除，快照留存于 `scripts/legacy/agent-core/`（src+test+
examples/mcp-codemode，含 permission.ts）与 `scripts/legacy/sec-agent/`（src 261 文件、examples
15 文件），出处快照说明见 `scripts/legacy/README.md`。旧桥接层 `packages/sec-agent/src/core/harness/`
（5 文件 2112 行）**从未进 git**，已随删除消失——本设计不重建桥，sec-agent 按 gibraltar 原生
API 全新构建。旧 `docs/`（47 文件）未留存，需要时从 `7dcf8a8` 取回。`scripts/legacy/` 不参与编译、
不被任何包导入、不受房规与格式检查管辖（tsconfig.scripts.json / biome.json /
check-relative-imports.ts 三处显式排除），**只能读、不能 import**。

权威复盘：`docs/sec-agent-harness-wiring-review.md`（durable 缺口 S0、桥接缺陷 P0-P3、与旧
loop 已核实一致的回归基线 §4）。本文档的"durable 正确构造"与"实现注意事项"两节直接引用它。

关键前提（2026-10-22 实测复核，取代早期"gibraltar 无循环"的旧判断）：

- gibraltar harness **自带持久化 agentic loop**：`GenerationTask`（harness/generation.ts:118）
  prepare→request→classify→tool round→handOver，配合 `ToolTask` 完成多轮工具循环，每步
  持久化、可崩溃恢复；`BUILTIN_TASKS` 见 harness/registry.ts:10。
- retry 在 tg-ai（utils/retry.ts），compaction 是内置 `CompactionTask`——无需从 agent-core
  收编任何循环件。
- 生产持久化只有 SQLite：`openNodeSqliteStorage(path, { project })`，每行 `project_id` 隔离，
  一战役一 project。

参照来源（**只借鉴思路与契约，禁止复制源码**：ARTEX/StrikeAgent 均 AGPL；kimi-code 是 MIT 可
自由搬）：ARTEX（证据存储/拦截规则/llmpool 熔断）、StrikeAgent（guard.py 算法/赛道预设/前后端
契约）、pi-1.3.0/packages/evals（边界隔离与探测验证）。

移植底稿 = `scripts/legacy/sec-agent/src/`（上游 coding-agent 的本地化成果：会话管理、compaction、
扩展、系统提示分段、工具实现、`extensions/mcp/`）。它是**可读行为参照**，不是改写起点：绑旧
ExtensionAPI/旧 loop 契约的部分全部按 gibraltar 原生 API 重写，命名翻译进房规。

## 已定案决策（实施中不得翻案）

1. 循环/持久化/子会话/事件流的唯一权威 = gibraltar harness；**不出现第二个循环，不重建桥接层**。
2. 权限 = 独立包 tg-sec-guard，四级模式 + 危险集强制人工（详见配套文档）。
3. WebUI = **自写 UI + StrikeAgent 同构契约投影**（契约字段/枚举作为协议字面量照搬，实现与
   样式代码自写）；API 层 = 独立 sec-server sidecar 包，内核只暴露事件流。
4. 子代理 = 会话级委派（Conversation.fork），非类型化角色；主 agent 持计划。
5. TLD 黑名单机制保留、seed 清空；赛道预设（redteam/CTF/SRC）条件化安全策略。
6. 授权放行走模式/规则预设（操作者侧 `.tiangong/` 配置），不做工具白名单、不做仓库可控文件。
7. 证据 = 内容寻址不可变 blob + 版本乐观锁（ARTEX 模式），实测留存与还原报文分离。

## 总体分层

```text
产品壳    tg-sec-agent（CLI, tg-tui）        sec-server（sidecar, WebUI 契约）
            │ watchEvents 直投                  │ watchEvents → WS 投影
扩展层    sec extension（defineExtension：tools/sections/hooks/tasks）
            └ tg-sec-guard（beforeTool 策略链 + attestation + 模式机）
运行时    tg-gibraltar（GenerationTask/ToolTask 循环、fork、watchEvents、
            defineTool/registry、tool_search、codemode、coding-tools）
持久化    SQLite（project_id 隔离）+ 证据 blob 存储（内容寻址，独立于会话库）
横切      tg-ai（模型/retry/auth） tg-env（SSH 远程执行） tg-telemetry（审计）
            pi-mcp（vendored client，自写适配层桥接）
```

## 子代理与行动树

- 子代理 = `Conversation.fork(at, options)` + owned conversation（harness.ts:379 附近）；每次
  委派 fork 一条子会话，天然是行动树节点。主 agent 持计划，子会话只回传摘要。
- **子会话索引文档族 `tg.sec.action-tree`**（`defineDocFamily`，documents.ts:60）：记录每个
  fork 子会话的 id/父会话/任务意图/状态/摘要指针。这是 WebUI 行动树投影的硬前置——
  `ConversationRecord.owner` 单值链接不足以支撑枚举（既定结论）。
- 子会话创建时是父 agent 拷贝；`taskId` 续跑必须校验所有权（模型不得寻址任意 conversation
  id）。
- Task 工具做成内核内置（ToolExecutionApi 对内置与扩展等价，这是产品姿态）；能力面收窄只能靠
  子会话携带的 extensions，Task 工具须屏蔽 `AgentChange.extensions.add` / `modelTools.add`
  （`control.addTools` 会抹掉 remove 项——**工具过滤器不是边界**，授权权威层是 guard 的
  beforeTool）。
- v1 纯前台阻塞委派；后台变体列 v2。v1 禁用子会话的 deferred/`tool_search` 面，guard 就位后
  再放开。
- 子会话原始大输出的 spill 是临时文件不入库：需要留证的输出必须在子会话里显式入账
  （submit write 路径/摘要）。

## 工具面

- **保留** gibraltar `coding-tools`（read/write/edit/bash + 图片）作基础盘；bash 是 scope
  解析主战场（tg-sec-guard）。
- **sec 工具集**：一个 `defineExtension` 打包，全部 `defineTool` 注册（harness/define.ts:13）；
  数量大，常态 deferred，靠 `tool_search`（BM25）动态加载。首发工具面：http 请求、端口/目录
  扫描（经 tg-env 远程通道调外部二进制）、流量查询、图写入、证据入账、报告生成。
- **MCP 桥自写**：pi-mcp 是 vendored 纯 client，写适配层把 MCP Tool 包成 gibraltar AgentTool
  注册——注册后自动进 beforeTool/afterTool（gibraltar 语义：MCP 工具与内置工具同遇
  hooks）。移植底稿 = `scripts/legacy/sec-agent/src/extensions/mcp/`（实测 10 文件 4268 行，绑旧
  ExtensionAPI，**翻译不复用**）。
- **生成脚本执行**走 codemode QuickJS 沙箱（journal 确定性重放），攻击 PoC 这类不可信代码不
  直接进 bash。
- **远程执行**走 tg-env（`RemoteExecutionEnv`/SSH daemon），目标侧命令与编排机物理分离。
- 系统提示：分段装配参照 `scripts/legacy/sec-agent/src/core/system-prompt.ts`，按赛道切换
  sections；溢出处理参照同目录 `core/tools/truncate.ts` 与 gibraltar 的 `truncate.ts`（默认
  2000 行/50KB）。

## 赛道预设

- 三赛道终局：redteam=getshell、CTF=getflag、SRC=high_critical_finding。
- 赛道条件化：① 工具集（走 `resolveAgent` 的 tools 过滤，agent.ts:186）；② 系统提示
  sections；③ 业务变更护栏（CTF 豁免"只证明不落地"类护栏；目标破坏类**全赛道不豁免**）；
  ④ CTF 额外禁 hashcat/john 大词表；三赛道全拦超大词表。
- 预设是操作者侧 `.tiangong/` 配置，DB 行式可编辑，不随仓库分发。

## 证据与审计

- **证据 blob 存储**（独立目录，不在会话库）：内容寻址 `blobs/<hash[:2]>/<sha256>.bin`；
  写入 = `.staging` 临时文件 → 边写边算 SHA-256 → 校验 → fsync → rename 原子落位 → 父目录
  fsync；已存在则校验后刷新宽限。`evidence_version` 乐观锁 + 咨询锁串行写；GC 先标记
  `unreferenced_at` 再 24h 宽限后删除。行为规格参照 ARTEX evidence/store.go，**TS 重写**。
- **留痕**：每次 guard 判定、模式切换、scope 注册变更、fork/委派、证据入账均落
  `tg.span.sec.*`；durable 会话完整模式（取证导向）。
- **评级**：固定四级 rubric（严重/高/中/低，取已证明影响的最高符合项，禁止跳级）注入系统
  提示；实测留存与还原报文分离，不夸大 RCE/凭证 claims。

## WebUI 与 sec-server（批6，最后做）

- 自写 UI（栈自定，参考 StrikeAgent 前端布局风格），后端 = 独立 `tg-sec-server` sidecar 包：
  订阅 harness `watchEvents`（harness/events.ts:61），投影为契约流。
- 契约字面量照搬（协议对齐，不翻译）：节点 9 类（target/info/service/danger/vuln/credential/
  foothold/honeypot/goal）、边 5 种（LEADS_TO/EXPLOITS/ESCALATES_TO/PIVOTS_TO/CONTAINS +
  weight + on_rce_path）、intents/findings/steering/memory/events WS 流。
- 投影来源：fork 行动树 → nodes/edges；证据入账 → findings；submissions → steer。
- 登录入口（随机路径 + 一次性 ticket）按自有实现，安全强度不低于参照。

## durable 正确构造（day-one 验收，取代旧"批5 全接"）

接线复盘（`docs/sec-agent-harness-wiring-review.md` S0-1…S0-5）证明"先跑内存版再接 durable"会
留下结构性空转：崩溃恢复静默失效、project 隔离形同不存在。全新构建没有过渡态，**批3 起 harness
open 必须同时满足**：

1. 传真实 `openNodeSqliteStorage(path, { project })`，禁止 `MemoryStorage` 出现在生产路径；
   `backup()`/`health()`/`checkpoint()` 可用并接入运维。
2. `harness.root(context, { agent, init })` 带会话定位键；启动路径调用 `resume()`，否则
   scheduler 的 running→pending 复位与 `abandonOnRestart` 只是空转。
3. `HarnessOptions.env` 传入（工具不在编排进程内裸跑）、`onReport` 传入（禁止空 sink 吞掉
   submit 拒绝）。
4. documents（LiveDoc/InboxDoc）、`tool_search`、`codemode`、`usage()` 有真实调用点，不允许
   包内自制备实现与 gibraltar 件并存。
5. 单一真相源一次定死：Harness entries 是 transcript，JSONL 至多是导出格式；compaction/branch
   后 durable 侧不得残留压缩前条目（复盘 P2-1）。
6. 会话目录读写一致：机器生成态属 XDG data 目录（`~/.local/share/TianGong`）；复盘 P3-7 记录
   的写侧 `getAgentDir()`（config）/读侧 `getSessionsDir()`（data）不一致，新实现不得复刻。

## 实现注意事项（接线复盘的可移植教训）

这些是桥接层逐条复刻旧 loop 时踩出来的坑；原生构建不该重演，列为回归用例：

- **监听器隔离**（P0-2）：`watchEvents` 回调内逐个 try/catch，单个消费者抛错绝不能终止
  observation（`listener_error` 会使 `waitForIdle()` 永久挂起）。
- **溢出快照分支**（P0-1）：观察帧积压超 `MAX_PENDING_WATCH_FRAMES` 时 gibraltar 折叠为单个
  `snapshot` 事件；任何投影（TUI/WebUI）必须处理 snapshot 并补齐未闭合回合。
- **工具结果数据面**（P1-1/P1-2）：`tool_execution_end` 的真实 `details/usage/durationMs` 在
  entry 的 `model[0]`，`data` 只装诊断壳；流式 partial 用增量语义而非全量快照重喂。
- **abort 队列语义**（P1-4）：gibraltar 的 `conversation.abort()` 会撤回排队输入；若产品要
  保留跨 abort 的队列，须显式实现而非默认继承。
- **length 截断的重发反馈**（P2-8）：gibraltar 对截断的 tool call **不执行**（比旧 loop 安全），
  但也不回喂 tool result——模型会看到"调了工具却什么都没发生"。sec-agent 应在 turn 收尾补一条
  显式反馈。
- **beforeTool 必问**（P1-5 教训，guard 侧硬约束）：每个 tool call 都必须进 guard 的
  beforeTool；恢复态/无 placement 的调用不得绕过（细则见 sec-guard-design.md）。
- 与旧 loop 已核实一致的成员（复盘 §4 整表）无需重证，作为回归基线引用即可。

## 批次分解与验收

| 批 | 内容 | 验收 |
| --- | --- | --- |
| 批0 | 提交删除 baseline：`packages/agent` + 旧 `packages/sec-agent` 移除、`scripts/legacy/` 留存、AGENTS.md 边界图与 provenance/工具链排除收尾 | 工作树干净；`check:types`/`check:house-standard`/`bun run test` 绿；legacy 目录确认不参与编译 |
| 批0.5 | tg-sec-guard 骨架 + 模式机 + attestation 框架 | 见 sec-guard-design.md |
| 批1 | scope 命令解析器 + scope 注册判定 | 解析器对照用例全绿 |
| 批2 | 拦截规则表 + 危险集 + judge（仅 L2） | 16 格模式矩阵全绿 |
| 批3 | 新建 `packages/sec-agent`（gibraltar 原生 openHarness + 真实 SqliteStorage + init/resume + env/onReport）、fork 行动树 + `tg.sec.action-tree` 文档族、Task 工具内核化 | durable day-one 六条全过；子会话可枚举可归因；所有权校验测试 |
| 批4 | 证据 blob 存储 + 审计 span 全覆盖 | 写入/校验/GC/乐观锁回归 |
| 批5 | sec 工具面 + MCP 桥 + 赛道 sections | MCP 工具注册后自动过 beforeTool/afterTool；deferred/tool_search 面按赛道放开 |
| 批6 | tg-sec-server + 自写 WebUI | 契约投影端到端（snapshot/WS/steer） |

依赖序：批0 是所有批次的前置（现网工作树未提交，任何实码批次之前必须先落批0）；批0.5 是
批1/2 的前置；批3 是批6 的硬前置；批4 与批3 可并行。

**批次语义变更记录**：原"批5 durable 全接 + 桥退役"取消——桥接层从未进 git 且已随包删除消失，
durable 改为批3 的 day-one 构造要求（上节六条）；原批0 的"接线 baseline 提交 + docs/examples
去留"改为"删除 baseline 提交"（docs/examples 去留问题随旧包删除自然消解，复盘 P3-3 的 12 个
连带失败文件不复存在）。

## 房规遵从清单

- 命名：`@OnePanda-TgSec/tg-sec-agent`（旧包已删，本包在 `packages/sec-agent` **全新构建**）、
  `tg-sec-server` 新建；持久 kind `tg.sec.*`；span `tg.span.sec.*`；环境变量 `TG_SEC_*`。
- 新边（AGENTS.md 箭头指向依赖方：`gibraltar ──▶ sec-guard`、`telemetry ──▶ sec-guard`、
  `sec-guard ──▶ sec-agent`、`gibraltar ──▶ sec-server`）进 AGENTS.md 边界图与构建序；同时
  **删除已失效的 `agent ──▶ sec-agent` 边与 `tg-agent-core` 段落**——当前工作树 AGENTS.md 仍
  写着 sec-agent 依赖 `tg-agent-core`，与包已删除矛盾，属批0 必须收尾项。
- 边界校验现实（复盘 P3-5 实测）：`check:house-standard` **不校验依赖边**
  （scripts/check-house-standard.ts:220-241），`packages/chord/test/boundary.test.ts` 只证明
  chord 是叶子——"新边进 boundary.test.ts"必须落成**真断言**（在 boundary.test.ts 或新测试里
  逐包读 package.json/tsconfig paths 验依赖集合），否则 AGENTS.md 正文与 package.json 会再次
  漂移；各包 `tsconfig.build.json` 的 paths 必须显式含新依赖，不许靠 node_modules→dist 兜底。
- erasable TS、相对导入带扩展名、tabs width 3、biome、`verbatimModuleSyntax`。
- 全部开发在分支，不进 v1；commit 格式 `feat(sec-agent|sec-guard): ...`（scope 列表同步扩）。
- 测试纪律：probe before assert；faux provider；批1 探针先红后绿。
- `scripts/legacy/**` 不受房规管辖（三处工具链排除），新增同类留存须同步排除清单；新包不得
  import 其中任何文件。
