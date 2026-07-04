import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly allowedAgents: readonly string[];
}

const handoffToAgentDef: ToolDefinition = {
  name: 'handoff_to_agent',
  description: '将当前任务交接给另一个 Agent。当你确定需要另一个专业领域的 Agent 介入时才调用此工具。',
  inputSchema: z.object({
    target_agent_id: z.string().describe('目标 Agent 的 ID'),
    reason: z.string().describe('交接原因'),
    task: z.string().describe('要交接的具体任务描述'),
  }),
  allowedAgents: [],
};

const executeBashDef: ToolDefinition = {
  name: 'execute_bash',
  description: '在本地执行 shell 命令（Windows 自动使用 Git Bash，Linux/macOS 使用 /bin/sh）。仅在需要运行系统命令时使用。',
  inputSchema: z.object({
    command: z.string().describe('要执行的命令'),
  }),
  allowedAgents: ['operator'],
};

const writeToWorkspaceDef: ToolDefinition = {
  name: 'write_to_workspace',
  description: '将内容写入当前会话的安全工作区文件。所有文件操作都限制在受控目录内，不允许路径穿越。',
  inputSchema: z.object({
    filename: z.string().describe('文件名（不含路径，如 exploit.py、script.sh）'),
    content: z.string().describe('要写入的文件内容'),
  }),
  allowedAgents: ['builder'],
};

const executeWorkspaceScriptDef: ToolDefinition = {
  name: 'execute_workspace_script',
  description: '执行工作区内已存在的脚本文件。根据文件后缀自动选择解释器（.py→python, .ts/.js→bun, .sh→bash）。',
  inputSchema: z.object({
    filename: z.string().describe('工作区中的文件名（不含路径）'),
    args: z.array(z.string()).describe('传递给脚本的参数'),
  }),
  allowedAgents: ['operator'],
};

const webSearchDef: ToolDefinition = {
  name: 'web_search',
  description: '在互联网上搜索信息。返回相关网页的标题、摘要和 URL。仅在需要获取实时信息或查找资料时使用。',
  inputSchema: z.object({
    query: z.string().describe('搜索关键词'),
  }),
  allowedAgents: ['research'],
};

const allToolDefinitions: readonly ToolDefinition[] = [
  handoffToAgentDef,
  executeBashDef,
  writeToWorkspaceDef,
  executeWorkspaceScriptDef,
  webSearchDef,
];

export function getToolsForAgent(agentId: string): ToolDefinition[] {
  return allToolDefinitions.filter(def =>
    def.allowedAgents.length === 0 || def.allowedAgents.includes(agentId)
  );
}

export function buildToolSet(defs: ToolDefinition[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const def of defs) {
    toolSet[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
    });
  }
  return toolSet;
}

export { allToolDefinitions };

export const searchTools = allToolDefinitions.map(def => ({
  name: def.name,
  description: def.description,
  inputSchema: toJsonSchemaCompat(def.inputSchema),
}));
