// 本地工具
export { getToolsForAgent, buildToolSet, allToolDefinitions, searchTools } from './registry.ts';
export type { ToolDefinition } from './registry.ts';

export { executeTool } from './executor.ts';
export type { ToolExecutionResult } from './executor.ts';

// DuckDuckGo 联网检索
export { executeWebSearch } from './local/web-search.ts';

// MCP 模块
export { mcpClient, initializeAll } from './mcp/client.ts';
export type { McpToolInfo, McpServerConfig } from './mcp/client.ts';

export { getMcpToolsForAgent, buildMcpToolSet } from './mcp/router.ts';
export type { McpToolForAI } from './mcp/router.ts';

// Pipeline 适配器与降级模块
export { normalizeToolCalls, formatToolResults } from '../kernel/pipeline/adapter.ts';
export type { NormalizedToolCall } from '../kernel/pipeline/adapter.ts';
export { injectToolsToPrompt, parseToolCallsFromText } from '../kernel/pipeline/fallback.ts';

// MCP 生命周期与注册中心
export { mcpLifecycle } from './mcp/lifecycle.ts';
export { McpLifecycleManager } from './mcp/lifecycle.ts';
export { mcpToolRegistry } from './mcp/registry.ts';
export { McpToolRegistry } from './mcp/registry.ts';
