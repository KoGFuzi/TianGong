# TianGong（天工）

> 面向 OnePanda-TgSec 的 agent、模型与终端技术栈的全 Bun monorepo。

八个包。一套运行时。一个 scope。Bun 同时是包管理器、脚本运行器和编排层；`tsc` 只为发布产物生成
类型声明，工具链里没有任何一环依赖 Node。

本工作区源自 [pi agent](https://github.com/earendil-works/pi) 项目的一个子集：六个包被采用并改牌到
`@OnePanda-TgSec` scope 下，另两个包原样迁移、保留上游名字。这一划分是刻意的，完整陈述见
[`docs/provenance.md`](docs/provenance.md)。

## 快速开始

```bash
bun install              # 安装工作区
bun run generate:models  # 生成 packages/ai/src/providers/data（gitignore，需联网）
bun run build            # 按依赖顺序构建全部 8 个包
bun run test             # 按依赖顺序运行每个包的测试套件
bun run check            # house standard、格式、类型、相对导入
```

需要 Bun 1.4+ 与 Node 22.19+（Node 仅用于 `tsc` 和 `packages/tui` 的 `node:test` 套件）。

## 包一览

### House 包——`@OnePanda-TgSec` 自有

| 包 | 目录 | 说明 |
| --- | --- | --- |
| [`@OnePanda-TgSec/tg-ai`](packages/ai) | `packages/ai` | 统一 LLM API：模型发现、provider 注册、流式调用、OAuth、图片模型注册表，全部收敛在一个接口后面。每个 provider 调用自动记录 telemetry span。 |
| [`@OnePanda-TgSec/tg-agent-core`](packages/agent) | `packages/agent` | Agent 循环：传输抽象、状态管理、工具执行、附件；turn 与工具调用各有一层 telemetry span。 |
| [`@OnePanda-TgSec/tg-gibraltar`](packages/gibraltar) | `packages/gibraltar` | 持久化会话、任务与文档运行时。生产环境只用 SQLite；一切内容先落库再展示，进程被杀也能从断点恢复；带会话删除/导出/备份与项目级用量聚合。 |
| [`@OnePanda-TgSec/tg-tui`](packages/tui) | `packages/tui` | 终端 UI 库：差分渲染、全功能文本编辑器、Markdown 与 LaTeX 渲染、终端内图片。 |
| [`@OnePanda-TgSec/tg-telemetry`](packages/telemetry) | `packages/telemetry` | 厂商中立的 telemetry 契约、类型化 span 词表（`TG_SPAN_SCHEMA`），以及面向适配器实现的 conformance 套件。 |
| [`@OnePanda-TgSec/chord`](packages/chord) | `packages/chord` | 应用组合运行时：服务、复制状态、RPC、插件，以及复制 JSON 文档背后的 delta/diff 引擎。 |

依赖关系（箭头从被依赖方指向依赖方）：

```text
telemetry ──▶ ai ──┬──▶ agent
   └───────────────┘
                   └──▶ gibraltar ▲
chord ────────────────────────────┘
```

`tg-agent-core` 同时依赖 `tg-ai` 与 `tg-telemetry`（turn/tool span 记录在共享词表上）；
`tg-gibraltar` 依赖 `chord` 与 `tg-ai`。

`chord`、`tui`、`telemetry`、`codemode`、`mcp` 是叶子：它们不引用工作区内任何包。这正是 `chord`
能够独立发布的原因。

### Vendored 包——从 pi agent 原样迁移，未做改动

| 包 | 目录 | 上游版本 | 说明 |
| --- | --- | --- | --- |
| `@earendil-works/pi-codemode` | `packages/codemode` | `1.0.1` | 沙箱化 JavaScript 执行，唯一能力是调用注入的工具（QuickJS/WASI）。 |
| `@earendil-works/pi-mcp` | `packages/mcp` | `1.0.1` | 独立 Model Context Protocol 客户端：传输层中立核心、stdio 与 Streamable HTTP 传输、OAuth 子集、内存测试传输。 |

## 迁移声明：codemode 与 mcp

`packages/codemode` 与 `packages/mcp` 是从 pi agent 项目（`earendil-works/pi`，MIT，上游署名
"Earendil Works"）**原样迁移**的。它们**没有**被改名、**没有**被重写、**没有**被重新格式化，也
**没有**被打过任何补丁。

它们保留上游的包名（`@earendil-works/pi-codemode`、`@earendil-works/pi-mcp`）、上游的 author
字段、上游的仓库元数据、上游的版本号。原因是发布连续性：两者都是独立发布的包，有自己的 changelog
历史，且追踪变化频繁的上游接口——上游修复可以直接整文件替换引入，而不需要重新推导。

House 包以原名引用它们。这两个 specifier 是任何 house 包唯一允许使用的 `@earendil-works/*` 名
称，`bun run check:house-standard` 会对其他任何名称直接判负。Vendored 包永远不会 import house 包。

完整陈述——拿了哪些文件、边界规则、重新同步流程、每个包被采用的原因——见
[`docs/provenance.md`](docs/provenance.md)。

## 配置

配置分布在五个 XDG 根目录下，解析方式与 `opencode` 相同——每个根一个产品目录，目录里只放它该放
的东西：

```text
~/.config/TianGong/          设置                $TIANGONG_CONFIG_DIR, $XDG_CONFIG_HOME
~/.local/share/TianGong/     机器状态            $TIANGONG_DATA_DIR,   $XDG_DATA_HOME
├── auth.json                provider 凭证，由 `tg-ai login` 写入
└── session.sqlite           默认会话数据库
~/.local/state/TianGong/     锁                  $TIANGONG_STATE_DIR,  $XDG_STATE_HOME
~/.cache/TianGong/           一次性缓存          $TIANGONG_CACHE_DIR,  $TIANGONG_CACHE_HOME
os.tmpdir()/TianGong         临时草稿
```

```typescript
import { tiangongDataPath, tiangongSessionDbPath } from "@OnePanda-TgSec/tg-ai";

tiangongSessionDbPath(); // ~/.local/share/TianGong/session.sqlite
tiangongDataPath("auth.json");
```

`auth.json` 放在 **data** 下而不是 config 下，与 `opencode` 一致：凭证是机器生成的运行时状态，
不是用户手写的配置。`$TIANGONG_*_DIR` 的值必须是绝对路径；相对路径会被拒绝，而不是悄悄写到当前
工作目录旁边。

### 环境变量

工作区读取的每个变量都带 `TG_` 前缀：

| 变量 | 读取方 | 作用 |
| --- | --- | --- |
| `TG_CACHE_RETENTION` | `tg-ai` | `long` 选择长寿命的 provider prompt 缓存。 |
| `TG_OAUTH_CALLBACK_HOST` | `tg-ai` | 本地 OAuth 回调监听绑定的主机。 |
| `TG_TUI_WRITE_LOG` | `tg-tui` | 捕获写入 stdout 的原始 ANSI 流。 |
| `TG_TUI_DEBUG`, `TG_TUI_DEBUG_REDRAW` | `tg-tui` | 主界面调试输出、全量重绘追踪。 |
| `TG_TUI_ESC_TIMEOUT` | `tg-tui` | 转义序列判定时窗，毫秒。 |
| `TG_TRUE_COLOR`, `TG_HYPERLINKS`, `TG_IMAGE_PROTOCOL` | `tg-tui` | 终端能力覆盖。 |

有两处保留上游命名、TypeScript 刻意不可达：`packages/tui/native/`（C/Objective-C 插件保留
`PI_NAPI_*` 与 `PI_CLIPBOARD_*` 预处理宏）和 `packages/tui/test/fixtures/*.c`（对着
`native/napi.h` 编译，必须使用同样的宏）。

## House 标准

完整规则在 [`AGENTS.md`](AGENTS.md)。简版：

- Scope `@OnePanda-TgSec`，根仓库名 `tiangong`，author `KoGFuzi`，MIT，根与全部六个 house 包共享
  同一条 `2.x` 版本线。
- 每个标识符都带 `tg` 身份：包名 `tg-*`、持久化 kind `tg.*`、类型 `Tg*`、环境变量 `TG_*`、产品
  名 `TianGong`、配置目录 `~/.config/TianGong`。house 代码里不存在任何 `pi` 前缀标识符。
- `chord` 是 `tg-` 包名前缀的登记例外，`packages/tui/native/` 是标识符规则的登记例外。
- Vendored 包冻结；本地适配写在调用方的 house 包里。
- Tab 缩进、宽度 3、行宽 120、双引号，由 Biome 全权负责。只使用可擦除的 TypeScript 语法。
- 每个相对导入必须带扩展名。
- 每个 house 包一份 `packages/*/CHANGELOG.md`，新条目写入 `## [Unreleased]`。

强制检查在 `bun run check:house-standard`（`scripts/check-house-standard.ts`）：它给每个包分类、
断言 house 元数据、断言 vendored 冻结，并拒绝 house 代码里出现在固定白名单（Radius 的
`radius.pi.dev` 网关、native 插件的 C 宏、LaTeX、上游项目 URL）之外的任何 `pi` 前缀标识符。

## 脚本

| 命令 | 作用 |
| --- | --- |
| `bun run build` | 按依赖顺序构建所有包。`--offline` 使用各包的 `build:offline`。 |
| `bun run build:offline` | 同上，但跳过需要联网的模型目录刷新。 |
| `bun run clean` | 删除 `dist/` 与生成的模型数据。 |
| `bun run check` | House standard、Biome、`tsc --noEmit`、相对导入规则。 |
| `bun run check:format:write` | 应用 Biome 格式化。 |
| `bun run check:house-standard` | 包分类、元数据、vendored 冻结。 |
| `bun run check:relative-imports` | 每个相对导入必须写明扩展名。 |
| `bun run generate:models` | 重新生成 `packages/ai/src/models.generated.ts` 与 `src/providers/data/`。 |
| `bun run hydrate:model-data` | 只刷新生成的 provider 数据。 |
| `bun run generate:model-catalog` | 写出可发布目录到 `.artifacts/model-catalog`。 |
| `bun run test` | 按依赖顺序运行每个包套件。可传包名缩小范围。 |
| `bun run version:patch\|minor\|major` | 移动共享的 house 版本线。Vendored 包保持自己的版本。 |

`bun test` **不是**这里的测试命令。Bun 把这个名字留给了自己的运行器，它会绕过每个包的 Vitest /
`node:test` 配置。

## 存储

`@OnePanda-TgSec/tg-gibraltar` 生产环境**只用 SQLite**。`openDefaultSqliteStorage()` 无参打开
`~/.local/share/TianGong/session.sqlite`；`openNodeSqliteStorage(path, { project })` 指定文件并把
每一行限定在一个项目内。每一行都带 `project_id`，每次读取都按它过滤，所以一个文件可以装多个项
目而互不可见。append-only JSONL 后端已移除：两种生产文件格式意味着两条迁移与恢复路径，而其中只
有一条会被真正维护。`MemoryStorage` 保留给测试。

```typescript
import { openDefaultSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const storage = await openDefaultSqliteStorage();
console.log(await storage.health()); // integrity、schema 版本、WAL 模式、synchronous、busy timeout
await storage.checkpoint();          // wal_checkpoint(TRUNCATE)
```

生命周期是显式 API，不进 commit 写路径：

- `deleteConversation(id, context)` 单事务删除会话及其全部行，返回 `ConversationDeletion` 审计
  摘要；删除不存在时返回 `undefined` 不抛错，ID 永不回收，fork 出的子会话不受影响。
- `exportConversation(id, context)` 把会话自己的行序列化为有序 JSONL（header + entries + tasks +
  submissions + documents），可逐行 `JSON.parse` 还原；本期只导不入。
- `backup(path, context)` 用 `VACUUM INTO` 写出一份一致的整库快照；目标文件已存在则报错（SQLite
  语义原样透传）。

会话台账只有一份（`tg.usage` 文档）：每条 assistant 消息与工具结果的使用量与 entry 追加同 commit
原子写入。`projectUsage(storage, context)` 只读聚合出整个项目的总会话数与按模型/工具折叠的用量，
不引入第二份写路径。

## 可观测性（telemetry）

Span 契约来自 `tg-telemetry`：`TelemetryContext` / `TelemetrySpan`、默认零开销的
`NOOP_TELEMETRY_CONTEXT`（不配 telemetry 时全链原样直通）、测试用的 `InMemoryTelemetryContext`。
第一批词表 `TG_SPAN_SCHEMA` 定义了四个 span，全部只放计数与闭集枚举——不进 prompt 文本、工具参数、
路径：

| Span | 层 | 说明 |
| --- | --- | --- |
| `tg.span.provider.acquire` | ai | 并发门排队/拒绝观测，`Models` 的 gate 一层。 |
| `tg.span.provider.request` | ai | 一次完整 provider 逻辑调用（含适配器重试），`retried` / `tokens.*` / `cost.total` 进端属性。 |
| `tg.span.agent.turn` | agent | 一轮 turn：一轮模型响应加它发起的工具调用。 |
| `tg.span.agent.tool` | agent | 一次工具调用：准备、执行、收尾；权限拒绝也记录，`isError` 区分。 |

挂上 `telemetryContext` 后，一次带工具的 turn 呈现为一棵树：

```text
tg.span.agent.turn
  ├─ tg.span.provider.acquire
  │    └─ tg.span.provider.request
  └─ tg.span.agent.tool × n
```

接线只需一个可选字段：请求侧传 `StreamOptions.telemetryContext`，agent 侧传
`AgentLoopConfig.telemetryContext`（嵌套工具调用经 `RunToolCallOptions.telemetryContext` 挂父
span）。不传则全部是 NOOP，事件序列与无 telemetry 时逐事件一致。产品化需要 exporter 时，再实现一
个 `TelemetryContext` 适配包即可——本期不接 OTel SDK，不做采样/批量导出/进程外转发。

## 目录结构

```text
.
├── AGENTS.md              house standard
├── biome.json             工作区的格式与 lint 规则
├── bunfig.toml            精确版本、hoisted node_modules
├── package.json           Bun workspace 根
├── tsconfig.base.json     每个包构建都继承的编译选项
├── tsconfig.json          根类型检查、工作区路径映射
├── tsconfig.scripts.json  scripts/ 的类型检查（带 Bun 全局类型）
├── vitest.base.ts         共享 Vitest alias 映射
├── docs/provenance.md     包来源，含 vendored 声明
├── scripts/               Bun 编排与 house-standard 检查
├── .githooks/             pre-commit 门禁，`bun run prepare` 安装
└── packages/              八个工作区包
```

## License

MIT。见 [`LICENSE`](LICENSE)。

Vendored 包保留各自的上游 license。`packages/mcp/LICENSES/` 携带其内部 vendored 的 Model
Context Protocol TypeScript SDK 定义的 license 文本。
