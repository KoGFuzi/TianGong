import mitt from 'mitt';

// ── 事件类型映射 ────────────────────────────────────────────

export interface AppEvents {
  [key: string]: unknown;
  [key: symbol]: unknown;
  'engine:start': { userInput: string };
  'engine:end': { reason: string; totalSteps: number };
  'engine:text': { agentId: string; text: string };
  'engine:error': { agentId?: string; error: string };
  'engine:awaiting_input': { agentId: string; message: string };
  'engine:user_input': { input: string };

  'agent:thinking': { agentId: string };
  'agent:switch': { fromAgentId: string; toAgentId: string; reason: string };

  'llm:stream': { agentId: string; chunk: string };

  'tool:call': { agentId: string; toolName: string; args: Record<string, unknown> };
  'tool:result': { agentId: string; toolName: string; result: unknown };
  'tool:stream-start': { toolName: string; args: Record<string, unknown> };
  'tool:stream-end': { toolName: string; result: unknown };

  'budget:exceeded': { sessionId: string; usage: number; limit: number };

  'headless:init': { mode: string; input?: string };
  'headless:warning': { message: string };
  'headless:exit': { code?: number };
  'headless:fatal': { error: string };
}

// ── 类型化 EventBus 实例 ────────────────────────────────────

export const eventBus = mitt<AppEvents>();
