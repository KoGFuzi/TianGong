# TianGong v2

> 基于事件驱动的多 Agent 协作引擎，支持交互式 TUI 与 Headless 无头模式，通过 MCP 协议动态扩展工具能力。

---

## 核心特性

- **多 Agent 协作** — 内置 Planner、Builder、Operator、Research 四个角色，通过 `handoff_to_agent` 工具在 Agent 间动态交接任务
- **MCP 工具集成** — 通过 MCP 协议连接外部服务器，按需扩展 Agent 能力；本地工具与 MCP 工具统一注册、统一鉴权
- **事件驱动架构** — 基于 `mitt` 的类型化事件总线，引擎、Agent、工具、流式输出等全部通过事件解耦
- **TUI / Headless 双模式** — TUI 模式提供基于 Ink + React 的终端交互界面；Headless 模式支持命令行参数或 stdin 管道输入，输出 JSON Lines
- **预算管理** — 会话级 token 预算控制与步数上限，超限自动熔断
- **会话持久化** — 基于 `bun:sqlite` 保存会话状态，支持中断后恢复
- **向量记忆** — 基于 sqlite-vec 的向量存储引擎，支持 L2 距离检索，自动降级为 JSON + 余弦相似度
- **安全工作区** — 文件读写与脚本执行均限制在受控目录内，命令黑名单/白名单双重校验
- **首次运行向导** — 自动引导配置 LLM 订阅、Agent 模型分配和 MCP 服务器

---

## 设计哲学

### 引擎与 UI 分离

`kernel/handoff-engine.ts` 导出的 `runEngine()` 是纯调度函数，不 import 任何 Ink/React 模块。引擎与外部 UI 的交互仅通过两个通道：

1. **事件总线（输出）** — 引擎在执行过程中通过 `eventBus.emit()` 发出事件，例如第 68 行 `eventBus.emit('engine:start', { userInput })`、第 121 行 `eventBus.emit('agent:thinking', { agentId: agent.id })`、第 139 行 `eventBus.emit('llm:stream', { agentId: agent.id, chunk: part.text })`。TUI 的 `apps/tui/store.ts` 中 `bindEventBus()` 函数订阅这些事件更新 Zustand 状态触发 React 重渲染；Headless 的 `apps/headless/index.ts` 第 18-35 行订阅后直接 `JSON.stringify()` 输出到 stdout。引擎完全不关心谁在监听。
2. **Promise 挂起（输入）** — 第 49-53 行 `waitForUserInput()` 创建挂起的 Promise 并存下 resolver：`function waitForUserInput(): Promise<string> { return new Promise<string>((resolveInput) => { _inputResolver = resolveInput; }); }`；第 337 行引擎循环中 `const newUserInput = await waitForUserInput()` 暂停执行。外部 UI 收到用户消息后调用第 59-65 行的 `provideUserInput(input)` resolve Promise，引擎随即恢复循环。这套机制让 TUI 和 Headless 可以用完全不同的方式提供用户输入，而引擎内核无需任何适配。

### 工具统一抽象

无论本地工具还是 MCP 远程工具，都走同一条链路：

- **注册** — `tool/registry.ts` 第 6-11 行定义 `ToolDefinition` 接口（name / description / inputSchema / allowedAgents），第 71-78 行导出 `allToolDefinitions` 数组包含 6 个工具定义。`handoff-engine.ts` 第 124 行调用 `getToolsForAgent(agent.id)` 过滤出该 Agent 可用的本地工具，第 132 行调用 `getMcpToolsForAgent(agent.id, context)` 获取 MCP 工具，第 140 行 `const tools: ToolSet = { ...localTools, ...mcpToolSet }` 合并为同一个 ToolSet 传给第 160 行的 `streamAgentResponse()`。
- **执行** — `tool/executor.ts` 第 38-68 行的 `executeTool()` 是统一入口，第 50 行通过 `toolName.startsWith('mcp_')` 判断路由：MCP 工具转发给第 51 行 `mcpClient.callTool(toolName, args)`，本地工具走第 54-67 行 `switch/case` 分发到 `executeBash()`、`writeToWorkspace()` 等具体实现。
- **鉴权** — 第 20-36 行 `checkPermission()` 对两者使用相同逻辑：本地工具查 `allowedAgents` 白名单（空数组表示不限制），MCP 工具第 22-24 行一律 `return true`。Agent 感知不到工具的执行位置差异。

### 配置分层覆盖

`config/config.ts` 中 `loadConfig()` 的合并顺序：

1. 第 75-102 行硬编码 `DEFAULT_CONFIG` 提供全量默认值（如 `maxTokensPerSession: 100_000`、`maxStepsPerTask: 50`、安全白名单含 `nmap`/`python`/`curl` 等 20 个命令、黑名单含 `rm -rf`/`dd if=` 等 5 个危险模式）
2. 第 122-123 行通过 `readJsoncFile()` 读取 `config/LLMconfig.jsonc`（subscriptions / agents）和 `config/mcp.jsonc`（mcpServers / timeout），覆盖默认值。JSONC 解析由 `config/jsonc.ts` 实现，支持注释和尾逗号
3. 第 158-182 行 `process.env` 环境变量逐字段覆盖——例如第 172 行 `parseInt(env['TIANGONG_MAX_STEPS'])` 覆盖 `budget.maxStepsPerTask`，第 132-133 行 `env['MCP_SERVER_COMMAND']` 存在时直接构造单元素 `servers` 数组覆盖整个 MCP 配置

第 189-196 行 `getConfig()` 采用惰性单例（`let _config: AppConfig | null = null`），首次调用时才执行 `loadConfig()`，这确保 `wizard.tsx` 向导先写入 JSONC 文件后，引擎读到的是最新配置。第 198-200 行 `resetConfig()` 将单例置空，用于测试或配置热更新。

### 安全纵深防御

实际防护层次：

1. **路径穿越拦截** — `runtime/workspace/index.ts` 第 20-25 行 `validatePath()` 拒绝含 `..`、`/`、`\` 的文件名；第 29-39 行 `resolveSessionPath()` 在 `resolve()` 后二次校验第 35 行 `if (!fullPath.startsWith(baseDir + sep) && fullPath !== baseDir)` 完整路径必须以 `baseDir + sep` 开头，否则返回 `{ safe: false }`
2. **文件大小限制** — 第 47-57 行 `checkFileSize()` 在写入前先调用，第 49 行用 `new TextEncoder().encode(content).byteLength` 计算实际字节数，第 50 行 `if (byteSize > maxFileSize)` 超过 `maxFileSize`（默认 1MB）直接拒绝
3. **命令黑白名单** — `tool/executor.ts` 第 76-99 行 `executeBash()` 先用第 83-91 行 `for (const pattern of blockedCommands)` 遍历黑名单（如 `rm -rf`、`dd if=`）做 `trimmedCmd.includes(pattern)` 子串匹配，再用第 94 行 `if (allowedCommands.length > 0 && !allowedCommands.includes(cmdName))` 检查白名单（默认包含 `nmap`、`python`、`curl` 等 20 个安全命令）
4. **Agent 工具权限隔离** — `tool/registry.ts` 中每个 `ToolDefinition` 的 `allowedAgents` 字段限定可用 Agent，例如第 30 行 `execute_bash` 仅限 `['operator']`，第 40 行 `write_to_workspace` 仅限 `['builder']`，第 59 行 `web_search` 仅限 `['research']`；第 21 行 `handoff_to_agent` 和第 68 行 `task_complete` 设为空数组表示所有 Agent 可用

### 渐进式能力降级

两处关键降级逻辑：

1. **Tool Call 降级** — `handoff-engine.ts` 第 20-31 行 `modelSupportsNativeTools()` 按模型 ID 前缀判断（`gpt-4*`、`claude-3*`/`claude-4*`、`gemini-*`、`deepseek-*` 走原生路径）。第 144 行 `const supportsTools = sub != null && modelSupportsNativeTools(agent.modelId)` 判断能力，第 145 行 `const effectiveTools = supportsTools ? tools : ({} as ToolSet)` 不支持时传空工具集。第 149-156 行走 fallback：`pipeline/fallback.ts` 的 `injectToolsToPrompt()` 将工具的 name/description/inputSchema 序列化为文本拼接到 systemPrompt 末尾；第 178-179 行 `parseToolCallsFromText(response.text)` 从模型输出中正则提取 `tool_calls` 块，转为 `NormalizedToolCall`。第 191 行 `normalizeToolCalls(allRawToolCalls)` 将原生 tool call 和 fallback 解析结果合并，下游代码无感知。
2. **向量检索降级** — `runtime/memory/vectors/index.ts` 第 65-74 行 `tryLoadVecExtension()` 尝试 `db.loadExtension(sqliteVec.getLoadablePath())`，成功则第 58 行 `this.backend = 'sqlite-vec'`，使用第 81-89 行 `vec0` 虚拟表 + 第 160-177 行 L2 距离检索；失败则第 58 行 `this.backend = 'json'`，回退到第 93-99 行普通 `vector_store` 表存储 JSON 序列化向量，第 180-198 行 `searchJson()` 全表加载后在 JS 层用第 230-248 行 `cosineSimilarity()` 计算相似度排序。

---

## 项目结构

```
TianGong v2
├── apps/
│   ├── tui/                   # 交互式 TUI 入口（Ink + React）
│   └── headless/              # 无头模式入口（JSON Lines 输出）
├── bin/
│   ├── tiangong.tsx           # 全局命令 tiangong 入口
│   └── tiangong-cli.ts        # 全局命令 tiangong-cli 入口
├── config/
│   ├── config.ts              # 配置加载（JSONC + 环境变量合并）
│   ├── jsonc.ts               # JSONC 解析器
│   └── wizard.tsx             # 首次运行配置向导
├── kernel/
│   ├── agents/                # Agent 定义与类型
│   │   ├── planner.ts         #   Planner — 任务规划与调度
│   │   ├── builder.ts         #   Builder — 代码编写与文件生成
│   │   ├── operator.ts        #   Operator — 命令执行与运维操作
│   │   └── research.ts        #   Research — 信息检索与分析
│   ├── handoff-engine.ts      # 引擎核心：多 Agent 调度、预算检查、会话恢复
│   ├── bootstrap.ts           # CLI 模式引导与交互循环
│   └── commands.ts            # 交互命令处理（/clear, /mcp, /skill, /exit）
├── model/
│   ├── provider.ts            # LLM Provider 抽象（OpenAI / Anthropic 流式调用）
│   └── provider/              # Key 管理、限流等辅助模块
├── runtime/
│   ├── budget/                # Token 预算管理与熔断
│   ├── eventbus/              # 类型化事件总线（mitt）
│   ├── memory/                # 向量存储引擎（sqlite-vec）与记忆管理
│   ├── session/               # SQLite 会话持久化
│   └── workspace/             # 安全工作区（文件读写、脚本执行、路径校验）
├── tool/
│   ├── registry.ts            # 工具注册中心（Zod schema 定义）
│   ├── executor.ts            # 工具执行器（鉴权 + 路由）
│   ├── local/                 # 本地工具（web-search 等）
│   └── mcp/                   # MCP 客户端、生命周期管理、工具路由
├── package.json
├── tsconfig.json
└── bun.lock
```

---

## 技术栈

| 类别 | 技术 |
| --- | --- |
| 运行时 | [Bun](https://bun.sh/) + TypeScript |
| TUI 框架 | [Ink](https://github.com/vadimdemedes/ink) + React 19 |
| 状态管理 | [Zustand](https://zustand-demo.pm.pm/) |
| AI SDK | [Vercel AI SDK](https://sdk.vercel.ai/)（OpenAI / Anthropic） |
| 工具协议 | [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| 参数校验 | [Zod](https://zod.dev/) |
| 事件总线 | [mitt](https://github.com/developit/mitt) |
| 持久化 | bun:sqlite + [sqlite-vec](https://github.com/asg017/sqlite-vec) |

---

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.0

### 安装依赖

```bash
bun install
```

### 首次配置

```bash
bun run config/wizard.tsx
```

向导会引导你完成：
1. 添加 LLM 订阅（provider / baseURL / modelId / apiKey）
2. 为四个 Agent 分配模型与思考链等级
3. 配置 MCP 服务器（可选）

配置最终写入 `config/LLMconfig.jsonc` 与 `config/mcp.jsonc`。

### 启动 TUI（交互式终端）

```bash
tiangong
# 或
bun run bin/tiangong.tsx
```

### 启动 CLI（无头模式）

```bash
# 命令行参数模式
tiangong-cli "分析这个项目的依赖"

# stdin 管道模式
echo "分析这个项目的依赖" | tiangong-cli
```

---

## 配置说明

### LLM 配置：`config/LLMconfig.jsonc`

定义 LLM 订阅与 Agent 模型分配：

```jsonc
{
  "subscriptions": {
    "coding": {
      "provider": "anthropic",
      "baseURL": "https://api.anthropic.com",
      "modelId": "claude-sonnet-4-20250514",
      "apiKey": "sk-xxx"
    }
  },
  "agents": {
    "planner": {
      "subscription": "coding",
      "modelId": "claude-sonnet-4-20250514",
      "thinkingLevel": "medium"
    }
    // builder / operator / research 同理
  }
}
```

### MCP 配置：`config/mcp.jsonc`

定义 MCP 外部工具服务器：

```jsonc
{
  "mcpServers": {
    "example-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-example"]
    }
  },
  "timeout": 15000
}
```

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `TIANGONG_DEFAULT_MODEL` | 默认模型 ID |
| `TIANGONG_TEMPERATURE` | 采样温度 |
| `TIANGONG_MAX_TOKENS` | 单次最大 token 数 |
| `TIANGONG_MAX_TOKENS_SESSION` | 会话级 token 上限 |
| `TIANGONG_MAX_STEPS` | 单任务最大步数 |
| `TIANGONG_WORKSPACE_DIR` | 工作区目录路径 |
| `MCP_SERVER_COMMAND` / `MCP_SERVER_ARGS` | 临时覆盖 MCP 启动命令 |

配置合并优先级：**环境变量 > JSONC 文件 > 默认值**。

---

## 全局命令

通过 `npm link`（或 `bun link`）注册两个全局命令：

| 命令 | 说明 |
| --- | --- |
| `tiangong` | 启动交互式 TUI 终端界面 |
| `tiangong-cli` | 启动 Headless/CLI 无头模式，输出 JSON Lines |

这两个命令分别对应 `bin/tiangong.tsx` 和 `bin/tiangong-cli.ts`，文件顶部带有 `#!/usr/bin/env bun` shebang，可作为独立可执行文件运行。

---

## 许可证

MIT
