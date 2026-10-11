# 上游 pi 1.1.0 移植审核表

> 生成于 2026-10-10。基线：TianGong 现有模块全部源自上游 pi agent **1.0.1**（2026-10-03），
> 本表覆盖上游 **1.0.2 → 1.1.0** 增量。数据来源：上游各包 `CHANGELOG.md` 提取 + `pi-1.1.0`
> 源码树逐包核对。配套文档见 [`provenance.md`](provenance.md)。
>
> 状态：**tg-ai / tg-agent-core / tg-gibraltar 三包已被工程基线取代（2026-10-11）**。前两包的批次划分、
> cherry-pick 顺序与回滚矩阵以 [`upstream-1.1.0-port-plan.md`](upstream-1.1.0-port-plan.md) 为准；
> `tg-gibraltar` 以 [`upstream-1.1.0-port-plan-gibraltar.md`](upstream-1.1.0-port-plan-gibraltar.md) 为准，
> 其中两行相对本表升级为决策：`createPowerShellTool` **不暂缓**（该基线 B3-5）、查询 `order`/`ScanOrder`
> **加入**以支持「最新任务优先」分页（该基线 B2-1）；另勘误一处：本表第 64 行「需叠加一版迁移」不成立，
> 上游 1.1.0 未新增任何 SQLite 列。`tg-tui` 各行仍以本表为待审依据，表内「推荐」一栏是建议而非定论，
> 逐条过审时可直接改写。
> 勘误：表 1 第 38 行的 `AssistantMessageEventStream` 强制类型已随 V1 导入落地，不再是待移植项；
> 第 94 行的两处 breaking 相应只剩 `Terminal.setProgramStatus` 一处。

## 批次建议

| 批次 | 内容 | 风险 |
| --- | --- | --- |
| 批次 1 | 修复类与低风险新增：`tg-ai` 修复集、`tg-agent-core` 计时、`tg-gibraltar` env 扩能修复 / 上下文缓存 / system 消息排序 / session UUID / `ToolExecutionApi.models` / `startedAt`·`endedAt`、`tg-tui` 小组件 | 低 |
| 批次 2 | 需拍板的 breaking：`AssistantMessageEventStream` 强制类型（tg-ai + agent）、`Terminal.setProgramStatus`（tui）、`Storage.order`/`ScanOrder` 与 `TaskRuntime.context()` 签名（gibraltar） | 中（需适配所有实现/调用点） |
| 批次 3 | 暂缓项：`azure` 改名、Foundry Chat Completions、`openai-decisions` 分类器、`openDurableObjectSqliteStorage`、`createPowerShellTool`、Bedrock 专项修复、未迁移包 | 视需求触发 |

---

## 表 1：现有模块 × 上游 1.1.0 新内容对照

`chord`、`tg-telemetry`：上游 1.0.1 → 1.1.0 **无变化**（已逐字节核实），无需动作。

### `pi-codemode` / `pi-mcp`（vendored）——已升级 ✅

| 上游版本 | 变更 | 说明 |
| --- | --- | --- |
| 1.1.0 | codemode：`console: true` 输出标记；1.0.4 冻结内建对象、防原型投毒 | 已随 re-sync 落地 |
| 1.1.0 | mcp：OAuth 函数 `signal` 取消；`close()` 复用上次 token 不再触发刷新 | 已落地 |

### `tg-ai`

| 上游版本 | 变更 | 类型 | 推荐 | 理由 |
| --- | --- | --- | --- | --- |
| 1.0.2 | `samplingParamsByThinkingLevel`（按思考等级覆盖采样参数） | Added | **加入** | 思考等级是模型运行时常用控制；可选参数、改动小、不 breaking |
| 1.0.3 | **Breaking**：Azure provider 改名 `azure-openai-responses`→`azure` + Foundry Chat Completions | Breaking | **暂缓** | TianGong 未见 Azure 场景；需要 Azure 时再连改名一起做，否则白付 breaking 成本 |
| 1.0.3 | OAuth token 刷新竞态修复（取消/刷新时凭据被废） | Fixed | **加入** | 真实 bug，影响所有 OAuth 登录（ChatGPT 等），修的是凭据生命周期 |
| 1.0.4 | Bedrock HTTP/2 断流自动重试 | Fixed | 暂缓 | TianGong 未用 Bedrock；启用 Bedrock 再加入 |
| 1.1.0 | **Breaking**：stream 函数必须返回 `AssistantMessageEventStream`；`AssistantMessage`/`ToolResultMessage` 增加 `durationMs`（单调时钟计时） | Breaking/Added | **加入（需决策）** | `durationMs` 与 telemetry span、`tg-gibraltar` 用量聚合天然互补，链路价值高；但 breaking，所有 stream 实现需适配 |
| 1.1.0 | Claude Haiku 5.5（adaptive thinking、prompt 定价层） | Added | **加入** | 模型目录跟进，走 `generate:models` 流程 |
| 1.1.0 | `LoginOptions.agentName` | Added | **加入** | 一行改动，登录显示品牌化 |
| 1.1.0 | `openai-decisions` 分类器 API、`ClassifierContext.images` | Added | 暂缓 | 新能力非必需，等有内容分类需求再上 |
| 1.1.0 | 修复：`server_busy`/容量错误误终止 turn（#10543）、context 估算 3.5 字符/token（#10497）、Mistral `finish_reason:error` 重试（#10487）、Radius catalog 覆盖而非合并、多家 provider 的 prompt 长度定价层 | Fixed | **加入** | 「不该终止却终止 / 算错钱」类真实缺陷，与 TianGong provider 生态直接相关 |

### `tg-agent-core`

| 上游版本 | 变更 | 类型 | 推荐 | 理由 |
| --- | --- | --- | --- | --- |
| 1.1.0 | tool result / `AgentToolCallOutcome` / `tool_execution_end` 增加 `durationMs`；`streamProxy()` 返回 `AssistantMessageEventStream` | Added/Breaking | **随 tg-ai 一起加入** | 与 tg-ai 的 `durationMs` 是一条链，缺一环数据就断；与本地 `permission.ts`/`telemetry.ts` 不冲突（不同切面） |

### `tg-gibraltar`

| 上游版本 | 变更 | 类型 | 推荐 | 理由 |
| --- | --- | --- | --- | --- |
| 1.0.2 | 每会话持久化 provider session UUID（prompt-cache/session 亲和） | Fixed | **加入** | 小改动，直接减少缓存失效 |
| 1.0.3 | env 能力扩能：`FileSystem.openBinaryReader/openDirReader/watch()`、`BinaryReader.scanLines()`、`Shell.exec(argv)`、`settings.progress`、`ShellExecOptions.window` | Breaking/Added | **加入** | `read`/`bash` 工具增量读、输出窗口的能力与正确性升级；TianGong 当前无这些文件（纯新增、无冲突），SQLite/删除导出备份等本地改动不受影响 |
| 1.0.4 | watch 权限/符号链接修复、BOM 修复；`createPowerShellTool` | Fixed/Added | **修复加入；PowerShell 暂缓** | 修复类直接受益；pwsh 工具对 Linux 主线非重点 |
| 1.1.0 | **Breaking**：查询 `order`/`ScanOrder`、cursor 续页方向；`TaskRuntime.context()` 改 options 签名 | Breaking | 决策 | 若需要「最新任务优先」分页就加；否则等真正需要时再做 breaking |
| 1.1.0 | `Conversation.context(context,{at})` | Added | 加入 | 新能力（查看历史时点上下文），改动小 |
| 1.1.0 | `ToolExecutionApi.models` / `HookApi.models`（工具/钩子用同一 catalog 调模型） | Added | **加入** | 对后续工具生态有直接价值 |
| 1.1.0 | 任务 `startedAt`/`endedAt` | Added | **加入** | 与 `durationMs` 计时口径一致；本地已有 schema v3，需叠加一版迁移 |
| 1.1.0 | `settings.contextRetentionMs` + `runtime.context()` 内存缓存（每请求不再重读全量 transcript） | Changed | **加入** | 性能优化，会话越长收益越大 |
| 1.1.0 | 首条 system 消息/baseline 排序修复（#10542，保住 Anthropic prompt cache） | Fixed | **加入** | 真实缺陷，影响缓存命中率 |
| 1.1.0 | `openDurableObjectSqliteStorage`（Cloudflare Durable Object） | Added | 暂缓 | TianGong 未部署 CF |

### `tg-tui`

| 上游版本 | 变更 | 类型 | 推荐 | 理由 |
| --- | --- | --- | --- | --- |
| 1.0.3 | `Home/End` 改为编辑器行首/行尾，`Ctrl+Home/End` 负责全文 | Changed | 加入 | 键位修正，改动小 |
| 1.1.0 | **Breaking**：`Terminal.setProgramStatus` + OSC 7501 Program Status | Breaking | **决策** | 自研 host 若需状态上报就加入；breaking 意味着所有 Terminal 实现都要补方法 |
| 1.1.0 | `Box/Text.setPaddingX`、`TuiAltScreen.resetTextSelection` | Added | **加入** | 小组件特性，直接用得上 |

---

## 表 2：未迁移包的需求度评估

前提：TianGong 定位是**技术栈**（自研 harness + 自有 telemetry / 权限模型 / SQLite 存储，Bun-only），
而非现成 CLI 成品。未迁移包指上游 1.1.0 中存在、TianGong 明确不携带的包。

| 上游包 | 规模（src/test 文件数） | 需求度 | 理由 | 建议 |
| --- | --- | --- | --- | --- |
| `pi-coding-agent` | 312 / 356 | **中（作参考）／低（作移植）** | 它就是 TianGong 要做的那类 agent 成品；整包移植等于给巨型 app 改名，且依赖 protocol/client。但它是最佳参考实现：扩展系统、skills、slash 命令、read/bash/edit 工具、session 管理都值得抄设计 | 不 vendored；需要某子系统（如扩展加载器）时单独评估 |
| `pi-protocol` | 8 / 3 | **低** | CBOR 会话协议，仅在做远程会话/多进程架构时才需要；TianGong 目前是本地 SQLite 单进程 | 暂缓 |
| `pi-client` | 8 / 5 | **低** | 依赖 protocol，同上 | 暂缓 |
| `pi-server` | 16 / 7（实验性） | **低** | 上游自己标注 experimental，且故事依赖 env | 暂缓 |
| `pi-env` | 6 / 6 | **低（包）／中（接口）** | 包本身（SSH 远程执行环境 daemon+client）仅在「远程机器跑工具/会话」时有意义；本地开发无用。但 `tg-gibraltar` 1.0.3+ 的 env **接口扩能**与它配套——包可以不上，接口建议跟（见表 1） | 包暂缓；接口扩能加入 |
| `pi-evals` | 5 / 6 | **低** | 模型/工具质量评估 harness，仅在建评测体系时需要 | 暂缓，必要时自建 |

---

## 备注

- 表 1 中标注「加入」的条目如需落地，按依赖序 `tg-ai → tg-agent-core → tg-gibraltar → tg-tui` 逐包 cherry-pick 并重新套用 tg 命名；两包以上共用同一处改动时以 tg-ai 为先。
- 两处 breaking（`AssistantMessageEventStream`、`Terminal.setProgramStatus`）建议在各自批次内单独成 commit，便于回滚。
- vendored 包（codemode/mcp）已随 1.1.0 re-sync 完成，不在本表审核范围；重同步流程见 `provenance.md`。
