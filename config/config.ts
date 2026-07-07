import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../tool/mcp/client.ts';
import { parseJsonc } from './jsonc.ts';

// ── 导出类型 ──────────────────────────────────────────────

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface SubscriptionConfig {
  readonly provider: 'openai' | 'anthropic';
  readonly baseURL: string;
  readonly modelId?: string;
  readonly apiKey?: string; // 可选；留空回退环境变量
}

export interface AgentModelConfig {
  readonly subscription: string; // 'coding' | 'token' 等订阅键
  readonly modelId: string;
  readonly thinkingLevel: ThinkingLevel;
}

// ── AppConfig 定义 ────────────────────────────────────────

export interface AppConfig {
  readonly llm: {
    readonly defaultModel: string;
    readonly temperature: number;
    readonly maxTokens: number;
    readonly subscriptions: Readonly<Record<string, SubscriptionConfig>>;
    readonly agents: Readonly<Record<string, AgentModelConfig>>;
  };
  readonly mcp: {
    readonly servers: readonly McpServerConfig[];
    readonly command: string | null; // 兼容字段，从 servers[0]?.command 派生
    readonly args: readonly string[]; // 兼容字段，从 servers[0]?.args 派生
    readonly timeout: number;
  };
  readonly budget: {
    readonly maxTokensPerSession: number;
    readonly maxStepsPerTask: number;
    readonly stepTimeoutMs: number;
  };
  readonly workspace: {
    readonly baseDir: string;
    readonly maxFileSize: number;
  };
  readonly security: {
    readonly allowedCommands: readonly string[];
    readonly blockedCommands: readonly string[];
  };
}

// ── JSONC 文件结构（内部） ─────────────────────────────────

interface LlmConfigFile {
  readonly subscriptions?: Readonly<Record<string, SubscriptionConfig>>;
  readonly agents?: Readonly<Record<string, AgentModelConfig>>;
}

interface McpConfigFile {
  readonly mcpServers?: Readonly<Record<string, {
    readonly type?: 'stdio' | 'sse';
    readonly command?: string;
    readonly args?: readonly string[];
    readonly env?: Readonly<Record<string, string>>;
    readonly url?: string;
  }>>;
  readonly servers?: readonly McpServerConfig[];
  readonly timeout?: number;
}

// ── 默认配置 ───────────────────────────────────────────────

const DEFAULT_CONFIG: AppConfig = {
  llm: {
    defaultModel: 'claude-sonnet-4-20250514',
    temperature: 0.7,
    maxTokens: 4096,
    subscriptions: {},
    agents: {},
  },
  mcp: {
    servers: [],
    command: null,
    args: [],
    timeout: 15_000,
  },
  budget: {
    maxTokensPerSession: 100_000,
    maxStepsPerTask: 50,
    stepTimeoutMs: 30_000,
  },
  workspace: {
    baseDir: resolve(process.cwd(), 'runtime/workspace'),
    maxFileSize: 1_048_576, // 1MB
  },
  security: {
    allowedCommands: ['nmap', 'sqlmap', 'hydra', 'python', 'node', 'bun', 'bash', 'sh', 'curl', 'wget', 'cat', 'ls', 'find', 'grep', 'whoami', 'id', 'uname', 'ifconfig', 'ping', 'dig', 'nslookup'],
    blockedCommands: ['rm -rf', 'format', 'mkfs', 'dd if=', ':(){', 'fork bomb'],
  },
};

// ── 文件读取辅助 ───────────────────────────────────────────

function readJsoncFile(filePath: string): unknown {
  try {
    const text = readFileSync(filePath, 'utf-8');
    return parseJsonc(text);
  } catch {
    return null;
  }
}

// ── loadConfig ─────────────────────────────────────────────
// 合并优先级：环境变量显式覆盖 > JSONC 文件 > DEFAULT_CONFIG

export function loadConfig(): AppConfig {
  const env = process.env;

  // 读取 JSONC 配置文件（不存在或解析失败时静默回退默认）
  const llmFileData = (readJsoncFile(resolve(__dirname, 'LLMconfig.jsonc')) ?? {}) as LlmConfigFile;
  const mcpFileData = (readJsoncFile(resolve(__dirname, 'mcp.jsonc')) ?? {}) as McpConfigFile;

  // llm 域：subscriptions/agents 来自文件（无 env 覆盖）
  const subscriptions = llmFileData.subscriptions ?? {};
  const agents = llmFileData.agents ?? {};

  // mcp 域：优先读 mcpServers 对象，兼容旧 servers 数组；env MCP_SERVER_COMMAND 存在则覆盖
  const mcpCmd = env['MCP_SERVER_COMMAND'];
  const mcpArgsStr = env['MCP_SERVER_ARGS'];
  const servers: readonly McpServerConfig[] = mcpCmd != null
    ? [{ command: mcpCmd, args: mcpArgsStr != null ? mcpArgsStr.split(' ') : [] }]
    : mcpFileData.mcpServers != null
      ? Object.entries(mcpFileData.mcpServers).map(([name, cfg]) => ({
          name,
          type: cfg.type ?? 'stdio' as const,
          command: cfg.command ?? '',
          args: cfg.args ? [...cfg.args] : [],
          ...(cfg.env != null ? { env: { ...cfg.env } } : {}),
          ...(cfg.url != null ? { url: cfg.url } : {}),
        }))
      : (mcpFileData.servers ?? []);

  // 兼容字段：从 servers[0] 派生
  const firstServer = servers[0];
  const command = firstServer != null ? firstServer.command : null;
  const args = firstServer != null ? [...firstServer.args] : [];

  // timeout：env > 文件 > 默认
  const mcpTimeoutEnv = env['MCP_TIMEOUT_MS'];
  const timeout = mcpTimeoutEnv != null
    ? parseInt(mcpTimeoutEnv, 10)
    : mcpFileData.timeout ?? DEFAULT_CONFIG.mcp.timeout;

  return {
    llm: {
      defaultModel: env['TIANGONG_DEFAULT_MODEL'] ?? DEFAULT_CONFIG.llm.defaultModel,
      temperature: parseFloat(env['TIANGONG_TEMPERATURE'] ?? String(DEFAULT_CONFIG.llm.temperature)),
      maxTokens: parseInt(env['TIANGONG_MAX_TOKENS'] ?? String(DEFAULT_CONFIG.llm.maxTokens), 10),
      subscriptions,
      agents,
    },
    mcp: {
      servers,
      command,
      args,
      timeout,
    },
    budget: {
      maxTokensPerSession: parseInt(env['TIANGONG_MAX_TOKENS_SESSION'] ?? String(DEFAULT_CONFIG.budget.maxTokensPerSession), 10),
      maxStepsPerTask: parseInt(env['TIANGONG_MAX_STEPS'] ?? String(DEFAULT_CONFIG.budget.maxStepsPerTask), 10),
      stepTimeoutMs: parseInt(env['TIANGONG_STEP_TIMEOUT_MS'] ?? String(DEFAULT_CONFIG.budget.stepTimeoutMs), 10),
    },
    workspace: {
      baseDir: env['TIANGONG_WORKSPACE_DIR'] ?? DEFAULT_CONFIG.workspace.baseDir,
      maxFileSize: parseInt(env['TIANGONG_MAX_FILE_SIZE'] ?? String(DEFAULT_CONFIG.workspace.maxFileSize), 10),
    },
    security: {
      allowedCommands: env['TIANGONG_ALLOWED_COMMANDS']?.split(',') ?? DEFAULT_CONFIG.security.allowedCommands,
      blockedCommands: env['TIANGONG_BLOCKED_COMMANDS']?.split(',') ?? DEFAULT_CONFIG.security.blockedCommands,
    },
  };
}

// ── 惰性单例 ───────────────────────────────────────────────
// import 模块不再触发 loadConfig；向导先写文件后，首次 getConfig() 才读取。

let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (_config === null) {
    _config = loadConfig();
  }
  return _config;
}

export function resetConfig(): void {
  _config = null;
}
