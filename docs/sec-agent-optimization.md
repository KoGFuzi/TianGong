# sec-agent 优化工程文档（批7 起）

状态：设计定稿，待实施。实施侧 Fedora/qoderclicn。本文档与代码不一致时代码是错的——实施前必须
先读真实签名核对引用的 API 形状，出入以代码为准并回本文档勘误（房规：probe before assert）。

配套文档：`docs/sec-agent-design.md`（批0-6 落地记录）、`docs/sec-guard-design.md`（权限链，
已定案不动）、`docs/permission-model.md`（图纸语义）、`docs/sec-agent-optimization-tasks.md`
（任务拆解与进度）、`docs/sec-agent-optimization-errata.md`（批7-11 实现对照勘误）。

## 背景与定位

批0-6 落地后，TianGong-2 的骨架是对的：gibraltar 原生循环、durable day-one、四级权限链、
证据子系统、契约投影 WebUI 全部在位且有测试钉住。与 ARTEX / StrikeAgent / opencode 的三方
调研（2026-10-26 会话）对照后的结论是：**缺的不是参照里的机制，是三条装配线**——子会话能取证、
发现能回传、交付能闭环。本文档把这三条缝落成批次计划。

明确的前提（不得翻案）：

- 四级权限模式与 sec-guard 求值链已冻结，本文档零改动 sec-guard 内部。
- 图是投影不是控制面（批6 已定）：行动树在 `tg.sec.action-tree`，控制面 = 主 agent 上下文 +
  fork 树。不引入 ARTEX 式 Postgres 双图控制面。
- ARTEX / StrikeAgent 为 AGPL，只借鉴思路与契约字面量，禁止复制源码。

## 决策变更记录（2026-10-27 用户拍板）

1. **类型化 subagent 角色目录回归**，推翻 sec-agent-design.md 的"会话级委派，非类型化角色"条与
   本文档原"明确不做"对应项。目录封闭三类：**红队渗透测试（redteam）、二进制安全研究
   （binary）、渗透报告撰写（reporting）**。运行时形态不变——角色是**静态策略档案目录**
   （extensions + sections + 工具面 + 模型偏好的固定组合），子会话仍是会话级 fork；不引入独立
   长期运行的角色实体，不做操作者自定义角色类型（防 repo-controlled 信任面回归）。
2. **WebUI 维持类 StrikeAgent 设计**：批6 的"自写 UI + StrikeAgent 同构契约投影"方向获确认，
   后续 UI 迭代继续对齐其布局风格（实现与样式自写，契约字面量照搬）。
3. **单 TS 技术栈结论**：控制面（harness/guard/sec-server/证据库）留 Bun/TS——负载为 I/O
   密集 + SQLite 单写者，事件循环模型够用且串行写本是正确性要求；稳定性短板在进程监督
   （多进程 + systemd + `resume()`），不在语言。**Go 数据面由 Yakit 引擎承担**（见下条），
   自写 Go sidecar 只在 MCP 覆盖不了的缺口出现时再评估，不做预防性改写。参照分工佐证：
   ARTEX 的 Go 是执行面语言，StrikeAgent 的 pi TS 只是 shell runtime——没有参照用单一语言打
   全场。
4. **工具链来源定调**：发包与流量捕获 = **Yakit MCP + mitan MCP**（本次调研会话中两者均已
   连接并验证可调——仅作使用场景示例，**不构成运行时恒连假设**：产品侧按宿主 MCP 配置接入，
   缺失时对应工具面不注册而非报错），yak 侧 161 工具含 `port_scan`/`subdomain_scan`/
   `web_fingerprint`/`http_fuzzer`/`start_mitm_v2`/`query_http_flow`/`analyze_pcap`/
   `syntaxflow_scan`，mitan 侧 44 工具含 `port`/`subdomain`/`fingerprint`/`web_vuln_probe`/
   `poc`；二进制安全 = **IDA Pro 等 MCP**；其余终端类工具默认本地已配置、bash 直跑；
   **tg-env 的主要应用场景是远端跳板机 SSH 控制**——这是主场景澄清，**不取代既有设计定位**
   （sec-agent-design.md「边界装配」的宿主注入远程 ExecutionEnv、远程目标操作走 tg-env SSH
   通道继续有效）。含义：高发扫描与流量捕获由 Yakit/mitan 在编排进程外承担（"Go 数据面"以
   Yakit yaklang 引擎的形式存在于架构外环）；**编排机并非零发包**——`http_request` 与本地 bash
   直跑的工具流量仍从编排机发出，统一受 guard 的 beforeTool 链管控，TS 进程自身只做 MCP 调用
   与低频 HTTP。

## 现状基线（2026-10-27 实测）

- 批0-6 全落地：`packages/sec-agent`（bootstrap/task-tool/sections/evidence/tools/cli）、
  `packages/sec-guard`（11 探针、32 条危险集、judge 两轴）、`packages/sec-server`（契约投影 +
  RFC6455 自写 WS + ticket/cookie 登录）。
- 工具面：`sec-core`（task + sections + guard hook）与 `sec-tools`（`http_request` /
  `evidence_capture` / `traffic_query`，全 `deferred: true`）两个扩展，宿主
  `cli/main.ts:320-326` 与 `cli/serve.ts:144-150` 同时 install。
- 委派：`task` 工具 fork 子会话，`agent.extensions = [...policy.extensions]`
  （`task-tool.ts:105`），返回值是 `{conversationId, status, summary}` 结构化输出
  （`task-tool.ts:135`）。

## 三条装配缝（均有代码钉点）

### 缝一：子会话没有 sec 工具，取证在结构上不可能

三个赛道的子策略逐字相同：`{redteam|ctf|src}: { extensions: ["sec-core"] }`
（`cli/main.ts:320-324`、`cli/serve.ts:144-148`）。sec-tools 是独立扩展，不在子会话的
extensions 清单里，因此子会话**没有** `http_request` / `evidence_capture` / `traffic_query`。

后果：设计文档要求"需要留证的输出必须在子会话里显式入账"
（sec-agent-design.md「子代理与行动树」），但子会话连 `evidence_capture` 都没有——这条纪律
在当前装配下不可执行。取证只能发生在主会话，与"重活下放子会话"的委派模型直接冲突。

### 缝二：`task` 的 `lane` 参数是死参数

`task` 接受 `lane` 并据此选 policy（`task-tool.ts:96-98`），但三条 policy 相同，所以 lane 只
影响 `tg.span.sec.fork` 的属性值。更实质的问题：子会话的 sections 来自**根 lane 创建的同一个
sec-core 实例**（`core-extension.ts` 的 `options.lane` 在装配期定死），子会话换 lane 不会换
`LANE_RULES`——赛道条件化在子会话层整体失效。

### 缝三：ask 通道只有 CLI/stdin，WebUI 无人值守时 forced ask 挂死

危险集/scope 外/规则 deny 的 forced ask 由宿主 UI 通道兑现；当前唯一通道是 CLI 的 stdin 交互。
`tg-sec serve`（WebUI）路径没有 ask 兑现面——steer 是输入注入不是审批通道。WebUI 会话一旦
命中 forced ask 就永久挂起（L2/L3/L4 要求 ask 通道有人值守，sec-guard-design.md 已定调）。

## P0：补三条缝 + 角色目录（批7）

### 批7a：角色策略目录落地

`TaskChildPolicy` 从"按 lane 一份"改为**按角色一份**的静态档案，`task` 工具参数加 `role`
（`redteam | binary | reporting`，缺省 `redteam`）；`lane` 参数保留，只负责 guard/sections 的
赛道条件化。档案内容（封闭三类，宿主装配期定死，调用不可加宽）：

| 角色 | extensions | 工具面要点 | 定位 |
| --- | --- | --- | --- |
| `redteam` | sec-core + sec-tools | http_request / evidence_capture / traffic_query + coding-tools | 前渗透与打点，重输出隔离 |
| `binary` | sec-core + evidence_capture + codemode | bash/read/write/edit + QuickJS 沙箱跑 PoC；**无 http_request** | 样本分析、漏洞验证脚本 |
| `reporting` | 只读档案：traffic_query + finding/报告读取 + evidence 读取 | **零攻击工具、零 workspace 外写** | 取证汇总与报告渲染 |

三个角色档案里 task 一律不可达（拆扩展或深度门，见下）——表格写的 sec-core 是否含 task 由
该抉择决定，不影响其余面。

- 子会话**不得**获得 `task`（无孙会话，v1 前台单跳已定）。落地方式二选一，实施时择一并回本文档
  勘误：① sec-core 拆为"sections + guard hook"与 task 两个扩展，子会话只装前者；② task 加
  深度门，fork 时把深度写进子会话文档，子会话内调用直接 fail-closed 并落 span
  `outcome: "depth-rejected"`。倾向 ②——扩展面不变、拒绝有审计。
- reporting 角色的"只读"靠两层：档案不装攻击工具（能力面）+ guard 的 beforeTool 仍是权威层
  （工具过滤器不是边界的既定结论不变）。
- 验收：三角色各 fork 一次，断言子会话工具面与档案一致；binary/reporting 子会话内
  `http_request` 不可达；reporting 子会话发起 `http_request` 连 modelTools 都进不了；
  主会话行为零变化（既有测试不改即绿）。

### 批7b：子会话取证面（随批7a 角色档案解决）

redteam/binary 档案含 `evidence_capture`，"需要留证的输出必须在子会话里显式入账"从不可执行
的纪律变成机制。验收：子会话内 `evidence_capture` 入账后 evidence.sqlite 有对应 binding。

### 批7c：子会话赛道条件化

- sec-core 的 sections 从"装配期单 lane"改为"按 policy 的 role+lane 生成"：gibraltar sections
  是 diff-patch（`sections.ts` 已有机制），fork 时按档案切换。`LANE_RULES` 在子会话层随 lane
  生效（CTF 子会话拿 hashcat/john 大词表护栏提示，SRC 子会话拿业务变更护栏提示）；角色差异
  进各角色的 sections 段（如 reporting 角色注入取证纪律与 rubric 引用规则）。
- `task` 的 `lane`/`role` 参数从此都有真实语义。
- 验收：三 lane × 关键角色各 fork 一次，faux provider 抓 request 断言子会话系统提示含对应
  sections 文本。

### 批7d：WebUI ask 通道

- sec-server 增审批帧：`guard` 的 ask 决策 → WS `ask` 帧（含 reason、参数摘要、forced 标志）；
  UI 回 `ask_reply {allow|deny|always}`。`always` 走 sec-guard 既有 grants 语义（精确 resource
  记录、危险集不豁免）。
- 安全面复用批6 既有件：ask_reply 与 steer 同级（Origin 校验 + `x-tg-sec-steer: 1` 头 +
  cookie），WS 帧走同一连接。
- forced ask 的挂起语义不变（guard 等通道），超时策略：v1 不超时、UI 常显待审队列，会话级
  abort 即拒绝（走既有 abort 路径）。
- 验收：serve 模式下命中危险集样本 → WS 收到 ask 帧 → 回 deny → 工具 block；回 always →
  同 resource 后续放行但危险集样本仍 ask（grants 不豁免语义端到端）。

## P1：MCP 工具桥（批8）

工具链来源定调（决策变更记录 4）后，MCP 桥从原批10 提前——它是 redteam/binary 角色档案的
真正工具来源，`http_request` 只是兜底。原"无消费者不造边"的推迟理由随消费者出现而消失。

- **桥本体**：新增 `sec-agent → @earendil-works/pi-mcp` 依赖边（boundary.test.ts 与 AGENTS.md
  边界图同步扩，逐包 package.json/tsconfig paths 断言落真）。MCP Tool 包成 gibraltar
  `defineTool` 注册，注册后自动过 guard 的 `beforeTool`（gibraltar 语义白送，不为 MCP 单开
  权限面）。移植底稿 `scripts/legacy/sec-agent/src/extensions/mcp/`（绑旧 ExtensionAPI，翻译
  不复用）。
- **guard 分类对接**：MCP 工具的参数走既有参数名三分类——`target`/`host`/`url`/`targets`/
  `domain` 一类进 `declared-target`（实施前对 yak/mitan 高频工具的参数名逐一 probe，缺名补进
  清单）；未知键默认 `command-text`（保守方向不变）。危险集文本扫描对 MCP 参数同样生效
  （经 yak 插件间接触发的 sqlmap 类调用，参数仍在扫描面内）。
- **工具面规模控制**：yak/mitan/IDA 的面（调研时点计数 161/44，会随版本漂移，只作量级参考）
  不能全量进上下文——全部 `deferred`，靠 `tool_search` 点名；**按角色档案收窄注册面**：
  redteam 装 yak/mitan 扫描与发包族，binary 装 IDA MCP + pcap/样本分析族，reporting 只装
  `query_*` 只读族（query_http_flow/query_risk 等）。注册面清单是宿主装配期的封闭集，
  与批7a 档案同机制。
- **probe 4 对账口径**：注册面随宿主 MCP 配置变化（决策记录 4：缺失即不注册），probe 4 的
  declared 集合**由同一份宿主配置派生**，不写死清单——否则严格集合相等在"少配一个 server"
  时误红，在"多注册一个工具"时漏红。
- **流量与证据挂钩**：Yakit 的 MITM http-flow 库是**操作数据**，TianGong 证据库是**取证权威**，
  两者不混。`evidence_capture` 增 yak 流量引用形态：给 flow id → 经
  `fetch_http_packet_by_id` 取回报文字节入 blob（内容寻址既有管线），snapshot 元数据记
  flow id 供溯源。实测留存因此有确定性的落地路径，而非手工截图。
- **长驻资源生命周期**：`start_mitm_v2` 类调用起的是 yak 侧长驻监听；桥层负责会话结束/abort
  时的清理调用与状态对账（dangling listener 属战役级事故）。
- 验收：yak/mitan stub server（faux MCP）注册 → guard forced ask 对其 scope 外目标生效；
  三角色注册面互不越界；flow id → blob 的取证链路字节级一致；会话 abort 后无遗留监听。

## P2：发现-报告-复测闭环（批9）

当前证据的主体是泛化 `subjectId`（批4 定），finding 只是投影层的 `pending` 节点——没有
findings 表、没有报告版本、没有复测状态机。批9 把它落成数据层：

- **findings 表**（evidence.sqlite 内，与快照同库）：`finding_id, lane, title, severity(rubric
  四级), status(open|verified|retest-pass|retest-fail|wontfix), subject_id, created_at,
  updated_at`。严重度只允许 rubric 四级，写入侧校验（rubric 已在 `sections.ts` RUBRIC 固定，
  数据层与提示层共用同一枚举来源）。
- **版本乐观锁复用**：`evidence_version` 机制逐主体已在，findings 复用同一张版本表，不造第
  二套并发控制。
- **复测闭环**：`traffic_query` 已能按 subject 拉证据；批9 加 `finding_update` 工具（deferred），
  状态迁移合法性在工具层校验（`verified → retest-*` 必须附新证据 snapshotId，即"复测必须留
  新证"是机制不是纪律）。
- **报告**：`report` 文档族（`tg.sec.report`）存报告版本指针；报告生成工具 v1 只做
  "findings 按严重度排序 + 每条附证据 snapshotId 清单"的确定性渲染，**不做 LLM 代写全文**
  （注入面控制：证据文本不进模型上下文，进的是元数据）。实测留存与还原报文分离的既有纪律
  在渲染层继承。**reporting 角色是报告工具的主消费者**（批7a 档案已给它只读取证面）。
- 投影：findings 表变更 → `finding` 帧状态迁移（批6 契约已有 finding 帧与验证状态枚举，
  零契约改动）。
- 验收：finding 从 open → verified → retest-pass 全程落库 + span；retest 迁移无新证据被拒；
  报告渲染确定性（同输入同字节）；rubric 外严重度写入被拒。

## P3：计划、结构化委派与终局判定（批10）

- **`tg.sec.plan` 会话文档族**：主 agent 持计划从"上下文惯例"落成 durable 文档（gibraltar
  defineDocFamily），WebUI 投影 intents 时以它为准（当前 intents 只靠 fork 意图前缀，计划
  修订不可见）。
- **task 结构化返回扩展**：现返回 `{conversationId, status, summary}`（`task-tool.ts:135`），
  批10 加 `findings: string[]`（子会话入账的 findingId 清单）——子会话 evidence_capture 时登记，
  task 收尾读回。主 agent 因此能点名引用子会话发现，不靠 summary 文本捞。
- **赛道终局判定**：三赛道终局（getshell/getflag/high_critical_finding）当前只是提示文本；
  批10 落"终局声明"工具（deferred，每赛道一个声明形状），宿主侧校验声明是否成立（如 CTF 的
  flag 提交记录存在），未成立的声明在投影层标 `unverified`。判定权威留在宿主，不交给模型自评。
- 验收：plan 文档修订可枚举可回放；task 返回 findings 清单与 evidence.sqlite 一致；未验证
  终局声明不改变 finding 状态。

## P4：执行通道与其余工具面（批11+，按战役需求拉动，不提前做）

- **Kali 工具集（本地终端面）**：爆破类（hydra/medusa/ncrack/hashcat/john）、权限维持类、漏洞库
  查询类（searchsploit/CVE 库）等终端工具**默认本地已配置，bash 直跑**（2026-10-27 定调），
  零新增装配——guard 的 bash scope 解析链与危险集已覆盖此面：
  - 爆破类：目标抽取走既有命令文本解析（`hydra ... ssh://host` 的 scheme URL 是强证据；裸
    位置参数 IP 是弱证据 → scope 外照样 forced ask）；超大词表启发式（危险集 D 类，三赛道全
    命中）与 CTF 的 hashcat/john `--wordlist` 规则（D 类赛道条件）对它们是现成护栏。
  - 权限维持类：与危险集 B 类（持久化）高度重合——crontab/authorized_keys/schtasks/systemd
    已强制 ask；经已获取 shell 在目标侧执行的维持命令若回本机 bash 面，同链生效。
  - 漏洞库查询：searchsploit 只读查询放行（无匹配 → allow 的宽松默认）；`-m`/`-x` 写盘动作
    落 workspace 内，不触额外层。
- **双通道收口**：kali-mcp 存在时经批8 桥注册、按角色档案过滤；本地 bash 是保底通道。
  **两条通道必须过同一条 guard 链**——MCP 注册面与 bash 文本解析面都是 beforeTool 的治下，
  不允许出现"MCP 有守卫、本地裸跑无守卫"的缝隙（本地 bash 已在链内，这是白送的，但批11
  验收要钉住它）。
- **可用性探测**：加一个 deferred 的 `local_tool_check` 工具（`command -v` 批量探测 + 版本
  首行），把"本地真实装了什么"喂给模型——防幻觉出未安装工具、也省无效回合。探测结果不进
  span 属性（自由文本），只进工具返回。
- **输出截断**：hydra/searchsploit 等的大输出走既有 `truncate.ts`（2000 行/50KB），重输出
  下放子会话的纪律不变。
- **tg-env 定位**：**主应用场景 = 远端跳板机 SSH 控制**（2026-10-27 澄清）；既有设计定位
  不变（宿主注入的远程 ExecutionEnv、远程目标操作走 SSH 通道，见 sec-agent-design.md「边界
  装配」）。sec-agent 维持不依赖 tg-env（批3 勘误 7），env 由宿主注入。
- **二进制安全工具**：批7a 的 `binary` 角色 + 批8 的 IDA MCP 桥就位后仍有缺口（调试器壳、
  样本哈希入账等）再按战役需求补，形状由需求拉动，不预置。
- **Go sidecar 判断**：数据面已由 Yakit（Go 引擎）承担；仅当 MCP 覆盖不了的缺口实测出现
  （吞吐、协议面）才评估自写 Go sidecar，届时经独立批次评审，不在本批预做。
- **每加一个工具面，probe 4 的 declared 集合同步扩**（sec-agent-design.md 批5-A 勘误 7 的先例）。
- 批11 验收：`local_tool_check` 返回与 `command -v` 实测一致；hydra 对 scope 外目标样本命中
  forced ask（layer=scope）；权限维持样本命中危险集 B 类 forced ask；kali-mcp 注册后与本地
  bash 同链路判定（同一目标两种通道决策一致）。

## 明确不做（防范围蠕变）

- 不做图即控制面（ARTEX 双图）：行动树 + plan 文档已够，图保持投影。
- 不做 memory playbook / 跨会话经验库：无消费者，列为 v2 观察项。
- **角色目录封闭三类，不开放操作者自定义角色**；角色是静态策略档案，不做独立长期运行的
  角色实体，运行时可以枚举的仍只有会话（2026-10-27 拍板的边界）。
- 不动 sec-guard 求值链与四级模式表；ask 规则不产生持久豁免的语义不变。
- 不做 LLM 代写报告全文（见批9）。
- 不做控制面的 Go 改写（决策变更记录 3）。
- judge 不接真实 provider 的批次安排不变（transport 宿主注入）。

## 测试与验收纪律（全批次通用）

- probe before assert：每条新策略带 attestation 探针或既有探针扩展，先红后绿。
- faux provider 全程，零真 token；judge 用 stub。
- 每个新依赖边：AGENTS.md 边界图 + 根 package.json 构建序 + 逐包 package.json/tsconfig
  paths 断言（boundary.test.ts 成真断言，不靠 `check:house-standard`）。
- 新 span 进 `TG_SPAN_SCHEMA` 命名不变量（`tg.span.sec.*`，两段式）；span 属性只放低基数
  封闭枚举，自由文本不进 span。
- 批次顺序：批7 → 批8（MCP 桥）→ 批9；批10 可与批9 并行。每批独立可验：
  `bun run check` + `bun run test packages/sec-agent`（及涉及包）全绿才进下一批。
- MCP 桥测试用 faux MCP server（stub），不连真实 yak/mitan 实例；yak/mitan 参数名 probe 属
  实施期一次性勘察，结果回本文档勘误。

## 房规遵从清单

- 命名：持久 kind `tg.sec.*`；span `tg.span.sec.*`；导出类型 `TgSec*`（sec-guard）/ 各包既有
  前缀；env var `TG_SEC_*`。
- erasable TS、相对导入带 `.ts`、tabs width 3、biome、`verbatimModuleSyntax`。
- commit 格式 `feat(sec-agent|sec-server): ...`；sec-guard 零改动，无其 commit。
- 全部分支开发，不进 v1 freeze。
- `scripts/legacy/**` 只读对照，任何包不得 import。
