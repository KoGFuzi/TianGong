# TianGong
> 一个基于事件驱动的多 Agent 协作引擎，支持交互式 TUI、Headless 无头模式，并可通过 MCP 扩展外部工具。

---

## 功能特性

- **多 Agent 协作引擎**：内置 Planner、Builder、Operator、Research 四个角色，通过 `handoff_to_agent` 工具动态交接任务。
- **双入口模式**：
  - `apps/tui/index.tsx` — 基于 Ink + React 的终端交互式界面。
  - `apps/headless/index.ts` — 支持命令行参数或 stdin 管道的无头模式，输出 JSON Lines。
- **MCP 工具集成**：通过 MCP 协议连接外部服务器，动态扩展 Agent 能力。
- **本地工具集**：Bash 执行、工作区文件读写、脚本执行、网络搜索等。
- **会话持久化**：基于 SQLite 保存会话状态，支持中断后恢复。
- **预算与安全控制**：会话级 token 预算、步数上限、命令白名单/黑名单。
- **首次运行向导**：自动引导配置 LLM 订阅、Agent 模型和 MCP 服务器。

---

## 技术栈

- [Bun](https://bun.sh/) + TypeScript
- [AI SDK](https://sdk.vercel.ai/)（OpenAI / Anthropic）
- [Ink](https://github.com/vadimdemedes/ink) + React 19（TUI）
- [Zustand](https://zustand-demo.pm.pm/)（TUI 状态管理）
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)（MCP 客户端）
- [Zod](https://zod.dev/)（工具参数校验）
- SQLite（会话持久化）

---

## 快速开始

### 1. 安装依赖

```bash
bun install
```

### 2. 运行首次配置向导

```bash
bun run config/wizard.tsx
```

向导会引导你完成：

1. 添加 LLM 订阅（provider / baseURL / modelId / apiKey）
2. 为四个子 Agent 分配模型与思考链等级
3. 配置 MCP 服务器（可选）

配置最终写入 `config/LLMconfig.jsonc` 与 `config/mcp.jsonc`。

### 3. 启动交互式 TUI

```bash
bun run apps/tui/index.tsx
```

### 4. 启动临时命令行（无 TUI）

```bash
bun run kernel/bootstrap.ts
```

### 5. 启动 Headless 模式

```bash
# 通过命令行参数
bun run apps/headless/index.ts "分析这个项目的依赖"

# 通过管道
echo "分析这个项目的依赖" | bun run apps/headless/index.ts
```

---

## 项目结构

```
TianGong v2
├── apps
│   ├── headless/          # 无头模式入口
│   └── tui/               # 交互式 TUI 入口
├── config/                # 配置加载与首次运行向导
├── kernel                 # 多 Agent 引擎核心
│   ├── agents/            # Agent 定义（planner/builder/operator/research）
│   ├── handoff-engine.ts  # 任务调度与 handoff 逻辑
│   └── commands.ts        # 交互命令处理
├── model                  # LLM Provider 抽象与流式调用
├── runtime                # 运行时基础设施
│   ├── budget/            # Token 预算与熔断
│   ├── eventbus/          # 事件总线
│   ├── memory/            # 持久化存储
│   └── session/           # 会话管理
├── tool                   # 工具执行与 MCP 集成
│   ├── local/             # 本地工具
│   ├── mcp/               # MCP 客户端
│   └── registry.ts        # 工具注册中心
├── package.json
├── tsconfig.json
└── README.md
```

---

## 配置说明

### LLM 配置：`config/LLMconfig.jsonc`

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
    // builder / operator / research
  }
}
```

### MCP 配置：`config/mcp.jsonc`

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
| `TIANGONG_DEFAULT_MODEL` | 默认模型 |
| `TIANGONG_TEMPERATURE` | 采样温度 |
| `TIANGONG_MAX_TOKENS` | 单次最大 token |
| `TIANGONG_MAX_TOKENS_SESSION` | 会话级 token 上限 |
| `TIANGONG_MAX_STEPS` | 单任务最大步数 |
| `MCP_SERVER_COMMAND` / `MCP_SERVER_ARGS` | 临时覆盖 MCP 启动命令 |

---

## 交互命令

在 TUI 或临时 CLI 中输入：

| 命令 | 说明 |
| --- | --- |
| `/clear` | 清空屏幕 |
| `/mcp <status>` | 查看 MCP 状态 |
| `/skill` | 查看可用 Skill |
| `/exit` | 退出程序 |

---

## 架构概览

```
User Input
   │
   ▼
┌─────────────────┐
│   TUI / Headless │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Handoff Engine │  ← 多 Agent 调度、预算检查、会话恢复
└────────┬────────┘
         │
   ┌─────┴─────┐
   ▼           ▼
Agent        Tools
│             ├─ 本地工具（Bash / 文件 / 搜索）
├─ Planner    └─ MCP 工具（外部服务器动态扩展）
├─ Builder
├─ Operator
└─ Research
```

---

## 开发约定

- 使用 `bun run <文件路径>.ts` / `.tsx` 直接运行 TypeScript 源码。
- `tsconfig.json` 启用严格模式与 `allowImportingTsExtensions`。
- 工具定义使用 `zod` 描述输入模式，并在 `tool/registry.ts` 注册。
- 事件通过 `runtime/eventbus/splitter.ts` 分发，所有 `console.log` 集中在 `kernel/bootstrap.ts` 处理。

---

## 许可证

MIT
