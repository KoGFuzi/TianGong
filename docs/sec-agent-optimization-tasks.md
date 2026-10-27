# sec-agent 优化工程任务拆解（批7 起）

来源：`docs/sec-agent-optimization.md`（设计定稿）。本文件只做拆解与进度追踪，不重复设计论证；
设计出入以源文档为准，实施前必须读真实签名核对（probe before assert），出入回源文档勘误。

执行顺序：**批7（7a → 7b/7c，7d 可与 7a-7c 并行）→ 批8 → 批9；批10 可与批9 并行；批11+ 拉动式**。
每批独立可验：`bun run check` + `bun run test packages/sec-agent`（及涉及包）全绿才进下一批。

## 进度总览

| 任务 | 批次 | 状态 | 依赖 |
| --- | --- | --- | --- |
| T7a-1 角色档案定义 | 批7a | 已完成 | — |
| T7a-2 task 加 role 参数 | 批7a | 已完成 | T7a-1 |
| T7a-3 子会话 task 深度门 | 批7a | 已完成 | T7a-2 |
| T7a-4 宿主装配点同步 | 批7a | 已完成 | T7a-1 |
| T7a-5 批7a 验收测试 | 批7a | 已完成 | T7a-1..4 |
| T7b-1 子会话取证验收 | 批7b | 已完成 | T7a-5 |
| T7c-1 sections 按 role+lane 生成 | 批7c | 已完成 | T7a-1 |
| T7c-2 角色差异 sections 段 | 批7c | 已完成 | T7c-1 |
| T7c-3 批7c 验收测试 | 批7c | 已完成 | T7c-1..2 |
| T7d-1 WS ask 帧下发 | 批7d | 已完成 | — |
| T7d-2 ask_reply 回帧处理 | 批7d | 已完成 | T7d-1 |
| T7d-3 UI 待审队列 + abort 语义 | 批7d | 已完成 | T7d-2 |
| T7d-4 批7d 端到端验收 | 批7d | 已完成 | T7d-1..3 |
| T8-1 pi-mcp 依赖边落地 | 批8 | 已完成 | 批7 全绿 |
| T8-2 MCP→defineTool 桥本体 | 批8 | 已完成 | T8-1 |
| T8-3 guard 参数名分类对接 | 批8 | 已完成 | T8-2 |
| T8-4 按角色收窄注册面 | 批8 | 已完成 | T8-2, 批7a |
| T8-5 probe 4 declared 集合派生 | 批8 | 已完成 | T8-4 |
| T8-6 evidence yak flow 引用形态 | 批8 | 已完成 | T8-2 |
| T8-7 长驻资源生命周期清理 | 批8 | 已完成 | T8-2 |
| T8-8 批8 验收测试 | 批8 | 已完成 | T8-2..7 |
| T9-1 findings 表 + rubric 校验 | 批9 | 已完成 | 批8 全绿 |
| T9-2 乐观锁复用 | 批9 | 已完成 | T9-1 |
| T9-3 finding_update 工具 | 批9 | 已完成 | T9-1..2 |
| T9-4 report 文档族 + 确定性渲染 | 批9 | 已完成 | T9-1 |
| T9-5 投影 finding 帧迁移 | 批9 | 已完成 | T9-3 |
| T9-6 批9 验收测试 | 批9 | 已完成 | T9-1..5 |
| T10-1 tg.sec.plan 文档族 | 批10 | 已完成 | 批7 全绿（可与批9 并行） |
| T10-2 task 返回 findings 清单 | 批10 | 已完成 | T9-1, T10-1 可先行 |
| T10-3 终局声明工具 | 批10 | 已完成 | T9-1 |
| T10-4 批10 验收测试 | 批10 | 已完成 | T10-1..3 |
| T11-* 批11+ backlog | 批11+ | 拉动式，不提前做 | 按战役需求 |

状态取值：未开始 / 进行中 / 已完成 / 阻塞（附因）。

---

## 批7a：角色策略目录落地

目标：`TaskChildPolicy` 从"按 lane 一份"改为"按角色一份"的静态档案；角色封闭三类
（redteam / binary / reporting），宿主装配期定死，调用不可加宽。

### T7a-1 角色档案定义

- 新增角色类型 `redteam | binary | reporting` 与按角色的静态档案（extensions + 工具面 +
  模型偏好组合）。落点建议：`packages/sec-agent/src/` 新文件（如 `role-policies.ts`）或并入
  `core-extension.ts`，实施时读现有 `TaskChildPolicy`（`task-tool.ts:21` 附近）定夺，择一即可。
- 档案内容按源文档表格：
  - `redteam`：sec-core + sec-tools（http_request / evidence_capture / traffic_query）+ coding-tools。
  - `binary`：sec-core + evidence_capture + codemode（bash/read/write/edit + QuickJS 沙箱）；**无 http_request**。
  - `reporting`：只读档案（traffic_query + finding/报告读取 + evidence 读取）；零攻击工具、零 workspace 外写。
- `lane` 保留，只负责 guard/sections 的赛道条件化，不再选 policy。
- 房规：导出类型 `Tg*` 前缀、erasable TS、相对导入带 `.ts`。

### T7a-2 task 工具加 role 参数

- `task-tool.ts`：input schema 加 `role`（缺省 `redteam`），policy 选择从
  `options.policies[lane]`（`task-tool.ts:96-98`）改为按 role 取档案；lane 仍传入用于
  sections/guard 条件化与 `tg.span.sec.fork` 属性。
- span 属性加 `role`（低基数封闭枚举，符合 span 纪律）。

### T7a-3 子会话 task 不可达（深度门，源文档倾向方案②）

- fork 时把深度写进子会话文档；子会话内调用 `task` 直接 fail-closed，落 span
  `outcome: "depth-rejected"`（`tg.span.sec.*` 命名不变量）。
- 若实施中发现方案②（深度门）不可行需改方案①（拆扩展），回源文档勘误并同步本文件。

### T7a-4 宿主装配点同步

- `cli/main.ts:320-326` 与 `cli/serve.ts:144-150`：从三份相同 lane policy 改为按角色档案装配；
  两处 install 的扩展清单（`[core, secTools]`，`cli/main.ts:336`）随档案机制调整。
- bootstrap（`bootstrap.ts`）如涉及 policy 注入形状，同步。

### T7a-5 批7a 验收测试

- 三角色各 fork 一次，断言子会话工具面与档案一致（faux provider，零真 token）。
- binary/reporting 子会话内 `http_request` 不可达；reporting 子会话发起 `http_request`
  连 modelTools 都进不了。
- 子会话内调用 `task` → fail-closed + `depth-rejected` span。
- 主会话行为零变化：既有测试（`task-tool.test.ts` 等）不改即绿；如有必须改的，先判断是
  实现错还是预期错（房规 4），不得弱化断言。
- 落点：`task-tool.test.ts` 扩展或新 `role-policies.test.ts`。

**批7a 落地记录（2026-10-27）**

- 采用方案②（深度门）：fork 在同一提交里写 `tg.sec.task-scope`（conversation scope，
  `depth/role/lane`），子会话的 `task` 调用读取自身文档后 fail-closed，落
  `outcome: "depth-rejected"`、`depth: 2`。
- 角色档案在 `role-policies.ts`；`TaskChildPolicy` 增加 `tools` 白名单。`binary`/`reporting`
  通过白名单剔除 `http_request`，而非拆分 `sec-tools` 扩展；`reporting` 选中 `coding-tools`
  但只留 `read`，因此无写路径、无 codemode。
- 宿主装配点除本文件点名的 `cli/main.ts`、`cli/serve.ts` 外，`tui/app.ts` 也有同一份 lane
  policy 副本，一并改为 `secRolePolicies`。
- 既有测试因 `policies` 的键从 lane 改为 role 做了接口适配（不是弱化断言）；新增
  `role-policies.test.ts` 断言三角色扩展序、工具面闭包、`modelTools` 无法引入 `http_request`，
  以及嵌套 `task` 的 fail-closed 与 span。

## 批7b：子会话取证面（随批7a 解决）

### T7b-1 子会话取证验收

- redteam/binary 档案含 `evidence_capture` 后，验收：子会话内 `evidence_capture` 入账 →
  evidence.sqlite 有对应 binding（`tg_sec_evidence_bindings`，`evidence/schema.ts:33`）。
- 落点：`sec-evidence-tools.test.ts` 扩展或 `task-tool.test.ts` 内加子会话入账用例。
- 无独立实现任务；若验收暴露子会话 evidence 存储装配缺口（如子会话拿不到 store 句柄），
  补最小实现并记录。

**批7b 落地记录（2026-10-27）**

- 验收用例落在 `packages/sec-agent/test/role-policies.test.ts`（"sub-session evidence
  capture"）：binary 角色子会话先经 `tool_search` 取到 `evidence_capture`，再入账一次
  `http://sample.test/sample` 模拟报文。
- 断言 `store.list("sub-evidence")` 恰有一条 binding（role `supporting`），快照元数据
  `url`/`respLen` 与入账报文一致，证明子会话确实拿到父宿主同一 evidence store 句柄。
- 无实现缺口，未改生产代码。

## 批7c：子会话赛道条件化

### T7c-1 sections 按 role+lane 生成

- `sections.ts` / `core-extension.ts`：sections 从"装配期单 lane"（`options.lane` 定死）改为
  fork 时按档案的 role+lane 用 gibraltar diff-patch 机制切换。
- `LANE_RULES` 在子会话层随 lane 生效：CTF 子会话拿 hashcat/john 大词表护栏提示，SRC 子会话
  拿业务变更护栏提示。

### T7c-2 角色差异 sections 段

- 各角色注入差异段：reporting 注入取证纪律与 rubric 引用规则；redteam/binary 按定位补
  最小必要段，不堆料。

### T7c-3 批7c 验收测试

- 三 lane × 关键角色各 fork 一次，faux provider 抓 request，断言子会话系统提示含对应
  sections 文本。
- 落点：`sections.test.ts` / `sec-lane-filter.test.ts` 扩展。

**批7c 落地记录（2026-10-27）**

- 采用"section 渲染期读取会话文档"方案，而不是在 fork 提交里改写扩展：`secScopePromptSections`
  （`sections.ts`）为每个 section 在渲染时经 `input.read` 读取
  `tg.sec.task-scope`，根会话无该文档 → 宿主 lane 映射（与 7c 前字节一致）；子会话按存档的
  role+lane → `secRoleSections`。gibraltar 既有 `planSections` 对比 transcript 已展示的
  sections 并只 patch 差异键，无需自造 diff 层。
- `TgSecTaskScopeValue` 的 `role`/`lane` 从 `string` 收窄为 `TgSecAgentRole`/`SecAgentLane`；
  写入侧是 TypeBox 封闭枚举，读取侧信任内部写入（房规：系统边界才校验）。
- 新增 `role` 段与按角色的 `tools` 段：binary 只描述 evidence_capture/codemode 并明说无
  http_request/traffic_query；reporting 只描述 traffic_query/read 与取证纪律；redteam 复用
  lane 工具面。reporting 的 role 段含 rubric 引用规则。CTF lane 规则补 hashcat/john 大词表
  护栏，SRC 补业务变更护栏。
- 验收测试：`sections.test.ts` 三角色×三 lane 的映射与差异断言；`role-policies.test.ts`
  每个 lane 起一个 campaign，连续 fork 三角色，从 faux provider 请求回放 sections，断言根会话
  4 段、子会话 5 段且 `lane`/`role`/`tools`/`rubric` 与映射逐字节一致；另有 lane 覆盖用例
  （宿主 redteam、子会话 binary+ctf）证明存储 lane 生效。

## 批7d：WebUI ask 通道（可与 7a-7c 并行）

### T7d-1 WS ask 帧下发

- guard 的 ask 决策 → sec-server WS `ask` 帧（含 reason、参数摘要、forced 标志）。
- 涉及：`sec-agent/src/ask.ts`、`guard-wiring.ts`（ask 通道抽象处接 WS 通道）；
  `sec-server/src/contract.ts`（帧契约）、`websocket.ts`、`server.ts`。
- 契约字面量对齐 StrikeAgent 同构方向（批6 既定），帧进 `contract.ts` 既有契约面。
- sec-guard 内部零改动（冻结前提）；只在 sec-agent 宿主侧兑现通道。

### T7d-2 ask_reply 回帧处理

- UI 回 `ask_reply {allow | deny | always}`；`always` 走 sec-guard 既有 grants 语义
  （精确 resource 记录、危险集不豁免）。
- 安全面与 steer 同级：Origin 校验 + `x-tg-sec-steer: 1` 头 + cookie（复用批6 既有件，
  `sec-server/src/auth.ts`）。
- forced ask 挂起语义不变：v1 不超时；会话级 abort 即拒绝（走既有 abort 路径）。

### T7d-3 UI 待审队列

- WebUI 常显待审队列（自写 UI，样式对齐 StrikeAgent 布局风格）。
- 涉及 `sec-server/src/assets.ts` 内前端资产。

### T7d-4 批7d 端到端验收

- serve 模式命中危险集样本 → WS 收到 ask 帧 → 回 deny → 工具 block。
- 回 always → 同 resource 后续放行，但危险集样本仍 ask（grants 不豁免语义端到端）。
- 落点：`sec-server/test/server.test.ts` / `websocket.test.ts` + `sec-agent/test/guard-wiring.test.ts`
  或新 `ask-channel.test.ts`；用 `websocket-client.ts` 测试件。

**批7d 落地记录（2026-10-27）**

- 审批队列落在 `sec-server/src/approvals.ts`（`createSecApprovalQueue`），刻意不 import
  sec-guard：宿主把 `(request, decision)` 适配成 `queue.ask({ toolName, resource, reason, forced,
  args })`，`always` 的语义仍完全由 guard 决定。sec-agent 的新 `createApprovalAskChannel` 就是
  该适配层，`tg-sec serve` 在 guard 构造前创建队列，guard 与 `host.approvals` 共用同一个对象。
- 参数摘要在入队时完成：`projector.ts` 的 `summarizeJson` 从 `JsonValue` 放宽为 `unknown` 并导出，
  与 `tool` 帧共用同一套 key 上限、深度上限和 body 型键（`body`/`requestBase64`/…）脱敏；浏览器
  永远拿不到证据字节。非 JSON 叶子（`undefined`/`NaN`/`bigint`/函数）显式转成字符串，不抛错。
- 契约面：`SEC_EVENT_TYPES` 增加 `ask`，事件 payload 增加 `SecAskPayload`（`id`/`toolName`/
  `resource`/`reason`/`forced`/`args`）；客户端帧增加 `ask_reply {id, reply}`，reply 封闭为
  `allow | deny | always`。服务端把队列订阅到广播，每个新连接在 snapshot 之后重放全部 pending
  ask；snapshot 同时是 WebUI 的重置点，因此重连既不会丢掉待审项，也不会留下已结算项。
- 安全面：`ask_reply` 是 WebSocket 帧，浏览器无法在 WS 握手加自定义头，因此沿用既有 WS upgrade
  门（`Host` + `Origin` + cookie + `Sec-Fetch-Site`），与 WS steer 同级；HTTP `POST /api/steer`
  的 `x-tg-sec-steer: 1` 要求不变。这里相对任务文字“复用 steer 的 header”做了实现层勘误：WS
  无法携带该头，换成同级的连接期证明。
- abort/关闭：forced ask 仍不超时（v1）；`server.shutdown()` 先 `denyAll()` 再停事件流，
  `tg-sec serve` 的 shutdown 另调 `approvals.close()`，因此挂起的工具调用按 `deny` 结束，既有
  abort 路径不会卡在浏览器上。TUI 的 ctrl+c 逻辑此前已是“有待审 ask 则全部 deny”，未改。
- WebUI：侧栏顶部常显 `#approvals` 队列，显示工具名、resource、reason、参数摘要与 forced 标记；
  forced ask 不显示 `always`（guard 只放行本次），普通 ask 提供 allow once / always / deny。
  样式沿用现有 `item`/`badge` 体系，无内联脚本，CSP 不变。
- 验收：`sec-server/test/approvals.test.ts`（入队/通知/结算/全部拒绝/关闭、摘要脱敏与上限）；
  `server.test.ts` 新增“ask 下发 + 摘要 + reply 结算”和“晚到客户端重放 + 关闭时 deny”；
  `sec-agent/test/ask-channel.test.ts` 用真实 `Harness` + `startSecServer` + `TestWsClient`
  跑通两条语义：strict ask 回 `always` 后切到 auto，同 resource 由 grant 直接放行；危险集样本
  回 `always` 只放行本次，第二次仍收到 forced ask，回 `deny` 后工具被 block。sec-guard 零改动。

---

## 批8：MCP 工具桥（P1）

前置：批7 全绿。测试全程 faux MCP server（stub），不连真实 yak/mitan 实例。

### T8-1 pi-mcp 依赖边落地

- 新增 `sec-agent → @earendil-works/pi-mcp` 依赖边，四处同步：
  1. `packages/sec-agent/package.json`（exact 版本）+ `bun install` 重生 `bun.lock`；
  2. 根 `tsconfig.json` path map / 构建序；
  3. `packages/sec-agent/test/boundary.test.ts` 成真断言；
  4. AGENTS.md 边界图 + `docs/provenance.md`（如同批要求）。
- pi-mcp 为 vendored 冻结包：不改其 manifest/源码/命名，按上游名 import。

### T8-2 MCP→gibraltar defineTool 桥本体

- MCP Tool 包成 gibraltar `defineTool` 注册，注册后自动过 guard `beforeTool`（不为 MCP 单开
  权限面）。
- 移植底稿 `scripts/legacy/sec-agent/src/extensions/mcp/`（绑旧 ExtensionAPI，**翻译不复用**，
  legacy 只读、任何包不得 import）。
- 宿主 MCP 配置缺失时对应工具面不注册而非报错（决策记录 4：不构成运行时恒连假设）。

### T8-3 guard 参数名分类对接

- MCP 工具参数走既有参数名三分类：`target`/`host`/`url`/`targets`/`domain` 进
  `declared-target`；未知键默认 `command-text`（保守方向不变）。
- **实施期一次性勘察**：对 yak/mitan 高频工具参数名逐一 probe（连真实实例勘察，非测试依赖），
  缺名补进清单，结果回源文档勘误。
- 危险集文本扫描对 MCP 参数同样生效（yak 插件间接触发 sqlmap 类调用仍在扫描面内）。

### T8-4 按角色档案收窄注册面

- 全部 MCP 工具 `deferred: true`，靠 `tool_search` 点名；注册面按角色收窄为宿主装配期封闭集
  （与批7a 档案同机制）：
  - redteam：yak/mitan 扫描与发包族；
  - binary：IDA MCP + pcap/样本分析族；
  - reporting：只装 `query_*` 只读族（query_http_flow / query_risk 等）。
- 工具面规模只作量级参考（调研时点 161/44，随版本漂移），清单不写死进代码常量以外的地方。

### T8-5 probe 4 declared 集合由宿主配置派生

- probe 4 的 declared 集合**由同一份宿主 MCP 配置派生**，不写死清单——避免"少配一个 server"
  误红、"多注册一个工具"漏红。
- 落点：`guard-wiring.test.ts` 或相关 probe 测试改造。

### T8-6 evidence_capture 增 yak flow 引用形态

- 给 flow id → 经 `fetch_http_packet_by_id` 取回报文字节入 blob（内容寻址既有管线，
  `evidence/blobs.ts` / `store.ts`），snapshot 元数据记 flow id 供溯源。
- 纪律不变：Yakit http-flow 库是操作数据，TianGong 证据库是取证权威，两者不混。
- 涉及 `tools/evidence-tools.ts`。

### T8-7 长驻资源生命周期

- `start_mitm_v2` 类调用起 yak 侧长驻监听；桥层负责会话结束/abort 时的清理调用与状态对账
  （dangling listener 属战役级事故）。
- 落点：桥本体（T8-2 产物）+ 会话生命周期钩子。

### T8-8 批8 验收测试

- yak/mitan stub server（faux MCP）注册 → guard forced ask 对其 scope 外目标生效。
- 三角色注册面互不越界。
- flow id → blob 的取证链路字节级一致。
- 会话 abort 后无遗留监听。
- 每加一个工具面，probe 4 declared 集合同步扩（批5-A 勘误 7 先例）。

**批8 落地记录（2026-10-27）**

- T8-1：依赖边按房规落成 `^1.4.0` caret。任务文字写“exact 版本”，但 AGENTS.md 与
  `check-house-standard` 对 vendored 包强制 caret；按房规执行，并在 `docs/provenance.md`
  记录冻结规则。`test/boundary.test.ts` 现在断言 pi-mcp 为第二条 vendored 边。
- T8-2：桥在 `src/mcp/bridge.ts`，MCP `Tool` 翻译为 gibraltar `defineTool`（翻译不复用
  legacy），全部 `deferred: true`、`callers: ["model","tools"]`、`replay: "unsafe"`，命名
  `mcp__<server>__<tool>`（非 `[A-Za-z0-9_]` 替换、64 字符上限、冲突/超长加 8 位 sha256
  后缀）。配置缺失 = 空工具面；单 server 连接/列举失败只记 `errors`，不拖垮其余。
- T8-3：`TARGET_VALUE_PARAMETERS` 增 `domain`/`domains`（`packages/sec-guard/src/command-text.ts`），
  并有 `command-text.test.ts` 断言。**实施期勘察未执行**：无真实 yak/mitan 实例、按批8 前置
  “不连真实实例、零真实 token”，未做线上参数名逐一 probe；`domain`/`domains` 为设计文档
  已点名的名字，其余未知键继续走保守的 `command-text` 默认。待有真实实例时补勘误。
- T8-4：装配期角色收窄。每个非空角色一个扩展 `sec-mcp-<role>`，`secRolePoliciesWithMcp`
  把扩展名与工具名并入该角色静态档案；桥测试断言三角色注册面两两不交。
- T8-5：`secDeclaredTools(lane, extraTools)` 接收 `bridge.declaredTools`；CLI/serve/TUI 三个
  宿主装配点都从同一份 MCP 配置派生 declared 集合，`sec-mcp-guard.test.ts` 断言加 server 后
  probe 4 仍绿。
- T8-6：`evidence_capture` 新增 `flowId` 形态，经桥的 `fetch_http_packet_by_id` 取回字节，
  走既有内容寻址 blob 管线；`flow_id` 列落库（旧库 `ALTER TABLE` 补列，默认空串）。快照 id
  兼容策略：flowId 为空时 preimage 与 v1 完全一致（旧 id 不变），非空时 tag 升
  `tg.sec.evidence/v2` 并追加 flowId。默认 packet 适配器假定
  `structuredContent.requestBase64/responseBase64`（可注入 `flowPacket` 覆盖），属待真实
  yak 版本核对的假定契约。
- T8-7：桥记录成功的 `startTools` 调用，`close()` 按逆序对每条记录调用一次 `stopTool`，再关闭
  全部 client；桥 close 幂等。宿主经 `openSecAgent.onClose` 挂接（harness → sandbox → onClose
  的嵌套 finally 保证一定执行）；`sec-mcp-host.test.ts` 用 abort 中的会话 + agent close 断言
  只停一次、client 已关、二次 close 无副作用。
- T8-8：新增 `test/mcp-stub.ts`（`createInMemoryTransportPair` 上的 faux MCP server，协议真实、
  不 spawn 进程、不开 socket）与三套验收：`sec-mcp-bridge.test.ts`（注册/角色/flow/清理/配置/
  命名/故障隔离）、`sec-mcp-guard.test.ts`（scope 外 forced ask、scope 内放行、危险集文本扫描、
  probe 4、flow 工具同一注册面）、`sec-mcp-host.test.ts`（宿主装配与关闭 seam）。全量
  `bun run check` + `bun run test packages/sec-agent`（29 文件/178 用例）+
  `bun run test packages/sec-guard`（11 文件/388 用例）全绿。

---

## 批9：发现-报告-复测闭环（P2）

前置：批8 全绿。

### T9-1 findings 表

- evidence.sqlite 内新表（与快照同库，`evidence/schema.ts` 扩）：
  `finding_id, lane, title, severity(rubric 四级), status(open|verified|retest-pass|retest-fail|wontfix),
  subject_id, created_at, updated_at`。
- severity 只允许 rubric 四级，写入侧校验；枚举来源与 `sections.ts` RUBRIC 共用同一处
  （数据层与提示层不各写一份）。

### T9-2 版本乐观锁复用

- findings 复用既有 `tg_sec_evidence_versions`（`evidence/schema.ts:43`）逐主体版本机制，
  不造第二套并发控制。

### T9-3 finding_update 工具

- 新工具 `finding_update`（`deferred: true`），落点 `tools/evidence-tools.ts` 或新
  `tools/finding-tools.ts`。
- 状态迁移合法性在工具层校验：`verified → retest-*` 必须附新证据 snapshotId
  （"复测必须留新证"是机制不是纪律）。

### T9-4 report 文档族 + 确定性渲染

- `tg.sec.report` defineDocFamily（参照 `action-tree.ts:41` 的 `tg.sec.action-tree` 形状）存
  报告版本指针。
- 报告生成工具 v1 只做确定性渲染：findings 按严重度排序 + 每条附证据 snapshotId 清单；
  **不做 LLM 代写全文**（证据文本不进模型上下文，进的是元数据）。
- 实测留存与还原报文分离的既有纪律在渲染层继承。
- reporting 角色是主消费者（批7a 档案已给只读取证面，注册面对齐）。

### T9-5 投影 finding 帧迁移

- findings 表变更 → `finding` 帧状态迁移（批6 契约已有 finding 帧与验证状态枚举，
  **零契约改动**）。落点：`sec-server/src/projector.ts` / `projection.ts` 的事件源接 findings 变更。

### T9-6 批9 验收测试

- finding 从 open → verified → retest-pass 全程落库 + span（`tg.span.sec.*` 两段式）。
- retest 迁移无新证据被拒。
- 报告渲染确定性：同输入同字节。
- rubric 外严重度写入被拒。

**批9 落地记录（2026-10-27）**

- T9-1：`evidence/schema.ts` 增 `tg_sec_findings`（`finding_id` 主键、`lane`、`title`、
  `severity`、`status`、`subject_id`、`created_at`、`updated_at`，并增 `retest_snapshot_id`
  以支持连续复测的“新证据”判定）。`severity`/`status` 在 SQL 层带 `CHECK`，写入路径先过
  `finding-vocabulary.ts` 的断言；`sections.ts` 的 RUBRIC 名称、顺序与中文标签也改由同一份
  词表派生，数据层与提示层不再各写一份。
- T9-2：finding 写入直接复用 `tg_sec_evidence_versions` 与 `lockSubject`，没有第二套并发控制；
  `expectedVersion` 与 `bind`/`edit` 语义一致。
- T9-3：`finding_update`（deferred）落 `tools/finding-tools.ts`。首次写入要求
  `lane`/`title`/`severity`，状态固定 `open`，lane 创建后不可改；工具层先校验迁移合法性，
  存储层再次校验。`retest-pass`/`retest-fail` 必须附一个已绑定到该 subject 的 `snapshotId`，
  且不得与 `retest_snapshot_id` 相同；未绑定快照返回 not-found，重复快照返回 conflict。
- T9-4：`tg.sec.report` family（`report.ts`）保存 revision、digest、findings 元数据与正文；
  `report_generate`（deferred）按严重度（同级按 id）排序渲染，正文只含状态、证据版本与
  snapshotId 清单，不含证据正文与时间戳，同输入同字节。正文仅进 `structuredOutput`，
  transcript 只看到元数据行。报告头需要 project/target，`SecToolsExtensionOptions` 增两个可选
  字段并由 main/serve/tui 三个装配点传入。
- T9-5：`SecProjectionInput.findings` 为可选字段（旧调用零改动），投影把 finding 行的
  severity 直接映射到既有 `SecSeverity`，生命周期映射为 `open→pending`、
  `verified|retest-pass→verified`、`retest-fail→rejected`、`wontfix→excluded`；无 finding 行的
  evidence subject 维持原 `info/pending` 投影。wire contract 未改。
- T9-6：新增 `finding-loop.test.ts` 覆盖生命周期 + 审计 span、无新证据复测被拒、rubric 外
  severity 被拒、报告同字节与文档 revision；`sec-server` 增 finding 节点/状态映射/无证据 finding
  与 finding 帧迁移测试。`bun run check` 全绿；`bun run test packages/sec-agent`（30 文件/181
  用例）、`bun run test packages/sec-server`（7 文件/70 用例）全绿。
- 勘误：finding 写入复用 `tg.span.sec.evidence` 的 `edit` op，未扩 telemetry schema；创建与更新
  都按 `edit` 记账，`changed` 区分是否真正写入。

---

## 批10：计划、结构化委派与终局判定（P3，可与批9 并行）

### T10-1 tg.sec.plan 文档族

- 主 agent 计划落成 durable 文档（gibraltar defineDocFamily，参照 action-tree 形状）。
- WebUI 投影 intents 以 plan 文档为准（当前只靠 fork 意图前缀，计划修订不可见）。
  落点：`sec-server/src/projector.ts`。

### T10-2 task 结构化返回扩展

- `task-tool.ts:135` 返回值 `{conversationId, status, summary}` 加 `findings: string[]`
  （子会话入账的 findingId 清单）：子会话 `evidence_capture` 时登记，task 收尾读回。
- 依赖批9 的 findings 表；批10 先行部分（T10-1）不依赖。

### T10-3 赛道终局判定

- 新工具（deferred）：每赛道一个声明形状（getshell / getflag / high_critical_finding）。
- 宿主侧校验声明是否成立（如 CTF flag 提交记录存在）；未成立的声明投影层标 `unverified`。
- 判定权威留在宿主，不交给模型自评。

### T10-4 批10 验收测试

- plan 文档修订可枚举可回放。
- task 返回 findings 清单与 evidence.sqlite 一致。
- 未验证终局声明不改变 finding 状态。

**批10 落地记录（2026-10-27）**

- T10-1：`plan.ts` 落地 `tg.sec.plan`（session 文档族，key 为十进制修订号，每修订一个不可变
  member）与 `tg.sec.plan-head`（session 单例，存最新修订号）。修订号由 head 在同一 commit 内
  读取并递增，`appendPlanRevision` 同时写 member 与 head，并发写者要么先落地要么看见新 head。
  这样绕开了 session 文档没有 as-of 读取的限制：修订本身按 key 直接 `snapshot` 回放，枚举走
  `scanDocuments({scope:{kind:"session"},at:"current",kind:"tg.sec.plan"})` + `document(id,"current")`，
  升序返回。`plan_update`（deferred）接收完整步骤清单，空 `stepId` 按位置生成 `step-N`、重名
  追加 `-2`，返回 revision/stepCount/openSteps；`listPlan`/`latestPlan` 供宿主与投影使用。
  `sections.ts` 增加 root-only 的 `plan` 段（子会话无此段）。投影侧 `SecProjectionInput.plan`
  存在时以最新修订重建 intents（done→verified、dropped→disproved、active/open 保留），不存在时
  维持 action intent 回退；修订替换 intent id 时 projector 以 snapshot 重同步。
- T10-2：`task-findings.ts` 落地 `tg.sec.task-findings`（session 文档族，key 为十进制会话 id）。
  `evidence_capture`、`http_request`、`finding_update` 在成功写入/绑定后把 findingId 登记到调用
  会话的文档；`task` 在子会话 settle 后按 key 一次 `snapshot` 读回，`findings: string[]` 进入
  structured output。清单来自文档而非子会话摘要文本；depth-rejected 返回空清单。
- T10-3：`terminal.ts` 落地 `tg.sec.terminal`（session 文档族，key 为 `${lane}:${claim}`，同一
  声明重写取最新值）。`terminal_declare`（deferred）按赛道收口声明形状：redteam=getshell、
  ctf=getflag、src=high_critical_finding，声明与赛道不符直接 TypeError。宿主校验：
  finding 类要求 finding 存在且 severity 为 high/critical、状态为 `verified|retest-pass`；
  getshell 还要求该 finding 至少有一个已绑定快照（显式 `snapshotId` 必须已绑定）；
  getflag 由宿主注入的 `verifyFlag` 对照提交记录，未注入则一律 `unverified`。未成立声明持久化为
  `unverified`，任何声明都不改 finding 状态；raw flag 只参与瞬时校验，不落库。投影把声明渲染为
  `goal` 节点：未验证为 `info/unverified`、不计 `has_shell`；已验证 getshell 为
  `critical`+`is_rce`、计入 `has_shell` 并形成 target→goal 的 RCE 路径（为此 `sinkPriority`、
  `attackAdjacency` 与 `isLandedShell` 只认已验证的 shell goal）；已验证 getflag 用 `high` 下限。
- T10-4：`test/batch10.test.ts` 覆盖 plan 两修订的枚举/回放/head 前进、task findings 与
  `evidence.sqlite` 绑定一致、redteam 未验证/已验证终局声明、CTF flag 宿主校验且原始 flag
  不出现在持久化记录；未验证声明打在**已存在的 medium finding** 上并核对库内状态保持
  `open`（未验证声明不改 finding 状态的工具层证据），未注入 `verifyFlag` 时 getflag 一律
  `unverified` 且 `verifiedAt: 0`。`sec-server` 增 plan intent 替换/状态映射/回退与 terminal
  节点/`has_shell`/RCE 路径测试，projector 增修订重同步测试。`bun run check` 全绿；
  `bun run test packages/sec-agent`（31 文件/186 用例）、
  `bun run test packages/sec-server`（7 文件/77 用例）全绿。
- 勘误：`task`、`plan_update`、`terminal_declare` 的 `callers` 从 `["model"]` 扩到
  `["model","tools"]`。这让编排程序与 code mode 能经 `executeTool` 驱动委派与战役控制面；
  深度门、角色策略与宿主终局校验仍是权威，模型的工具面不变。plan 修订数是文档计数而非时间戳，
  head 单例是并发与回放的唯一序号来源。

---

## 批11+：执行通道与其余工具面（P4，拉动式 backlog，不提前做）

> 本批只在战役需求出现时立项；以下条目是形状预留与验收钉点，不是待办承诺。

- **T11-1 local_tool_check**：deferred 工具，`command -v` 批量探测 + 版本首行；结果只进工具
  返回不进 span 属性（自由文本）。验收：返回与 `command -v` 实测一致。
- **T11-2 双通道同链验收钉**：kali-mcp 经批8 桥注册按角色过滤；本地 bash 保底。验收：
  hydra 对 scope 外目标命中 forced ask（layer=scope）；权限维持样本命中危险集 B 类 forced ask；
  同一目标 MCP 与 bash 两通道决策一致。
- **T11-3 输出截断确认**：hydra/searchsploit 大输出走既有 `truncate.ts`（2000 行/50KB），
  重输出下放子会话纪律不变。零新增代码，验收钉住即可。
- Kali 终端工具默认本地已配置 bash 直跑，**零新增装配**（guard bash scope 解析链与危险集已覆盖）。
- tg-env 主场景 = 远端跳板机 SSH 控制；sec-agent 维持不依赖 tg-env（批3 勘误 7），env 宿主注入。
- 二进制安全缺口（调试器壳、样本哈希入账等）与自写 Go sidecar：实测缺口出现再立项，不预置。

---

## 全批次通用纪律（每任务完成前自查）

- [ ] probe before assert：断言前先跑最小探针核实真实签名/返回值；新策略带 attestation 探针
      或既有探针扩展，先红后绿。
- [ ] faux provider 全程，零真 token；judge 用 stub。
- [ ] 新依赖边四处同步：AGENTS.md 边界图 + 根构建序 + 逐包 package.json/tsconfig paths +
      boundary.test.ts 成真断言。
- [ ] 新 span 进 `TG_SPAN_SCHEMA`（`tg.span.sec.*` 两段式）；span 属性只放低基数封闭枚举。
- [ ] 持久 kind `tg.sec.*`；env var `TG_SEC_*`；导出类型按各包既有前缀。
- [ ] erasable TS、相对导入带 `.ts`、tabs width 3、biome、`verbatimModuleSyntax`；
      不手跑 tsc/biome/vitest，走根脚本。
- [ ] CHANGELOG：`packages/sec-agent/CHANGELOG.md`、`packages/sec-server/CHANGELOG.md` 的
      `## [Unreleased]` 下按序追加。
- [ ] sec-guard 零改动、无其 commit；`scripts/legacy/**` 只读，任何包不得 import。
- [ ] commit 格式 `feat(sec-agent|sec-server): ...`；分支开发，不进 v1 freeze；
      不 commit 除非被要求。
- [ ] 测试删净 instrumentation（console.log 探针是脚手架不是交付物）。
