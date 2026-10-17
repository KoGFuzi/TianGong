# 上游 pi 1.1.0 → 1.2.0 移植工程基线（tg-tui）

> 生成于 2026-10-17。上游参照物：本仓同步用的上游源码树（Windows 侧 `F:/Code-Testing/pi-1.3.0`，
> 已拷贝到 Fedora `/tmp/pi-130/packages/tui`；`@earendil-works/pi-tui` 1.2.0 为最后改动版本，
> 1.3.0 上游零改动）。本文件是 `tg-tui` 从上游 1.1.0 升到 1.2.0 的**唯一落点基线**。
> 上游 tui 在 1.3.0 无任何条目，故本包差距 = 1.2.0 单版本。
>
> 落点分支：**V2**。`v1` 冻结不落。
>
> **命名规则（最高约束）**：把上游逻辑**翻译进**房规命名——`PI_TUI_*` → `TG_TUI_*`、
> `PI_TRUE_COLOR`/`PI_HYPERLINKS`/`PI_IMAGE_PROTOCOL` → `TG_*`、`PI_PROGRAM_STATUS` → `TG_PROGRAM_STATUS`、
> `Symbol.for("@earendil-works/pi-tui/...")` → `Symbol.for("@OnePanda-TgSec/tg-tui/...")`、
> 包名/导入 specifier → `@OnePanda-TgSec/tg-tui`。**`packages/tui/native/`（C/Obj-C 插件与预编译产物）
> 完全不动**——native 层的 `PI_NAPI_*`/`PI_CLIPBOARD_*` 宏是豁免项（见 `docs/provenance.md`）。
>
> **保护清单（本仓自有特性，不得回退）**：`docs/upstream-1.1.0-port-plan-tui.md` 落地的
> `Box.setPaddingX`/`Text.setPaddingX`（#10557）、`TuiAltScreen.resetTextSelection`（#10567）、
> `Terminal.setProgramStatus`+OSC 7501（#10607，`TG_PROGRAM_STATUS`）、Herdr 超链接检测（#10573，
> 1.2.0 的 T1-1 会在同一处**改判定**——两者不冲突：超链接检测与图片协议检测是两处逻辑）、
> Home/End 归属编辑器（#10314）、本仓自有测试 `test/component-padding.test.ts`。

---

## 0. 对账基线（先读）

上游 1.2.0 tui（不含 native/、dist/）与本仓 `packages/tui` 逐文件 sha256 对账（2026-10-17 实测）：

- **69 个文件哈希一致**（无命名差异的工具与测试文件）。
- **上游零新增文件**：1.2.0 的全部改动落在既有文件内。
- 本仓独有：`test/component-padding.test.ts`（1.1.0 移植期自建，保护）。
- **差异面**：14 个 src 文件 + 16 个测试文件。其中 `layout-node.ts`、`native-module-path.ts`、
  `terminal.ts`、`package.json` 的差异含房规命名成分，**禁止整文件覆盖**，逐段移植。

## 1. 批次结构（唯一 cherry-pick 序）

### 批次 T1：非 Breaking 修复（先行）

| # | 条目（来源版本） | 上游落点 | 本仓落点与要点 |
| --- | --- | --- | --- |
| T1-1 | Herdr 内联图片改走 Kitty 图形协议，修复 1.1.0 起 Herdr 图片不渲染（1.2.0 #10774） | `src/terminal-image.ts` + `test/terminal-image.test.ts` | 注意与本地 Herdr 超链接检测（#10573）的先后关系：上游 1.2.0 把 Herdr 重新纳入图片协议能力集，本地 #10573 只是**超链接检测**不把它当 Kitty——两处判定语义不同，逐段读上游后合并，勿简单覆盖 |
| T1-2 | 碎片化的终端颜色应答不再泄漏 hex 进 prompt、不再触发外部编辑器（1.2.0 #10256/#10657） | `src/stdin-buffer.ts` + `src/terminal.ts` + 对应测试（`stdin-buffer.test.ts`、`terminal-colors.test.ts`、`terminal.test.ts`） | 颜色应答解析与 BEL 终结符处理；`terminal.ts` 含房规 `TG_TUI_*` 改名，逐段移植 |
| T1-3 | 聚焦的全屏 overlay 不再吞滚轮：无组件处理的 wheel 事件改滚转录；自行滚动的 overlay 须实现 `handleMouse`（1.2.0 #10769） | `src/tui-alt-screen.ts` / `src/tui.ts` + `test/tui-alt-screen.test.ts` | 检查本仓 alt-screen 自有组件（含 resetTextSelection）的 wheel 处理面 |
| T1-4 | 键绑定命名 shifted symbol（`+`、`ctrl++`）在 Kitty keyboard / modifyOtherKeys 上报 `Shift+未移位键` 时可匹配；`parseKey()` 返回产出的符号（`+` 而非 `shift+=`）（1.2.0 #9880） | `src/keys.ts` + `test/keys.test.ts` | 纯解析逻辑，无命名成分，可较大幅度对齐上游 |

### 批次 T2：cursor APC 标记（Breaking，后行）

| # | 条目（来源版本） | 上游落点 | 本仓落点与要点 |
| --- | --- | --- | --- |
| T2-1 | **Breaking**：`Editor.render()`/`Input.render()` 把绘制的光标包进零宽 APC 标记（不再直接发 `\x1b[7m`）；TUI 渲染器解析标记；TUI 外渲染这两个组件必须自行 `stripTerminalSequences()`（1.2.0） | `src/components/editor.ts`、`src/components/input.ts`、`src/utils.ts`（`renderFakeCursor`/`CURSOR_MARKER`）、`src/tui-main-screen.ts`（标记解析）、`src/terminal.ts`（`showHardwareCursor`）、`src/index.ts`（导出）、对应测试（`editor.test.ts`、`tui-render.test.ts`、`terminal.test.ts`、bench helpers） | 本仓 `Terminal` 实现面 6 处（`ProcessTerminal` + 5 个测试/基准 helper），按 1.1.0 计划实测清单逐一补方法；仓内零消费者（无包 import tg-tui），breaking 面仅自身 |
| T2-2 | `showHardwareCursor` 改为只显示终端光标：聚焦的 Editor/Input 不再画反色光标，避免终端把边缘单元格颜色扩展到窗口 padding 拉长光标（1.2.0） | 与 T2-1 同批 | 行为变更随 T2-1 落地，测试断言更新 |
| T2-3 | overlay 合成不再丢 `CURSOR_MARKER`：overlay 直接终止于光标左侧时硬件光标位置不丢（1.2.0） | `src/tui-alt-screen.ts` / `src/tui-main-screen.ts` 合成路径 | 依赖 T2-1 的标记常量，故排后 |

## 2. 验证协议（每批次 commit 前强制）

1. `bun run check` 全绿。
2. `packages/tui` 下 Node 跑 node:test：
   `PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH" node --test --test-reporter=dot --test-reporter-destination=stdout test/*.test.ts`
   全绿（含 native 相关测试按平台 skip）。
3. 保护清单回归自查：`component-padding.test.ts`、`program-status.test.ts` 必须保持绿。
4. 每批次一个 commit：`feat(tui)/fix(tui): ...`，正文注明上游条目与 issue 号。

## 3. 回滚矩阵

T1 四条互相独立，可单独 revert；T2 三条同批落地（标记常量共享），回滚以 T2 整体 commit 为单位。
