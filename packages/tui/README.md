# @OnePanda-TgSec/tg-tui

极简终端 UI 框架：差分渲染 + 同步输出，为交互式 CLI 应用带来无闪烁体验。

## 特性

- **可互换的渲染器**：共享 `TUI` 接口，主屏（main-screen）与备用屏（alternate-screen）两种实现
- **差分渲染**：只更新变化的行或视口行
- **应用自有的滚动**：备用屏视口支持鼠标、触控板与键盘导航
- **同步输出**：使用 CSI 2026 实现原子化屏幕更新（无闪烁）
- **括号粘贴模式**：正确处理大段粘贴，超过 10 行生成标记
- **组件化**：简单的 Component 接口，只需实现 render() 方法
- **主题支持**：组件接受主题接口，样式可自定义
- **内置组件**：Text、TruncatedText、Input、Editor、Markdown、Loader、SelectList、SettingsList、MouseRegion、Spacer、Image、Box、Container、VStack、HStack、ScrollView
- **行内图片**：在支持 Kitty 或 iTerm2 图形协议的终端中渲染图片
- **自动补全**：文件路径与斜杠命令

## 快速开始

```typescript
import { type TUI, Text, Editor, ProcessTerminal, TuiMainScreen, matchesKey } from "@OnePanda-TgSec/tg-tui";

// 创建终端
const terminal = new ProcessTerminal();

// 通过共享的 TUI 接口创建默认的主屏渲染器
const tui: TUI = new TuiMainScreen(terminal);

// 添加组件
tui.addChild(new Text("Welcome to my app!"));

import { defaultEditorTheme as editorTheme } from './test/test-themes.ts';
const editor = new Editor(tui, editorTheme);
editor.onSubmit = (text) => {
  console.log("Submitted:", text);
  tui.addChild(new Text(`You said: ${text}`));
};
tui.addChild(editor);

// 聚焦编辑器，使其接收键盘输入
tui.setFocus(editor);

// 原始模式下 Ctrl+C 不会发送 SIGINT —— 在这里拦截以实现退出
tui.addInputListener((data) => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop();
    process.exit(0);
  }
});

// 启动
tui.start();
```

## 核心 API

### TUI 接口与渲染器

`TUI` 是组件管理、焦点、浮层、输入、生命周期、终端查询与渲染的共享接口。只在构造应用时选择具体渲染器：

- `TuiMainScreen` 渲染进主终端缓冲区，保留终端滚动历史。
- `TuiAltScreen` 在备用终端缓冲区中渲染固定高度视口，滚动由应用自有。停止时恢复主缓冲区并打印完整的最终文档。

```typescript
import { type TUI, TuiAltScreen, TuiMainScreen } from "@OnePanda-TgSec/tg-tui";

const tui: TUI = new TuiMainScreen(terminal);
// 若要使用备用屏中的应用自有视口：
// const tui: TUI = new TuiAltScreen(terminal);

tui.addChild(component);
tui.removeChild(component);
tui.start();
tui.stop();
tui.requestRender(); // 请求重新渲染

// 全局调试键（Shift+Ctrl+D）
tui.onDebug = () => console.log("Debug triggered");
```

### 颜色与终端样式

颜色是可以转换或混合后再交给终端渲染的值：

```typescript
import {
  colorToRgb,
  foregroundAnsi,
  getTerminalColorMode,
  mixColors,
  parseColor,
  rgbColor,
  styleText,
} from "@OnePanda-TgSec/tg-tui";

const accent = parseColor("oklch(70% 0.12 220)");
const background = parseColor("#20242a");
const foreground = mixColors(accent, background, 0.2);

const text = styleText(
  "Ready",
  { fg: foreground, bg: background, bold: true },
  getTerminalColorMode(),
);
```

`Color` 是索引 ANSI 颜色、sRGB 颜色或 OKLCH 颜色。每种颜色都能转换为 sRGB，因此 `mixColors()` 之类的颜色运算永远成立。索引 0-15 遵循用户终端调色板，其 sRGB 值是近似值。`styleText()` 根据请求的终端模式把颜色转换为 truecolor 或 256 色输出。

`parseColor()` 也接受 OKHSL，如 `okhsl(250 60% 55%)`；`okhslColor()` 在代码中构造，`colorToOkhsl()` 读取任意颜色的 OKLCH 通道。OKHSL 的饱和度相对于该色相与明度下 sRGB 色域所能允许的最大值，因此每个取值都在色域内，等饱和度跨色相看起来同样鲜艳。OKHSL 颜色在创建时即转换为 sRGB。

转换不做缓存。OKLCH 颜色——尤其是色域外的——转换成本高于 sRGB 或索引颜色。对每次渲染都要用到的颜色，转换一次并复用结果：

```typescript
const { r, g, b } = colorToRgb(mixColors(accent, background, 0.2));
const foreground = rgbColor(r, g, b); // 重复渲染很便宜
const foregroundCode = foregroundAnsi(foreground, getTerminalColorMode());
```

### 备用屏视口布局

`TuiAltScreen` 可以渲染显式的终端高度布局。`VStack` 与 `HStack` 分配受限区域，`ScrollView` 为单个区域自有滚动。这些语义刻意不提供给 `TuiMainScreen`——那里滚动历史归终端所有。

```typescript
import {
  Container,
  isViewportTUI,
  ScrollView,
  Text,
  VStack,
} from "@OnePanda-TgSec/tg-tui";

const transcript = new Container();
transcript.addChild(new Text("History"));

const editorAndFooter = new VStack([
  editor,
  new Text("status"),
]);

if (isViewportTUI(tui)) {
  tui.setLayoutRoot(new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: editorAndFooter,
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]));
}
```

Stack 条目支持 `basis`、`grow`、`shrink`、`minSize`、`maxSize` 与响应式 `visible` 回调。鼠标滚轮输入指向指针下的滚动视图，未消耗的增量默认链式传给外层滚动视图。主滚动视图接收备用屏的键盘导航动作，以及非滚动区域上方的滚轮输入。它还可以在 OSC 133 语义化提示符标记之间跳转，对应常见终端的提示符导航快捷键。按 `Ctrl+Shift+F` 打开或关闭带边框的搜索面板。面板显示配置的上一个/下一个快捷键并提供可点击的箭头控件；默认 `Enter`/`Ctrl+G` 与 `Shift+Enter`/`Ctrl+Shift+G` 在匹配项之间移动，`Escape` 同时关闭搜索。`TuiAltScreenOptions.searchMatchStyle` 与 `searchCurrentMatchStyle` 自定义匹配高亮，`searchNavigationButtonStyle` 为每个箭头按钮设置样式并接收其悬停状态。`TuiAltScreenOptions.scrollToEndIndicator` 在 `follow: "end"` 的主滚动视图离开底部时，于最后一行居中渲染一个可点击标签；点击它恢复跟随末尾。

布局几何在每个被请求的帧上重建。有状态的组件被保留，其已有的渲染行缓存继续生效。直接对这些布局组件调用 `render(width)` 会产出无边界文档，备用屏恢复主屏时也用这份文档。

### 浮层（Overlays）

浮层把组件渲染在已有内容之上而不替换它。适用于对话框、菜单与模态 UI。

```typescript
// 以默认选项显示浮层（居中，最大 80 列）
const handle = tui.showOverlay(component);

// 自定义定位与尺寸的浮层
// 取值可以是数字（绝对值）或百分比字符串（如 "50%"）
const handle = tui.showOverlay(component, {
  // 尺寸
  width: 60,              // 固定列宽
  width: "80%",           // 相对终端的宽度百分比
  minWidth: 40,           // 最小宽度下限
  maxHeight: 20,          // 最大行高
  maxHeight: "50%",       // 相对终端的最大高度百分比

  // 基于锚点的定位（默认 'center'）
  anchor: 'bottom-right', // 相对锚点定位
  offsetX: 2,             // 锚点的水平偏移
  offsetY: -1,            // 锚点的垂直偏移

  // 基于百分比的定位（anchor 的替代方案）
  row: "25%",             // 垂直位置（0%=顶部，100%=底部）
  col: "50%",             // 水平位置（0%=左，100%=右）

  // 绝对定位（覆盖 anchor/百分比）
  row: 5,                 // 精确行位置
  col: 10,                // 精确列位置

  // 距终端边缘的边距
  margin: 2,              // 四边统一
  margin: { top: 1, right: 2, bottom: 1, left: 2 },

  // 响应式可见性
  visible: (termWidth, termHeight) => termWidth >= 100  // 窄终端上隐藏

  // 焦点行为
  nonCapturing: true       // 显示时不自动聚焦
});

// OverlayHandle 方法
handle.hide();              // 永久移除浮层
handle.setHidden(true);     // 临时隐藏（可以再次显示）
handle.setHidden(false);    // 隐藏后再次显示
handle.isHidden();          // 是否处于临时隐藏
handle.focus();             // 聚焦并置于视觉最前
handle.unfocus();           // 释放焦点给正常的回退目标
handle.unfocus({ target: baseComponent }); // 把焦点释放给指定组件
handle.unfocus({ target: null });   // 释放焦点并保持为空
handle.isFocused();         // 浮层是否持有焦点
handle.getBounds();         // 上一次渲染的终端相对边界

handle.unfocus();
// 浮层失去焦点；TUI 回退到另一个可见的捕获型浮层或之前的焦点目标。

handle.unfocus({ target: null });
// 浮层失去焦点；在重新设置焦点之前没有组件接收输入。

// 聚焦的可见浮层会在临时替换 UI 释放焦点后收回键盘输入。
// 若希望在浮层仍可见时让某个具体组件接收输入，调用 handle.unfocus({ target: component })。

// 隐藏最上层浮层
tui.hideOverlay();

// 是否有可见浮层处于活动状态
tui.hasOverlay();
```

**锚点取值**：`'center'`、`'top-left'`、`'top-right'`、`'bottom-left'`、`'bottom-right'`、`'top-center'`、`'bottom-center'`、`'left-center'`、`'right-center'`

**解析顺序**：
1. `minWidth` 在宽度计算之后作为下限应用
2. 定位优先级：绝对 `row`/`col` > 百分比 `row`/`col` > `anchor`
3. `margin` 把最终位置夹紧在终端边界内
4. `visible` 回调控制浮层是否渲染（每帧调用）

### Component 接口

所有组件实现：

```typescript
interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;
  invalidate(): void;
}
```

| 方法 | 说明 |
|--------|-------------|
| `render(width)` | 返回字符串数组，每行一个。每行**不得超过 `width`**，否则 TUI 会报错。使用 `truncateToWidth()` 或手动换行保证这一点。 |
| `handleInput?(data)` | 组件持有焦点并收到键盘输入时调用。`data` 字符串包含原始终端输入（可能含 ANSI 转义序列）。 |
| `handleMouse?(event)` | 由 `TuiAltScreen` 对指向该组件的归一化指针输入调用。 |
| `invalidate()` | 必需。清除所有渲染缓存，使下一次 `render()` 从头开始。没有渲染缓存的组件可以用空实现。 |

TUI 在每行渲染结果的末尾追加完整的 SGR 复位与 OSC 8 复位。样式不跨行延续。如果输出带样式的多行文本，每行重新应用样式，或使用 `wrapTextWithAnsi()` 让样式在换行后保留。

### 鼠标输入

`TuiAltScreen` 归一化 SGR 鼠标输入并对组件与浮层做命中测试。事件携带组件本地的 `x`/`y`、绝对的 `screenX`/`screenY`、边界、按键、修饰键、点击次数与滚轮增量。`TuiMainScreen` 不捕获鼠标输入，因为滚动历史归终端所有。

```typescript
import type { TuiMouseEvent, TuiMouseEventResult } from "@OnePanda-TgSec/tg-tui";

handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
  if (event.type === "click" && event.button === "left") {
    this.expanded = !this.expanded;
    return { handled: true };
  }
  if (event.type === "press" && event.button === "left") {
    return { handled: true, capture: true, focus: true };
  }
  if (event.type === "drag") {
    this.updateFromPointer(event.x, event.y);
    return { handled: true, render: true };
  }
  return undefined;
}
```

返回 `handled` 会抑制渲染器级的回退行为。`capture` 让后续的拖拽与释放事件继续路由到同一组件。`focus` 请求键盘焦点。可选的 `render` 标志控制重绘：press、click、drag、wheel 默认触发渲染；move 与 release 不触发。可见变化的悬停状态设 `render: true`，已处理的无操作设 `render: false`。渲染请求被合并，终端输出保持差分。

未处理的手势保留备用屏默认行为：滚轮输入滚动最近的 `ScrollView` 并链式传递未消耗的增量，主键拖拽选择文本，OSC 8 链接在父级 click 处理器之前打开，未处理的右键保留配置的粘贴行为。只有 press/release 完成且未发生拖拽时才发出 click。

用 `MouseRegion` 在不改变组件渲染的前提下附加鼠标行为：

```typescript
const collapsible = new MouseRegion(content, (event) => {
  if (event.type !== "click" || event.button !== "left") return undefined;
  expanded = !expanded;
  return { handled: true };
});
```

`Container` 与 `Box` 使用上一帧渲染记录的几何把事件路由给嵌套子组件，因此指针移动不会为了命中测试而重渲染子组件。显式的 `VStack`、`HStack` 与 `ScrollView` 布局直接使用备用屏的布局帧。

### Focusable 接口（IME 支持）

显示文本光标且需要 IME（输入法）支持的组件应实现 `Focusable` 接口：

```typescript
import { CURSOR_MARKER, type Component, type Focusable } from "@OnePanda-TgSec/tg-tui";

class MyInput implements Component, Focusable {
  focused: boolean = false;  // 焦点变化时由 TUI 设置
  
  render(width: number): string[] {
    const marker = this.focused ? CURSOR_MARKER : "";
    // 在假光标之前输出标记
    return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
  }

  invalidate(): void {}
}
```

当 `Focusable` 组件持有焦点时，TUI 会：
1. 在组件上设置 `focused = true`
2. 扫描渲染输出中的 `CURSOR_MARKER`（零宽 APC 转义序列）
3. 把硬件终端光标定位到该位置
4. 仅在启用 `showHardwareCursor` 时显示硬件光标

光标默认保持隐藏。这保留了假光标渲染，同时为跟踪 IME 候选窗口的终端定位了硬件光标。部分终端要求可见的硬件光标才能跟随 IME；用渲染器构造器的 `showHardwareCursor` 参数或 `setShowHardwareCursor(true)` 启用。内置组件 `Editor` 与 `Input` 已实现该接口。

**内嵌输入框的容器组件：** 当容器组件（对话框、选择器等）包含 `Input` 或 `Editor` 子组件时，容器必须实现 `Focusable` 并把焦点状态传播给子组件：

```typescript
import { Container, type Focusable, Input } from "@OnePanda-TgSec/tg-tui";

class SearchDialog extends Container implements Focusable {
  private searchInput: Input;

  // 向子输入框传播焦点，用于 IME 光标定位
  private _focused = false;
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  constructor() {
    super();
    this.searchInput = new Input();
    this.addChild(this.searchInput);
  }
}
```

没有这层传播，用 IME（中文、日文、韩文等）输入时候选窗口会出现在错误位置。

## 内置组件

### Container

分组子组件。

```typescript
const container = new Container();
container.addChild(component);
container.removeChild(component);
```

### Box

为所有子组件应用内边距与背景色的容器。

```typescript
const box = new Box(
  1,                              // paddingX（默认 1）
  1,                              // paddingY（默认 1）
  (text) => chalk.bgGray(text)   // 可选背景函数
);
box.addChild(new Text("Content"));
box.setBgFn((text) => chalk.bgBlue(text));  // 动态更换背景
```

### Text

显示带自动换行与内边距的多行文本。

```typescript
const text = new Text(
  "Hello World",                  // 文本内容
  1,                              // paddingX（默认 1）
  1,                              // paddingY（默认 1）
  (text) => chalk.bgGray(text)   // 可选背景函数
);
text.setText("Updated text");
text.setCustomBgFn((text) => chalk.bgBlue(text));
```

### TruncatedText

单行文本，截断到视口宽度。适用于状态行与标题。

```typescript
const truncated = new TruncatedText(
  "This is a very long line that will be truncated...",
  0,  // paddingX（默认 0）
  0   // paddingY（默认 0）
);
```

### Input

带水平滚动的单行文本输入。

```typescript
const input = new Input();
input.onSubmit = (value) => console.log(value);
input.setValue("initial");
input.getValue();
```

在备用屏模式下，点击会定位光标并让输入框获得键盘焦点。

**键位绑定：**
- `Enter` - 提交
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+W` 或 `Alt+Backspace` - 向前删词
- `Ctrl+U` - 删到行首
- `Ctrl+K` - 删到行尾
- `Ctrl+Left` / `Ctrl+Right` - 按词移动
- `Alt+Left` / `Alt+Right` - 按词移动
- 方向键、Backspace、Delete 行为符合预期

### Editor

多行文本编辑器：自动补全、文件路径补全、粘贴处理，内容超过终端高度时垂直滚动。

```typescript
interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

interface EditorOptions {
  paddingX?: number;  // 水平内边距（默认 0）
}

const editor = new Editor(tui, theme, options?);  // tui 必需，用于感知高度的滚动
editor.onSubmit = (text) => console.log(text);
editor.onChange = (text) => console.log("Changed:", text);
editor.disableSubmit = true; // 临时禁用提交
editor.setAutocompleteProvider(provider);
editor.borderColor = (s) => chalk.blue(s); // 动态更换边框颜色
editor.setPaddingX(1); // 动态更新水平内边距
editor.getPaddingX();  // 获取当前内边距
```

**特性：**
- 备用屏模式下点击定位光标、自动补全行可点击
- 带自动换行的多行编辑
- 斜杠命令自动补全（输入 `/`）
- 文件路径自动补全（按 `Tab`）
- 大段粘贴处理（超过 10 行生成 `[paste #1 +50 lines]` 标记）
- 编辑器上下方的水平线
- 假光标渲染（真实光标隐藏）

**键位绑定：**
- `Enter` - 提交
- `Shift+Enter`、`Ctrl+Enter` 或 `Alt+Enter` - 换行（取决于终端，Alt+Enter 最可靠）
- `Tab` - 自动补全
- `Ctrl+K` - 删到行尾
- `Ctrl+U` - 删到行首
- `Ctrl+W` 或 `Alt+Backspace` - 向前删词
- `Alt+D` 或 `Alt+Delete` - 向后删词
- `Ctrl+A` / `Ctrl+E` - 行首/行尾
- `Ctrl+]` - 向前跳转到字符（等待下一次按键，光标移到首次出现处）
- `Ctrl+Alt+]` - 向后跳转到字符
- 方向键、Backspace、Delete 行为符合预期

### Markdown

渲染带语法高亮与主题支持的 Markdown。

```typescript
interface MarkdownTheme {
  heading: (text: string) => string;
  link: (text: string) => string;
  linkUrl: (text: string) => string;
  code: (text: string) => string;
  codeBlock: (text: string) => string;
  codeBlockBorder: (text: string) => string;
  quote: (text: string) => string;
  quoteBorder: (text: string) => string;
  hr: (text: string) => string;
  listBullet: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  strikethrough: (text: string) => string;
  underline: (text: string) => string;
  highlightCode?: (code: string, lang?: string) => string[];
}

interface DefaultTextStyle {
  color?: (text: string) => string;
  bgColor?: (text: string) => string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

const md = new Markdown(
  "# Hello\n\nSome **bold** text",
  1,              // paddingX
  1,              // paddingY
  theme,          // MarkdownTheme
  defaultStyle    // 可选 DefaultTextStyle
);
md.setText("Updated markdown");
```

**特性：**
- 标题、粗体、斜体、代码块、列表、链接、引用块
- HTML 标签按纯文本渲染
- 可选语法高亮，通过 `highlightCode`
- 内边距支持
- 渲染缓存保证性能

### Loader

动画加载指示器。

```typescript
const loader = new Loader(
  tui,                              // TUI 实例，用于渲染更新
  (s) => chalk.cyan(s),            // 指示器颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Loading..."                     // 消息（默认 "Loading..."）
);
loader.start();
loader.setMessage("Still loading...");
loader.stop();
```

### CancellableLoader

扩展 Loader，增加 Escape 键处理与用于取消异步操作的 AbortSignal。

```typescript
const loader = new CancellableLoader(
  tui,                              // TUI 实例，用于渲染更新
  (s) => chalk.cyan(s),            // 指示器颜色函数
  (s) => chalk.gray(s),            // 消息颜色函数
  "Working..."                     // 消息
);
loader.onAbort = () => done(null); // 用户按 Escape 时调用
doAsyncWork(loader.signal).then(done);
```

**属性：**
- `signal: AbortSignal` - 用户按 Escape 时 abort
- `aborted: boolean` - 指示器是否已被取消
- `onAbort?: () => void` - 用户按 Escape 时的回调

### SelectList

带键盘导航的交互式选择列表。

```typescript
interface SelectItem {
  value: string;
  label: string;
  description?: string;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

const list = new SelectList(
  [
    { value: "opt1", label: "Option 1", description: "First option" },
    { value: "opt2", label: "Option 2", description: "Second option" },
  ],
  5,      // maxVisible
  theme   // SelectListTheme
);

list.onSelect = (item) => console.log("Selected:", item);
list.onCancel = () => console.log("Cancelled");
list.onSelectionChange = (item) => console.log("Highlighted:", item);
list.setFilter("opt"); // 过滤条目
```

**操作：**
- 鼠标移动/滚轮：高亮行（备用屏模式）
- 点击：选中一行
- 方向键：导航
- Enter：选中
- Escape：取消

### SettingsList

带取值循环与子菜单的设置面板。

```typescript
interface SettingItem {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];  // 提供时，Enter/Space 在取值间循环
  submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
}

interface SettingsListTheme {
  label: (text: string, selected: boolean) => string;
  value: (text: string, selected: boolean) => string;
  description: (text: string) => string;
  cursor: string;
  hint: (text: string) => string;
}

const settings = new SettingsList(
  [
    { id: "theme", label: "Theme", currentValue: "dark", values: ["dark", "light"] },
    { id: "model", label: "Model", currentValue: "gpt-4", submenu: (val, done) => modelSelector },
  ],
  10,      // maxVisible
  theme,   // SettingsListTheme
  (id, newValue) => console.log(`${id} changed to ${newValue}`),
  () => console.log("Cancelled")
);
settings.updateValue("theme", "light");
```

**操作：**
- 鼠标移动/滚轮：高亮行（备用屏模式）
- 点击：激活一行
- 方向键：导航
- Enter/Space：激活（循环取值或打开子菜单）
- Escape：取消

### Spacer

用于垂直间距的空行。

```typescript
const spacer = new Spacer(2); // 2 个空行（默认 1）
```

### Image

在支持 Kitty 图形协议（Kitty、Ghostty、WezTerm）或 iTerm2 行内图片的终端中渲染行内图片。不支持的终端回退为文本占位符。

```typescript
interface ImageTheme {
  fallbackColor: (str: string) => string;
}

interface ImageOptions {
  maxWidthCells?: number;
  maxHeightCells?: number;
  filename?: string;
}

const image = new Image(
  base64Data,       // base64 编码的图片数据
  "image/png",      // MIME 类型
  theme,            // ImageTheme
  options           // 可选 ImageOptions
);
tui.addChild(image);
```

支持的格式：PNG、JPEG、GIF、WebP。尺寸从图片头自动解析。

#### 备用屏图片兼容性

`TuiAltScreen` 在实现 Kitty 图形协议的终端（含 Kitty 与 Ghostty）中支持行内图片与视口部分裁剪。iTerm2 的行内图片协议不提供删除已有 placement 或在滚动时裁剪源图的操作。为防止过期图片残留在重绘内容之上，`TuiAltScreen` 在 iTerm2 中把图片组件渲染为文本占位符。`TuiMainScreen` 继续正常渲染 iTerm2 行内图片。

## 自动补全

### CombinedAutocompleteProvider

同时支持斜杠命令与文件路径。

```typescript
import { CombinedAutocompleteProvider } from "@OnePanda-TgSec/tg-tui";

const provider = new CombinedAutocompleteProvider(
  [
    { name: "help", description: "Show help" },
    { name: "clear", description: "Clear screen" },
    { name: "delete", description: "Delete last message" },
  ],
  process.cwd() // 文件补全的基准路径
);

editor.setAutocompleteProvider(provider);
```

**特性：**
- 输入 `/` 查看斜杠命令
- 按 `Tab` 进行文件路径补全
- 支持 `~/`、`./`、`../` 与 `@` 前缀
- `@` 前缀过滤为可附加的文件

## 按键检测

用 `matchesKey()` 配合 `Key` 辅助对象检测键盘输入（支持 Kitty 键盘协议）：

```typescript
import { matchesKey, Key } from "@OnePanda-TgSec/tg-tui";

if (matchesKey(data, Key.ctrl("c"))) {
  process.exit(0);
}

if (matchesKey(data, Key.enter)) {
  submit();
} else if (matchesKey(data, Key.escape)) {
  cancel();
} else if (matchesKey(data, Key.up)) {
  moveUp();
}
```

**按键标识符**（用 `Key.*` 获得自动补全，或字符串字面量）：
- 基础键：`Key.enter`、`Key.escape`、`Key.tab`、`Key.space`、`Key.backspace`、`Key.delete`、`Key.home`、`Key.end`
- 方向键：`Key.up`、`Key.down`、`Key.left`、`Key.right`
- 带修饰键：`Key.ctrl("c")`、`Key.shift("tab")`、`Key.alt("left")`、`Key.ctrlShift("p")`
- 字符串格式同样有效：`"enter"`、`"ctrl+c"`、`"shift+tab"`、`"ctrl+shift+p"`

## 渲染模式

`TuiMainScreen` 使用三种渲染策略：

1. **首次渲染**：输出所有行，不清除滚动历史
2. **宽度变化或视口上方变化**：清屏并完整重渲染
3. **常规更新**：光标移到第一处变化的行，清除到末尾，渲染变化的行

`TuiAltScreen` 持有一个终端高度的视口。没有显式布局根时，保留旧的单文档滚动行为。使用 `setLayoutRoot()` 后，`VStack`、`HStack` 与嵌套 `ScrollView` 组件可以保留固定区域并各自独立滚动受限区域。它就地更新变化的视口行，在处于底部时跟随流式输出，内容增长时保留手动选定的滚动位置。鼠标滚轮与可配置的键盘导航在不改动终端滚动历史的前提下滚动，包括在 OSC 133 语义化提示符标记之间跳转。滚动条支持悬停展开、拖拽滑块与点击轨道跳转。点击 OSC 8 超链接以配置的 URL 处理器打开。主键拖拽选择文本，且除非 `TuiAltScreenOptions.copyOnSelect` 为 `false`，通过 OSC 52 复制到剪贴板；在滚动视图顶部或底部边缘按住拖拽会自动滚动并把选区延伸到屏幕外内容。Kitty 图片支持垂直视口裁剪；iTerm2 行内图片回退为文本，因为 iTerm2 协议无法在视口重绘期间删除或裁剪 placement。

两个渲染器都把更新包裹在**同步输出**（`\x1b[?2026h` ... `\x1b[?2026l`）中，实现原子化、无闪烁的渲染。

## 终端接口

TUI 可以与任何实现 `Terminal` 接口的对象协同工作：

```typescript
interface Terminal {
  start(onInput: (data: string) => void, onResize: () => void): void;
  stop(): void;
  write(data: string): void;
  get columns(): number;
  get rows(): number;
  moveBy(lines: number): void;
  hideCursor(): void;
  showCursor(): void;
  clearLine(): void;
  clearFromCursor(): void;
  clearScreen(): void;
}
```

**内置实现：**
- `ProcessTerminal` - 使用 `process.stdin/stdout`
- `VirtualTerminal` - 用于测试（基于 `@xterm/headless`）

## 工具函数

```typescript
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@OnePanda-TgSec/tg-tui";

// 获取字符串的可见宽度（忽略 ANSI 码）
const width = visibleWidth("\x1b[31mHello\x1b[0m"); // 5

// 按宽度截断字符串（保留 ANSI 码，追加省略号）
const truncated = truncateToWidth("Hello World", 8); // "Hello..."

// 不带省略号的截断
const truncatedNoEllipsis = truncateToWidth("Hello World", 8, ""); // "Hello Wo"

// 按宽度换行（ANSI 码跨行保留）
const lines = wrapTextWithAnsi("This is a long line that needs wrapping", 20);
// ["This is a long line", "that needs wrapping"]
```

## 创建自定义组件

创建自定义组件时，**`render()` 返回的每一行都不得超过 `width` 参数**。任何行宽于终端时 TUI 会报错。

### 处理输入

用 `matchesKey()` 配合 `Key` 辅助对象处理键盘输入：

```typescript
import { matchesKey, Key, truncateToWidth } from "@OnePanda-TgSec/tg-tui";
import type { Component } from "@OnePanda-TgSec/tg-tui";

class MyInteractiveComponent implements Component {
  private selectedIndex = 0;
  private items = ["Option 1", "Option 2", "Option 3"];
  
  public onSelect?: (index: number) => void;
  public onCancel?: () => void;

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    } else if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    } else if (matchesKey(data, Key.enter)) {
      this.onSelect?.(this.selectedIndex);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancel?.();
    }
  }

  render(width: number): string[] {
    return this.items.map((item, i) => {
      const prefix = i === this.selectedIndex ? "> " : "  ";
      return truncateToWidth(prefix + item, width);
    });
  }

  invalidate(): void {}
}
```

### 处理行宽

用提供的工具函数保证行不超限：

```typescript
import { visibleWidth, truncateToWidth } from "@OnePanda-TgSec/tg-tui";
import type { Component } from "@OnePanda-TgSec/tg-tui";

class MyComponent implements Component {
  private text: string;

  constructor(text: string) {
    this.text = text;
  }

  render(width: number): string[] {
    // 方案 1：截断长行
    return [truncateToWidth(this.text, width)];

    // 方案 2：检查并补齐到精确宽度
    const line = this.text;
    const visible = visibleWidth(line);
    if (visible > width) {
      return [truncateToWidth(line, width)];
    }
    // 补齐到精确宽度（可选，用于背景）
    return [line + " ".repeat(width - visible)];
  }

  invalidate(): void {}
}
```

### ANSI 码注意事项

`visibleWidth()` 与 `truncateToWidth()` 都正确处理 ANSI 转义码：

- `visibleWidth()` 计算宽度时忽略 ANSI 码
- `truncateToWidth()` 保留 ANSI 码并在截断处正确闭合

```typescript
import chalk from "chalk";

const styled = chalk.red("Hello") + " " + chalk.blue("World");
const width = visibleWidth(styled); // 11（不计 ANSI 码）
const truncated = truncateToWidth(styled, 8); // 红色 "Hello" + " W..."，正确复位
```

### 缓存

出于性能考虑，组件应缓存渲染输出，仅在必要时重新渲染：

```typescript
class CachedComponent implements Component {
  private text: string;
  private cachedWidth?: number;
  private cachedLines?: string[];

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines = [truncateToWidth(this.text, width)];

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
```

## 示例

完整聊天界面示例见 `test/chat-simple.ts`，包含：
- 自定义背景色的 Markdown 消息
- 响应期间的加载指示器
- 带自动补全与斜杠命令的编辑器
- 消息间的 Spacer

运行：

```bash
node test/chat-simple.ts
```

## 开发

从 monorepo 根目录运行：

```bash
bun install       # 安装工作区
bun run check     # 全部包的 house standard、格式与类型
bun run test      # 每个包的套件，包括本包
```

只跑本包的套件：

```bash
bun run test packages/tui
```

`packages/tui` 的测试使用 `node:test` 运行器而非 Vitest，因此单个文件可以直接运行：

```bash
bun test/some.test.ts
```

运行 demo：

```bash
bun test/chat-simple.ts
```

### 调试日志

设置 `TG_TUI_WRITE_LOG` 捕获写入 stdout 的原始 ANSI 流。本包读取的每个环境变量都带 `TG_` 前缀（`TG_TUI_WRITE_LOG`、`TG_TUI_DEBUG`、`TG_TUI_DEBUG_REDRAW`、`TG_TUI_ESC_TIMEOUT`、`TG_TRUE_COLOR`、`TG_HYPERLINKS`、`TG_IMAGE_PROTOCOL`）。

有两处刻意保留上游命名，且 TypeScript 都不可达：

- `packages/tui/native/` —— C 与 Objective-C 插件保留其 `PI_NAPI_*` 与 `PI_CLIPBOARD_*` 宏。它们是预处理器内部的宏，由平台工具链编译，不在改名范围内。
- `packages/tui/test/fixtures/*.c` —— 对着 `native/napi.h` 编译，因此必须使用同样的宏。

```bash
TG_TUI_WRITE_LOG=/tmp/tui-ansi.log bun test/chat-simple.ts
```
