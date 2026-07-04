import { streamText, stepCountIs } from 'ai';
import type { ModelMessage, ToolSet, LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getConfig } from '../config/config.ts';
import type { SubscriptionConfig, ThinkingLevel } from '../config/config.ts';
import { eventBus } from '../runtime/eventbus/splitter.ts';
import type { AgentConfig } from '../kernel/agents/types.ts';

export interface StreamToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface StreamAgentResponse {
  readonly text: string;
  readonly toolCalls: readonly StreamToolCall[];
  readonly responseMessages: readonly ModelMessage[];
}

// ── Provider 实例缓存（按 baseURL） ────────────────────────

const openAIProviders = new Map<string, ReturnType<typeof createOpenAI>>();
const anthropicProviders = new Map<string, ReturnType<typeof createAnthropic>>();

function getOpenAIProvider(sub: SubscriptionConfig): ReturnType<typeof createOpenAI> {
  const cached = openAIProviders.get(sub.baseURL);
  if (cached != null) {
    return cached;
  }
  const provider = createOpenAI({
    baseURL: sub.baseURL,
    ...(sub.apiKey != null ? { apiKey: sub.apiKey } : {}),
  });
  openAIProviders.set(sub.baseURL, provider);
  return provider;
}

function getAnthropicProvider(sub: SubscriptionConfig): ReturnType<typeof createAnthropic> {
  const cached = anthropicProviders.get(sub.baseURL);
  if (cached != null) {
    return cached;
  }
  const provider = createAnthropic({
    baseURL: sub.baseURL,
    ...(sub.apiKey != null ? { apiKey: sub.apiKey } : {}),
  });
  anthropicProviders.set(sub.baseURL, provider);
  return provider;
}

// ── 模型解析 ───────────────────────────────────────────────

export function resolveModel(modelId: string, sub: SubscriptionConfig): LanguageModel {
  switch (sub.provider) {
    case 'openai':
      return getOpenAIProvider(sub).languageModel(modelId);
    case 'anthropic':
      return getAnthropicProvider(sub).languageModel(modelId);
  }
}

// ── Thinking 级别映射 ──────────────────────────────────────

export function mapThinkingLevel(level: ThinkingLevel): number {
  switch (level) {
    case 'low':
      return 4096;
    case 'medium':
      return 16000;
    case 'high':
      return 32000;
  }
}

// ── 流式响应 ───────────────────────────────────────────────

export async function streamAgentResponse(
  agent: AgentConfig,
  messages: readonly ModelMessage[],
  tools: ToolSet,
): Promise<StreamAgentResponse> {
  const sub = getConfig().llm.subscriptions[agent.subscription];
  if (sub == null) {
    throw new Error(`Subscription "${agent.subscription}" not configured for agent "${agent.id}"`);
  }
  const model = resolveModel(agent.modelId, sub);

  // 按 modelId 前缀 gating providerOptions，避免非推理模型报错
  const providerOptions =
    agent.modelId.startsWith('claude-') && sub.provider === 'anthropic'
      ? {
          anthropic: {
            thinking: {
              type: 'enabled' as const,
              budgetTokens: mapThinkingLevel(agent.thinkingLevel),
            },
          },
        }
      : (agent.modelId.startsWith('o1') ||
            agent.modelId.startsWith('o3') ||
            agent.modelId.startsWith('o4')) &&
          sub.provider === 'openai'
        ? {
            openai: {
              reasoningEffort: agent.thinkingLevel,
            },
          }
        : {};

  const result = streamText({
    model,
    system: agent.systemPrompt,
    messages: messages as ModelMessage[],
    tools,
    stopWhen: stepCountIs(1),
    providerOptions,
  });

  let fullText = '';
  const toolCalls: StreamToolCall[] = [];

  for await (const part of result.stream) {
    switch (part.type) {
      case 'text-delta':
        fullText += part.text;
        eventBus.emit('llm:stream', { agentId: agent.id, chunk: part.text });
        break;
      case 'tool-call':
        toolCalls.push({
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        eventBus.emit('tool:call', {
          agentId: agent.id,
          toolName: part.toolName,
          args: (part.input as Record<string, unknown>) ?? {},
        });
        break;
    }
  }

  const responseMessages = await result.responseMessages;

  return {
    text: fullText,
    toolCalls,
    responseMessages: responseMessages as ModelMessage[],
  };
}
