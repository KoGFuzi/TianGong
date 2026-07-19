import { streamText, generateText, stepCountIs } from 'ai';
import type { ModelMessage, ToolSet, LanguageModel } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { getConfig, LOCAL_PROVIDER_PRESETS } from '../config/config.ts';
import type { SubscriptionConfig, ThinkingLevel } from '../config/config.ts';
import { eventBus } from '../runtime/eventbus/splitter.ts';
import { loadGuides } from '../runtime/memory/guides/index.ts';
import type { AgentConfig } from '../kernel/agents/types.ts';
import { getEnhancements } from '../kernel/agents/index.ts';

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
      // 使用 .chat() 走 Chat Completions API (/chat/completions)，
      // 而非 .languageModel() 默认的 Responses API (/responses)，兼容第三方厂商
      return getOpenAIProvider(sub).chat(modelId);
    case 'anthropic':
      return getAnthropicProvider(sub).languageModel(modelId);
    case 'ollama':
    case 'lm-studio': {
      // 本地模型：使用 OpenAI 兼容协议，baseURL 取配置值或预设默认值
      const preset = LOCAL_PROVIDER_PRESETS[sub.provider];
      const effectiveSub = { ...sub, baseURL: sub.baseURL || preset.baseURL };
      return getOpenAIProvider(effectiveSub).chat(modelId);
    }
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
  overrideSystemPrompt?: string,
): Promise<StreamAgentResponse> {
  const sub = getConfig().llm.subscriptions[agent.subscription];
  if (sub == null) {
    throw new Error(`Subscription "${agent.subscription}" not configured for agent "${agent.id}"`);
  }
  const model = resolveModel(agent.modelId, sub);

  // 注入 guide 内容到 systemPrompt
  const enhancements = getEnhancements(agent.id);
  const guideContent = loadGuides(enhancements.guideRefs);
  const basePrompt = overrideSystemPrompt ?? agent.systemPrompt;
  const systemPrompt = guideContent.length > 0
    ? `${basePrompt}\n\n---\n\n# 流程指南\n\n${guideContent}`
    : basePrompt;

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
    system: systemPrompt,
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

// ── 对话摘要生成 ────────────────────────────────────────────

/**
 * 使用非流式调用生成对话摘要。
 * 内部通过 getConfig() + resolveModel() 解析模型：
 * 优先使用 context.summaryModel 配置的轻量模型，
 * 若未配置则回退到指定 subscription 的模型。
 */
export async function generateSummary(
  messages: readonly ModelMessage[],
  subscription?: string,
): Promise<string> {
  const config = getConfig();

  // 解析模型：优先 summaryModel，否则用 subscription 对应的模型
  let modelId: string;
  let sub: SubscriptionConfig;

  if (config.context.summaryModel != null) {
    modelId = config.context.summaryModel;
    const subKey = subscription ?? 'coding';
    const resolved = config.llm.subscriptions[subKey];
    if (resolved == null) {
      throw new Error(`Subscription "${subKey}" not found for summary model resolution`);
    }
    sub = resolved;
  } else {
    const subKey = subscription ?? 'coding';
    const resolved = config.llm.subscriptions[subKey];
    if (resolved == null) {
      throw new Error(`Subscription "${subKey}" not found for summary`);
    }
    modelId = resolved.modelId ?? config.llm.defaultModel;
    sub = resolved;
  }

  const model = resolveModel(modelId, sub);

  // 提取消息中的文本内容（跳过 tool 消息的 JSON）
  const textParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        textParts.push(`[${msg.role}]: ${msg.content}`);
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === 'object' && part !== null && 'type' in part) {
            if (part.type === 'text') {
              textParts.push(`[${msg.role}]: ${(part as { text: string }).text}`);
            }
          }
        }
      }
    }
  }

  const conversationText = textParts.join('\n');

  const result = await generateText({
    model,
    system: `你是一个对话摘要生成器。请将以下对话历史压缩为一段结构化摘要。
摘要必须包含以下部分：
- [已完成] 已经完成的任务和操作
- [关键发现] 重要的发现、结果或数据
- [待处理] 尚未完成或需要继续的任务
- [重要决策] 做出的关键决策和原因

要求：简洁、信息密度高，不超过 500 字。直接输出摘要内容，不要加额外说明。`,
    prompt: `请摘要以下对话历史：\n\n${conversationText}`,
    maxTokens: 800,
  });

  return result.text;
}
