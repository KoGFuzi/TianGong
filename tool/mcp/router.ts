import { z } from 'zod';
import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { mcpClient } from './client.ts';

const MAX_MCP_TOOLS = 5;

// Agent 角色 → 关键词白名单（MVP 阶段硬编码）
const AGENT_KEYWORDS: Record<string, readonly string[]> = {
  operator: ['execute', 'run', 'scan', 'nmap', 'system', 'process', 'network', 'bash', 'shell', 'install', 'deploy', 'service'],
  research: ['fetch', 'search', 'browse', 'web', 'crawl', 'read', 'url', 'http', 'query', 'scrape', 'extract'],
  builder: ['file', 'write', 'code', 'compile', 'build', 'edit', 'create', 'template', 'generate', 'parse'],
  planner: ['list', 'info', 'status', 'check', 'overview', 'summary', 'plan', 'analyze'],
};

export interface McpToolForAI {
  readonly name: string;       // 完整名 mcp_<server>_<tool>
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

export async function getMcpToolsForAgent(agentId: string, context: string): Promise<McpToolForAI[]> {
  const allTools = mcpClient.getTools();
  if (allTools.length === 0) return [];

  // Operator 是主要执行者，返回所有 MCP 工具（不过滤）
  if (agentId === 'operator') {
    return allTools.map(t => ({
      name: t.name,
      description: `[MCP] ${t.description}`,
      inputSchema: jsonSchemaToZod(t.inputSchema),
    }));
  }

  const keywords = AGENT_KEYWORDS[agentId] ?? [];
  const contextLower = context.toLowerCase();

  // 评分：工具名或描述匹配关键词 +1，匹配上下文词 +2
  const scored = allTools.map(t => {
    let score = 0;
    const nameLower = t.name.toLowerCase();
    const descLower = t.description.toLowerCase();
    for (const kw of keywords) {
      if (nameLower.includes(kw) || descLower.includes(kw)) score += 1;
    }
    const contextWords = contextLower.split(/\s+/).filter(w => w.length > 2);
    for (const cw of contextWords) {
      if (nameLower.includes(cw) || descLower.includes(cw)) score += 2;
    }
    return { tool: t, score };
  });

  // 按分数降序排列，取前 MAX_MCP_TOOLS 个
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, MAX_MCP_TOOLS);

  // getTools() 已返回完整名 mcp_<server>_<tool>，直接使用，确保与 callTool 期望的完整名一致
  return selected.map(({ tool: t }) => ({
    name: t.name,
    description: `[MCP] ${t.description}`,
    inputSchema: jsonSchemaToZod(t.inputSchema),
  }));
}

// 简易 JSON Schema → Zod 转换（MVP 只处理基本类型）
function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema['type'] as string | undefined;

  if (type === 'object') {
    const properties = (schema['properties'] as Record<string, Record<string, unknown>>) ?? {};
    const required = (schema['required'] as string[] | undefined) ?? [];
    const shape: Record<string, z.ZodType> = {};

    for (const [key, propSchema] of Object.entries(properties)) {
      let fieldSchema = primitiveToZod(propSchema);
      if (propSchema['description'] != null && typeof propSchema['description'] === 'string') {
        fieldSchema = fieldSchema.describe(propSchema['description']);
      }
      if (required.includes(key)) {
        shape[key] = fieldSchema;
      } else {
        shape[key] = fieldSchema.optional();
      }
    }

    return z.object(shape);
  }

  if (type === 'string') return z.string();
  if (type === 'number' || type === 'integer') return z.number();
  if (type === 'boolean') return z.boolean();
  if (type === 'array') return z.array(z.unknown());

  // Fallback: 未知 schema 返回接受任意对象
  return z.record(z.string(), z.unknown());
}

function primitiveToZod(schema: Record<string, unknown>): z.ZodType {
  const type = schema['type'] as string | undefined;
  switch (type) {
    case 'string': return z.string();
    case 'number':
    case 'integer': return z.number();
    case 'boolean': return z.boolean();
    case 'array': return z.array(z.unknown());
    default: return z.string(); // 默认当字符串处理
  }
}

// 构建 MCP ToolSet（供 streamText 使用）
// 注意：不提供 execute 回调，MCP 工具执行由 handoff-engine 通过完整名 mcp_<server>_<tool> 手动路由
export function buildMcpToolSet(tools: McpToolForAI[]): ToolSet {
  const toolSet: ToolSet = {};
  for (const t of tools) {
    toolSet[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema,
    });
  }
  return toolSet;
}
