import type { ToolExecutionResult } from '../../tool/executor.ts';

export interface NormalizedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export function normalizeToolCalls(toolCallParts: ReadonlyArray<{
  toolCallId: string;
  toolName: string;
  input: unknown;
}>): NormalizedToolCall[] {
  return toolCallParts.map(tc => ({
    id: tc.toolCallId,
    name: tc.toolName,
    arguments: (tc.input as Record<string, unknown>) ?? {},
  }));
}

export function formatToolResults(
  toolCallId: string,
  toolName: string,
  result: ToolExecutionResult,
): {
  role: 'tool';
  content: ReadonlyArray<{
    type: 'tool-result';
    toolCallId: string;
    toolName: string;
    output: { type: 'json'; value: unknown };
  }>;
} {
  const output = result.success
    ? { type: 'json' as const, value: { success: true, output: result.output } }
    : { type: 'json' as const, value: { success: false, error: result.error } };

  return {
    role: 'tool' as const,
    content: [{
      type: 'tool-result' as const,
      toolCallId,
      toolName,
      output,
    }],
  };
}
