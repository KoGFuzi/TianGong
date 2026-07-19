import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../tool/mcp/client.ts';
import { parseJsonc } from './jsonc.ts';

// ── 导出类型 ──────────────────────────────────────────────

export type ThinkingLevel = 'low' | 'medium' | 'high';

export interface SubscriptionConfig {
  readonly provider: 'openai' | 'anthropic' | 'ollama' | 'lm-studio';
  readonly baseURL: string;
  readonly modelId?: string;
  readonly apiKey?: string; // 可选；留空回退环境变量
}

/** 本地模型预设配置 */
export const LOCAL_PROVIDER_PRESETS = {
  'ollama': {
    label: 'Ollama（本地）',
    baseURL: 'http://localhost:11434/v1',
    apiKey: '',
  },
  'lm-studio': {
    label: 'LM Studio（本地）',
    baseURL: 'http://localhost:1234/v1',
    apiKey: '',
  },
} as const satisfies Record<'ollama' | 'lm-studio', { label: string; baseURL: string; apiKey: string }>;

/** 云厂商预设配置（provider 已确定，baseURL 固定） */
export interface CloudProviderPreset {
  readonly label: string;
  readonly provider: 'openai' | 'anthropic';
  readonly baseURL: string;
}

export const CLOUD_PROVIDER_PRESETS = {
  'deepseek-openai': {
    label: 'DeepSeek（OpenAI 兼容）',
    provider: 'openai' as const,
    baseURL: 'https://api.deepseek.com',
  },
  'deepseek-anthropic': {
    label: 'DeepSeek（Anthropic 兼容）',
    provider: 'anthropic' as const,
    baseURL: 'https://api.deepseek.com/anthropic',
  },
  'qwen-openai': {
    label: 'Qwen 通义千问（OpenAI 兼容）',
    provider: 'openai' as const,
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  'qwen-anthropic': {
    label: 'Qwen 通义千问（Anthropic 兼容）',
    provider: 'anthropic' as const,
    baseURL: 'https://dashscope.aliyuncs.com/apps/anthropic',
  },
  'glm': {
    label: 'GLM 智谱清言',
    provider: 'openai' as const,
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  },
  'kimi': {
    label: 'Kimi 月之暗面',
    provider: 'openai' as const,
    baseURL: 'https://api.moonshot.cn/v1',
  },
  'minimax': {
    label: 'MiniMax',
    provider: 'anthropic' as const,
    baseURL: 'https://api.minimaxi.com/anthropic',
  },
} as const satisfies Record<string, CloudProviderPreset>;

/** 已知模型的上下文窗口大小映射 */
export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'deepseek-v3': 65536,
  'deepseek-r1': 65536,
  'deepseek-v4': 65536,
  'claude-sonnet-4-20250514': 200000,
  'claude-3-5-sonnet': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 128000,
};

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
  readonly context: {
    readonly contextWindow: number;        // 模型上下文窗口大小，默认 32768
    readonly summaryThreshold: number;     // 触发摘要的 Token 占比阈值，默认 0.7
    readonly slidingWindowSize: number;    // 滑动窗口保留的最近消息轮数，默认 10
    readonly toolOutputMaxTokens: number;  // 单条工具输出最大 Token 数，默认 2000
    readonly summaryModel: string | null;  // 摘要使用的轻量模型 ID，可选
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
  context: {
    contextWindow: 32768,
    summaryThreshold: 0.7,
    slidingWindowSize: 10,
    toolOutputMaxTokens: 2000,
    summaryModel: null,
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

  // 上下文窗口：环境变量 > 用户显式配置 > MODEL_CONTEXT_WINDOWS 映射 > 默认值
  const defaultModel = env['TIANGONG_DEFAULT_MODEL'] ?? DEFAULT_CONFIG.llm.defaultModel;
  let contextWindow = DEFAULT_CONFIG.context.contextWindow;
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (defaultModel.startsWith(prefix)) {
      contextWindow = size;
      break;
    }
  }
  const contextWindowEnv = env['TIANGONG_CONTEXT_WINDOW'];
  if (contextWindowEnv != null) {
    contextWindow = parseInt(contextWindowEnv, 10);
  }

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
    context: {
      contextWindow,
      summaryThreshold: DEFAULT_CONFIG.context.summaryThreshold,
      slidingWindowSize: DEFAULT_CONFIG.context.slidingWindowSize,
      toolOutputMaxTokens: DEFAULT_CONFIG.context.toolOutputMaxTokens,
      summaryModel: DEFAULT_CONFIG.context.summaryModel,
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
