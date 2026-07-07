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
  return Math.ceil(text.length / 4);
}
