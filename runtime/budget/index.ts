import type { ModelMessage } from 'ai';

export class BudgetManager {
  private readonly maxTokens: number;
  private readonly usageMap: Map<string, number> = new Map();

  constructor(maxTokens: number) {
    this.maxTokens = maxTokens;
  }

  checkBudget(sessionId: string): { allowed: boolean; usage?: number } {
    const usage = this.usageMap.get(sessionId) ?? 0;
    return {
      allowed: usage < this.maxTokens,
      usage,
    };
  }

  addUsage(sessionId: string, tokens: number): void {
    const current = this.usageMap.get(sessionId) ?? 0;
    this.usageMap.set(sessionId, current + tokens);
  }
}

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  let tokens = 0;
  // 匹配中文字符（含中日韩统一表意文字）
  const cjkChars = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) || []).length;
  // 剩余部分按英文处理（按空格分词）
  const nonCjkText = text.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ');
  const words = nonCjkText.split(/\s+/).filter(w => w.length > 0).length;

  // 中文字符约 1.5 token/字，英文单词约 1.3 token/word
  tokens = Math.ceil(cjkChars * 1.5 + words * 1.3);

  // 保底：不低于 text.length / 6（防止特殊字符导致过低估算）
  return Math.max(tokens, Math.ceil(text.length / 6));
}

/**
 * 估算消息列表的总 Token 数。
 * 遍历所有消息的 content，对字符串内容直接估算，
 * 对数组内容（含 tool-call/tool-result 等）序列化后估算。
 */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    // 每条消息有约 4 token 的角色/格式开销
    total += 4;
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else if (Array.isArray(msg.content)) {
      total += estimateTokens(JSON.stringify(msg.content));
    }
  }
  return total;
}
