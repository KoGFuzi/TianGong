import type { ToolDefinition } from '../../tool/registry.ts';
import type { NormalizedToolCall } from './adapter.ts';

export function injectToolsToPrompt(tools: readonly ToolDefinition[], systemPrompt: string): string {
  if (tools.length === 0) return systemPrompt;

  const toolDescriptions = tools.map((t, i) => {
    return `${i + 1}. **${t.name}**: ${t.description}`;
  }).join('\n');

  return `${systemPrompt}

## 可用工具

你可以使用以下工具。要调用工具，请在回复中使用以下格式：
\`\`\`tool_call
{"name": "工具名", "arguments": {"参数名": "参数值"}}
\`\`\`

${toolDescriptions}

调用工具后，等待工具返回结果再继续。`;
}

export function parseToolCallsFromText(text: string): NormalizedToolCall[] {
  const calls: NormalizedToolCall[] = [];
  const regex = /```tool_call\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? '{}') as { name?: string; arguments?: Record<string, unknown> };
      if (parsed.name != null) {
        calls.push({
          id: `fallback_${calls.length}_${Date.now()}`,
          name: parsed.name,
          arguments: parsed.arguments ?? {},
        });
      }
    } catch {
      // 解析失败，跳过
    }
  }

  return calls;
}
