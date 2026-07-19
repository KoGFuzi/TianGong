// 本地工具
export { getToolsForAgent, buildToolSet, allToolDefinitions } from './registry.ts';
export type { ToolDefinition } from './registry.ts';

export { executeTool } from './executor.ts';
export type { ToolExecutionResult } from './executor.ts';

// MCP 模块
export { mcpClient } from './mcp/client.ts';
export type { McpToolInfo, McpServerConfig } from './mcp/client.ts';

export { getMcpToolsForAgent, buildMcpToolSet } from './mcp/router.ts';
export type { McpToolForAI } from './mcp/router.ts';

// MCP 生命周期
export { mcpLifecycle } from './mcp/lifecycle.ts';
