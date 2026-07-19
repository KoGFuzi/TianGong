import type { ModelMessage } from 'ai';
import { estimateMessagesTokens } from '../../runtime/budget/index.ts';
import { getConfig } from '../../config/config.ts';
import { generateSummary } from '../../model/provider.ts';

/**
 * 检查消息列表是否需要触发摘要压缩。
 * 当消息 Token 数超过 contextWindow * summaryThreshold 时返回 true。
 */
export function shouldSummarize(messages: readonly ModelMessage[]): boolean {
  const config = getConfig();
  const tokenCount = estimateMessagesTokens(messages);
  const threshold = config.context.contextWindow * config.context.summaryThreshold;
  return tokenCount > threshold;
}

/**
 * 生成消息列表的结构化摘要。
 * 内部调用 generateSummary，可指定 subscription。
 */
export async function summarizeMessages(
  messages: readonly ModelMessage[],
  subscription?: string,
): Promise<string> {
  try {
    return await generateSummary(messages, subscription);
  } catch {
    // 降级：简单拼接
    const parts: string[] = [];
    for (let i = 0; i < messages.length; i += 5) {
      const msg = messages[i];
      if (msg) {
        const text = typeof msg.content === 'string' ? msg.content.slice(0, 100) : `[${msg.role}消息]`;
        parts.push(text);
      }
    }
    return `早期对话概要：${parts.join('；')}`;
  }
}

/**
 * 对消息列表生成摘要并压缩。
 * 保留头部（第1条user消息）+ 摘要 + 尾部（最近slidingWindowSize轮）。
 * LLM调用失败时降级为简单拼接。
 */
export async function compactMessagesWithSummary(
  messages: ModelMessage[],
  precomputedSummary?: string,
): Promise<ModelMessage[]> {
  const config = getConfig();
  const windowSize = config.context.slidingWindowSize;

  // 头部：第1条 user 消息
  const headMessages: ModelMessage[] = [];
  if (messages.length > 0 && messages[0]!.role === 'user') {
    headMessages.push(messages[0]!);
  }

  // 尾部：最近 windowSize * 2 条消息
  const tailCount = windowSize * 2;
  const tailStart = Math.max(headMessages.length, messages.length - tailCount);
  const tailMessages = messages.slice(tailStart);

  if (tailStart <= headMessages.length) {
    return messages;
  }

  const middleMessages = messages.slice(headMessages.length, tailStart);

  // 使用预计算摘要或尝试 LLM 摘要
  let summaryText: string;
  if (precomputedSummary != null) {
    summaryText = precomputedSummary;
  } else {
    try {
      summaryText = await generateSummary(middleMessages);
    } catch {
      const parts: string[] = [];
      for (let i = 0; i < middleMessages.length; i += 5) {
        const msg = middleMessages[i];
        if (msg) {
          const text = typeof msg.content === 'string' ? msg.content.slice(0, 100) : `[${msg.role}消息]`;
          parts.push(text);
        }
      }
      summaryText = `早期对话概要：${parts.join('；')}`;
    }
  }

  return [
    ...headMessages,
    { role: 'user', content: `[历史摘要] ${summaryText}` } as ModelMessage,
    ...tailMessages,
  ];
}
