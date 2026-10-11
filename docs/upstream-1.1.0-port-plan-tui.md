# 上游 pi 1.0.1 → 1.1.0 移植工程基线（tg-tui）

> 生成于 2026-10-12。上游参照物：`/run/media/J/Workspace/Code-Testing/pi-1.1.0/packages/tui`
> （`@earendil-works/pi-tui` 1.1.0，2026-10-07）。本文件是 `tg-tui` 从上游 1.0.1 升到 1.1.0 的
> **唯一 cherry-pick 与回滚基线**，取代 [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)
> 中 `tg-tui` 段的「推荐」列——至此该审核表三包段落全部被工程基线取代，表本身只剩历史价值。
>
> **一项决策升级（相对审核表）**
>
> 1. **`Terminal.setProgramStatus` + OSC 7501 不再是「决策项」，直接加入**（论证见 T2-1）：审核表的犹豫点
>    是「自研 host 若需状态上报就加入；breaking 意味着所有 Terminal 实现都要补方法」，实测后两点都站不住——
>    仓内**零消费者**（无任何包 import `@OnePanda-TgSec/tg-tui`），实现面只有 `ProcessTerminal` 加 5 个
>    测试 / 基准 helper；运行期按终端应答自动启用，不支持的终端上一个字节都不发。
>
> 每个条目标注四项：**来源版本**（上游 changelog 版本）、**上游类型**（Added / Fixed / Changed /
> Breaking）、**本地落点**（本仓库实测 file:line）、**本地兼容性结论**（是否 breaking、是否触及持久化契约、
> 测试面大小）。本地行号按当前工作区（`V2`，commit `f1e6d64`）实测；上游行号按上述 1.1.0 源码树实测。
>
> 落点分支：**V2**。`v1` 是交付分支且已冻结，本档案任何条目不直接落 `v1`；符合 v1 修复资格的子集在第 7 节
> 单独标注，是否回移植另议。
>
> 与既有两份基线（`upstream-1.1.0-port-plan.md` = tg-ai / tg-agent-core、
> `upstream-1.1.0-port-plan-gibraltar.md` = tg-gibraltar）**零依赖**：tui 是叶子包，不 import 仓内任何包，
> 也不被仓内任何包 import；三份基线可任意顺序或并行执行。

---

## 0. 基线勘误（先读）

审核表 `tg-tui` 段共三行，逐行核对上游 1.1.0 源码树与 changelog 后，有五处口径要修正。先纠正，再看批次。

1. **漏了一项 1.1.0 Fixed：Herdr 超链接检测（#10573）。** 上游 `src/terminal-image.ts:89-93` 新增
   `TERM_PROGRAM=herdr` 分支：Herdr 转发 OSC 8 超链接，但它跑在别的终端里面、内层 pane 会泄漏外层终端的
   环境变量（如 `KITTY_WINDOW_ID`），导致 Herdr 下被误检成 Kitty 图片协议、Markdown 链接不可点。该分支必须
   排在 Kitty 检测**之前**。这是真实缺陷修复，补为 T1-4。
2. **「小组件」一行实际是两个独立条目，且上游零测试覆盖。** `Box.setPaddingX`（#10557）与
   `TuiAltScreen.resetTextSelection`（#10567）是两个 PR、两个互不相关的落点；上游 `test/` 全目录
   grep 不到任何 `setPaddingX` / `resetTextSelection` 用例。移植时这两条**必须自建用例**（房规：改了行为
   就要有断言钉住），且按「先探后断言」实测渲染产物后再写期望。
3. **「Breaking 意味着所有 Terminal 实现都要补方法」高估了本地代价。** `Terminal` 接口的本地实现面实测为
   6 处：`ProcessTerminal`（`src/terminal.ts:137`）+ 测试 / 基准 helper 5 处（`test/virtual-terminal.ts:103`、
   `test/tui-render.test.ts:62`、`test/terminal-colors.test.ts:67`、`test/alt-screen-large-transcript-bench.ts:69`、
   `test/render-churn-bench.ts:59`，各补一行 no-op 即可）。仓内无第三方消费者。
4. **环境变量与标识符的改名噪音必须逐处甄别，不得整文件照抄。** 本地相对上游的自有改名（移植时**以本地为准**，
   上游 diff 里对应行是噪音）：`PI_TUI_*` → `TG_TUI_*`（`terminal.ts:124/152` 的 `TG_TUI_ESC_TIMEOUT` /
   `TG_TUI_WRITE_LOG`、`tui-main-screen.ts:321/324/519/569` 的 `TG_TUI_DEBUG_REDRAW` / `TG_TUI_DEBUG` 与
   `tg-tui-debug.log` / `tg-tui-crash.log` 文件名）、`PI_TRUE_COLOR` / `PI_HYPERLINKS` / `PI_IMAGE_PROTOCOL` →
   `TG_*`（`terminal-image.ts:141/145/152`）、`LAYOUT_NODE` / `VIEWPORT_TUI` 的
   `Symbol.for("@OnePanda-TgSec/tg-tui/...")`（`layout-node.ts:3`、`tui.ts:484`）、
   `native-module-path.ts:6` 的包名。本档案唯一的新增环境变量 `PI_PROGRAM_STATUS` 落地为 **`TG_PROGRAM_STATUS`**
   （T2-1），并须同步 `docs/ops-manual.md:275-278` 的环境变量表。`native/` 的 `PI_NAPI_*` 宏与
   `src/latex.ts` 的裸 LaTeX 名是房规豁免，本档案不触及。
5. **tui 的 1.0.2 与 1.0.4 是空版本。** 上游 changelog 中这两个版本的 tui 段无条目；tui 的全部变更就是
   1.0.3 的键位（#10314）与 1.1.0 的四项。1.0.1 基线（`setImageTranscoder` 等）本地已具备
   （本地 `CHANGELOG.md` 有 `[1.0.1]` 段）。**结论：本包共 5 个条目，无版本线遗漏。**
6. **键位变更的解码层已就位，不要重复移植。** 上游测试改用 `\x1b[7^` / `\x1b[8^`（rxvt legacy 编码的
   Ctrl+Home / Ctrl+End）；本地 `src/keys.ts:454-455` 的 `LEGACY_SEQUENCE_KEY_IDS` 已把它们解码为
   `ctrl+home` / `ctrl+end`，`:418-419` 的 `LEGACY_CTRL_SEQUENCES` 表同样就位。T1-1 只改
   `keybindings.ts` 的默认绑定与测试，**不改 `keys.ts`**。

---

## 1. 执行主线与批次结构

依赖序是唯一执行主线。tui 的 5 个条目两两独立，批次只按「是否 breaking」切分；批次内每条一 commit，
保持回滚单元最小。

| 批次 | 内容 | 性质 | 提交粒度 |
| --- | --- | --- | --- |
| 批次 1 | 非破坏增量：Home/End 键位（#10314）、`Box/Text.setPaddingX`（#10557）、`TuiAltScreen.resetTextSelection`（#10567）、Herdr 检测（#10573） | 上游 Changed / Added / Fixed，**本地均非 Breaking** | 每条一 commit |
| 批次 2 | `Terminal.setProgramStatus` + OSC 7501（#10607） | 上游 **Breaking**，本地 breaking 面仅自身测试 helper | 单独一 commit |

暂缓项：**无**。审核表 `tg-tui` 段没有暂缓行，实测也未发现需要暂缓的条目。

---

## 2. 批次 1：非破坏增量

### T1-1 `Home`/`End` 归属编辑器，`Ctrl+Home/End` 归属转录 — 来源 1.0.3 · Changed（#10314） · 本地非 Breaking

**现状**：`src/keybindings.ts:98-105` 把 `home` / `ctrl+home` 都绑给 `tui.editor.cursorLineStart`
（`end` / `ctrl+end` 同理），`:208-209` 又把 `home` / `end` 绑给 `tui.altScreen.top` / `bottom`。
全屏模式下 alt screen 先吃按键，编辑器的行首 / 行尾永远到不了；这正是 #10314 报的缺陷。

**上游落点**：`keybindings.ts:99-106`（`cursorLineStart` 收窄为 `["home", "ctrl+a"]`、`cursorLineEnd`
为 `["end", "ctrl+e"]`）与 `:208-209`（`altScreen.top` / `bottom` 改 `ctrl+home` / `ctrl+end`）。

**变更规格**：本地 `src/keybindings.ts` 四行默认键位照抄上游；类型表（`:17-18`、`:57-58`）不动。
用户已自定义的键位不受影响（`Keybindings` 的覆盖机制不变）。

**测试**（上游现成，移植优先）：
- `test/keybindings.test.ts:17-18` / `:45-46` 四条断言更新；
- `test/tui-alt-screen.test.ts:556` 「page overlap」用例的输入 `\x1bOH` / `\x1bOF`（`:579` / `:586`）
  改为 `\x1b[7^` / `\x1b[8^`；
- `test/tui-alt-screen.test.ts:901` 路由用例整体重写为上游版「routes Home and End to the focused
  component and Ctrl+Home/End to the transcript」：未修饰 Home/End（`\x1bOH`、`\x1b[F`、`\x1b[57423u`、
  `\x1b[5;5~`、`\x1b[6;5~`）全部到达编辑器且转录不动，`ctrl+home` / `ctrl+end`（`\x1b[1;5H` /
  `\x1b[1;5F`）滚转录、`\x1b[57423;5u` 回顶部，最后 `editorInputs` 恰为前五键——上游带 `#10314` 注释。

**回滚**：自身。

### T1-2 `Box.setPaddingX` / `Text.setPaddingX` — 来源 1.1.0 · Added（#10557） · 本地非 Breaking

**现状**：`src/components/box.ts:16` 与 `src/components/text.ts:9` 的 `paddingX` 都是构造后不可变的私有
字段；宿主运行期改内边距只能重建组件（丢渲染缓存与子树状态）。

**上游落点**：`components/box.ts:53-56`（`setPaddingX` 置字段后 `invalidateCache()`）与
`components/text.ts:39-43`（同构，`invalidate()`）。

**变更规格**：两个 setter 照抄；`Box` 的 `bgFn` 采样语义（`:50` 注释）不变。

**测试**：**上游零覆盖**（见勘误 2），自建一条用例（建议落 `test/tui-render.test.ts`）：构造
`Text` / `Box` 渲染一帧 → `setPaddingX(N)` 改变缩进 → 再渲染断言行首空格数与内容宽度按新 padding 变化，
且未改 padding 的组件不受影响。断言值**先探后写**。

**回滚**：自身。

### T1-3 `TuiAltScreen.resetTextSelection` — 来源 1.1.0 · Added（#10567 / #9311） · 本地非 Breaking

**现状**：`src/tui-alt-screen.ts:883` 的 `clearTextSelection()` 是私有方法；`:222` 的 `lastClick`
多击历史同样无法从外部复位。宿主整体替换转录内容后，旧选择的起止坐标会落在新文本上（选中错误片段），
残留的多击历史还会把下一次单击误判为双击 / 三击的第二击。

**上游落点**：`tui-alt-screen.ts:316-321` 新公开方法 `resetTextSelection()`：调 `clearTextSelection()`
并置 `lastClick = undefined`，doc 注释点名「before the host replaces the transcript」。

**变更规格**：照抄（含注释）。`clearTextSelection` 保持私有。

**测试**：**上游零覆盖**（见勘误 2），自建一条用例（建议落 `test/tui-alt-screen.test.ts`）：
渲染多行文本 → 模拟拖选建立 selection（复用该文件既有的鼠标事件构造方式）→ `resetTextSelection()` →
断言后续同位置单击按**单击**处理（不再升多击），且再拖选一次 selection 从零开始。断言值**先探后写**
（探 `lastClick` 升击的真实判定路径，不得按方法名臆断）。

**回滚**：自身。

### T1-4 Herdr 超链接检测 — 来源 1.1.0 · Fixed（#10573） · 本地非 Breaking

**现状**：`src/terminal-image.ts:86-89` 无 `herdr` 分支，`TERM_PROGRAM=herdr` + 泄漏的
`KITTY_WINDOW_ID` 会落到 Kitty 检测上，Markdown 链接不可点、图片协议误启用。

**上游落点**：`terminal-image.ts:89-93`，`herdr` 分支排在 `KITTY_WINDOW_ID` 检测**之前**，返回
`{ images: null, trueColor: hasTrueColorHint, hyperlinks: true }`，带 Herdr 变量泄漏的注释。

**变更规格**：照抄（分支顺序是修复本体，不得排到 Kitty 之后）。

**测试**：移植上游 `test/terminal-image.test.ts` 的 `#10573` 用例：`withEnv({ TERM_PROGRAM: "herdr",
TERM: "xterm-256color", COLORTERM: "truecolor", KITTY_WINDOW_ID: "1" })` 下断言 `hyperlinks === true`、
`images === null`、`trueColor === true`。注意上游同文件其余 diff 行是 `.pi/agent` 路径噪音，
本地保持 `.config/TianGong` 不动（见勘误 4 的甄别原则）。

**回滚**：自身。

---

## 3. 批次 2：OSC 7501 Program Status

### T2-1 `Terminal.setProgramStatus` + `formatProgramStatus` — 来源 1.1.0 · Breaking（#10607） · 本地 breaking 面仅自身

**现状**：本地无任何程序状态上报。`src/terminal.ts:14` 的
`KITTY_KEYBOARD_PROTOCOL_QUERY = "\x1b[>7u\x1b[?u\x1b[c"` 把 kitty 协商与 DA1 探测合并在一个常量里。

**上游落点**：
- **新文件 `src/program-status.ts`（53 行）**：`ProgramStatus` 类型（`state: "idle" | "working" |
  "blocked" | "done" | "error" | "clear"`，可选 `app` / `kind` / `message`）、
  `PROGRAM_STATUS_QUERY = "\x1b]7501;?\x1b\\"`、`isProgramStatusReply()`（容两种终止符与未来键值对）、
  `formatProgramStatus()`（`app` 须匹配 `[A-Za-z0-9_.+-]{1,32}` 否则整个省略；`kind` 仅 `blocked` 态输出；
  `message` 控制字符替换为空格、trim、按 **2048 UTF-8 字节**（base64 后仍在 2732 字节限内）在码点边界
  截断再 base64）。
- `terminal.ts`：接口加 `setProgramStatus(status: ProgramStatus): void`（上游 `:117-123`，带「只在支持
  的终端上发；支持确认或终端重启后补发最新状态」的注释）；`ProcessTerminal` 三个私有字段
  （`programStatus` / `programStatusSupported` / `programStatusQueryPending`，上游 `:164-167`）；
  stdin data handler 顶部识别 OSC 7501 回显（`:239-246`：pending 时置 supported 并立即补发，回显不进
  输入流）；`queryAndEnableKittyProtocol()`（`:284-297`）把查询拆为
  `KITTY_KEYBOARD_PROTOCOL_QUERY = "\x1b[>7u\x1b[?u"` + `DEVICE_ATTRIBUTES_QUERY = "\x1b[c"`，中间按
  `PI_PROGRAM_STATUS`（本地 **`TG_PROGRAM_STATUS`**）决定是否插 `PROGRAM_STATUS_QUERY`，`"1"` 视为已支持、
  `"0"` 彻底关闭、未设则发查询并置 pending；DA1 处理（`:306-312`）在**最后一个**欠账 DA 到达时关闭
  pending（早于重启的 DA 不得误关新查询）；`stop()`（`:471-477`）在支持时发 `state=clear` 并复位
  supported / pending（`start()` 后重报）；`setProgramStatus` / `writeProgramStatus`（`:576-586`，
  `clear` 态清掉记住的最新状态）。
- `index.ts:114-115` 导出 `formatProgramStatus` 与 `ProgramStatus`。

**决策论证（相对审核表「决策项」的升级）**：审核表的犹豫是「自研 host 若需状态上报就加入」。实测后
**加入**的理由有三：① 运行期按终端应答自动启用，`TG_PROGRAM_STATUS=0` 可整体关闭，不支持的终端零字节
开销，不是「用不上就得背着」的能力；② 本地 breaking 面只有 6 处（勘误 3），全部在本包内；③ 协议查询
搭 kitty 协商的 DA1 哨兵便车，不增加额外的探测往返。不加入的唯一理由是「暂不需要」，但库包保持与上游
的接口对齐本身就是收益（上游 1.1.0 起 `Terminal` 实现方的公开契约）。

**变更规格**：
1. `cp` 上游 `program-status.ts`，`chmod 644`（上游可能带 755）；零改名（该文件无 `PI_*` 标识符）。
2. `terminal.ts` 按上游逐段落；所有 `PI_PROGRAM_STATUS` 写成 `TG_PROGRAM_STATUS`（勘误 4）。
3. `index.ts` 导出照抄。
4. 6 处 `Terminal` 实现补方法：`ProcessTerminal` 落真实现；5 个测试 / 基准 helper 各补一行
   `setProgramStatus(): void {}`。

**测试**（上游现成，全部移植）：
- **新文件 `test/program-status.test.ts`（5 用例）**：四键编码 / `kind` 与非法 `app` 与空 `message` 的省略 /
  控制字符替换 / 长 `message` 的 UTF-8 边界截断 / 回显匹配容两种终止符与后续键值对。
- `test/terminal.test.ts:135` 协商首写断言改为
  `"\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c"`；新增 `describe("program status (OSC 7501)")` 5 用例：
  终端在 DA 前应答查询才上报（补发恰一次）、DA 先到则不再上报并吞掉迟到回显、`TG_PROGRAM_STATUS` 为
  `"1"` / `"0"` 时跳过查询、重启前的 DA 不得结束新查询、`stop()` 发 `clear` 且 `start()` 后重报。
  上游 `withOverride` 助手的 env 操作同步改 `TG_PROGRAM_STATUS`。
- OSC 7501 的全部转义序列**逐字节照上游断言**，不自造。

**回滚**：自身；revert 时 `program-status.ts` 整文件与 `index.ts` 导出一并退，5 个 helper 的 no-op
可留（无害）也可同退。

---

## 4. Cherry-pick 序（唯一基线）

提交顺序即下表。commit message 依房规
`{feat,fix,docs,refactor,chore}[(ai,tui,agent,gibraltar,chord,telemetry,mcp,codemode)]: <message>`。
每个 commit 落地前须通过 `bun run check` 与 `bun run test packages/tui`（见第 8 节）。

| # | Commit message | 条目 | 依赖 |
| --- | --- | --- | --- |
| 1 | `fix(tui): keep home and end on the editor line` | T1-1 | — |
| 2 | `feat(tui): add setPaddingX to box and text` | T1-2 | — |
| 3 | `feat(tui): add resetTextSelection to the alt screen` | T1-3 | — |
| 4 | `fix(tui): detect herdr as hyperlink-capable without images` | T1-4 | — |
| 5 | `feat(tui): report program status over OSC 7501` | T2-1 | — |

说明：

- 五条两两独立，顺序仅为「非破坏在前、breaking 收尾」的阅读序；批次 1 内部四条可任意调换。
- T1-1 与 T1-3 都改 `test/tui-alt-screen.test.ts`，但用例不同段，无冲突；仍按一条一 commit 保持
  回滚单元最小。
- 每 commit 附带 `packages/tui/CHANGELOG.md` `[Unreleased]` 条目；**#5 须同 commit 更新
  `docs/ops-manual.md:275-278` 的环境变量表**（新增 `TG_PROGRAM_STATUS`，见第 8 节第 9 条）。

---

## 5. 回滚矩阵

| 条目 | revert 单元 | 耦合与注意事项 |
| --- | --- | --- |
| T1-1 键位 | 自身 | 与 T1-3 同测试文件不同用例，无冲突；revert 后回到「Home/End 全屏滚转录」的修复前行为 |
| T1-2 `setPaddingX` | 自身 | 无耦合 |
| T1-3 `resetTextSelection` | 自身 | 无耦合 |
| T1-4 Herdr | 自身 | 无耦合 |
| T2-1 setProgramStatus | 自身 | `program-status.ts` 整文件 + `index.ts` 导出 + 手册环境变量行一并退；helper 的 no-op 可留 |

回滚验证：每次 revert 后跑 `bun run check` + `bun run test packages/tui`。

---

## 6. 兼容性结论汇总表

| 条目 | 上游版本 | 上游类型 | 本地 Breaking | 持久化 / 存储影响 | 测试面 | v1 修复资格 |
| --- | --- | --- | --- | --- | --- | --- |
| T1-1 Home/End 键位（#10314） | 1.0.3 | Changed | 否（默认键位变更，可被用户覆盖） | 无 | 上游断言更新 ×4 + 路由用例重写 + page overlap 输入更新 | 可有（交互缺陷） |
| T1-2 `setPaddingX`（#10557） | 1.1.0 | Added | 否 | 无 | **自建**（上游零覆盖） | 无（新能力） |
| T1-3 `resetTextSelection`（#10567） | 1.1.0 | Added | 否 | 无 | **自建**（上游零覆盖） | 无（新能力） |
| T1-4 Herdr 检测（#10573） | 1.1.0 | Fixed | 否 | 无 | 移植上游 `#10573` 用例 | **有**（真实缺陷） |
| T2-1 `setProgramStatus`（#10607） | 1.1.0 | **Breaking** | **是**（`Terminal` 实现方；本地仅 6 处） | 无 | 新文件 `program-status.test.ts`（5 用例）+ `terminal.test.ts` 协商断言与 5 用例 | 无（新能力） |

**零持久化影响**：tui 不落任何存储；无 `tg.*` kind、无 schema、无环境面（仅 `TG_PROGRAM_STATUS`
一个新增环境变量，进手册表）。

---

## 7. v1 回移植子集

`v1` 冻结规则下，本档案唯一有 v1 修复资格的是 **T1-4（#10573，数据 / 行为正确性缺陷）**。T1-1 是键位
重排（行为变更，非缺陷修复，v1 上应保持既有键位）；T1-2 / T1-3 / T2-1 是新能力。是否把 T1-4 回移植
`v1` 另议；`packages/tui/native/` 在本档案全部条目中零改动，不触及 v1 的 native 禁区。

---

## 8. 验证协议（每 commit 强制）

1. `bun run check`（house standard + 格式 + 类型 + 相对导入）。
2. `bun run test packages/tui`。**注意 tui 的 runner 是 `node:test` 不是 Vitest**；从包根跑单文件用
   `bun run test -- test/xxx.test.ts`。
3. **禁止** `bun test`（会绕过各包的 runner 配置）。
4. **先探后断言**：T1-2 / T1-3 的自建用例尤其如此——渲染产物行首空格数、多击升击的真实判定路径，必须先
   用临时探针（`/tmp/opencode`，跑完即删）对真实模块实测再写期望；OSC 7501 的转义序列逐字节照上游断言，
   不得自造；`console.log` 探针不得随 commit 提交。
5. 修复类条目（T1-1、T1-4）的回归测试须**修复前失败、修复后通过**（T1-1 的路由用例在修复前 Home 到不了
   编辑器；T1-4 的 Herdr 用例在修复前 `images === "kitty"`）。
6. 房规标识符甄别（勘误 4）逐条自查：落地的 diff 里**不得出现** `PI_TUI_*`、`PI_PROGRAM_STATUS`、
   `PI_TRUE_COLOR` 等 `PI_*` 环境变量，也不得把本地 `Symbol.for("@OnePanda-TgSec/tg-tui/...")`、
   `native-module-path.ts` 包名、`tg-tui-*.log` 文件名「改回」上游拼法。
7. Changelog：`packages/tui/CHANGELOG.md` `[Unreleased]`，按序并入 `Breaking Changes` / `Added` /
   `Changed` / `Fixed`；`Terminal` 接口签名变更（T2-1）进 `Breaking Changes`，并在条目里写明
   「无 OSC 7501 支持的终端可实现为 no-op」与 `TG_PROGRAM_STATUS` 覆写。
8. 行为手册：**T2-1 须在同 commit 更新 `docs/ops-manual.md:275-278` 的环境变量表**（`TG_PROGRAM_STATUS`：
   `1` / `0` 覆写 OSC 7501 探测）。其余条目不触及手册已描述的行为（键位默认值不在手册范围）。
9. Git：显式路径 staging，禁 `git add -A`；只提交本会话改动；`git status` 核对后再提交。

---

## 9. 与既有文档的关系

- [`upstream-1.1.0-port-review.md`](upstream-1.1.0-port-review.md)：调研来源；其 `tg-tui` 段的「推荐」列
  已被本基线取代（含 `setProgramStatus` 决策升级）。至此该表三包段落全部被工程基线取代，仅余历史价值。
- [`upstream-1.1.0-port-plan.md`](upstream-1.1.0-port-plan.md)：`tg-ai` / `tg-agent-core` 基线；与本档案
  零依赖。
- [`upstream-1.1.0-port-plan-gibraltar.md`](upstream-1.1.0-port-plan-gibraltar.md)：`tg-gibraltar` 基线
  （已执行完毕，`6d6082e`..`9c73155`）；与本档案零依赖。
- [`ops-manual.md`](ops-manual.md)：环境变量表在 T2-1 同 commit 增补；其余行为不受本档案影响。
- [`provenance.md`](provenance.md)：`tg-tui` 的上游来源与采纳版本（house 改名层），本档案不改变其描述。
