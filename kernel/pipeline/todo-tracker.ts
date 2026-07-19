/**
 * TODO 追踪器 — 从 Agent 回复中提取并维护结构化任务列表。
 *
 * 匹配格式：
 * - [x] 已完成的任务
 * - [ ] 未完成的任务
 */
export class TODOTracker {
  private tasks: Array<{ text: string; done: boolean }> = [];

  /**
   * 从文本中提取 TODO 列表。
   * 匹配 "- [x] ..." 和 "- [ ] ..." 格式。
   * 返回提取到的条目文本列表（不含标记前缀）。
   */
  extractTODOFromText(text: string): string[] {
    const regex = /- \[([ xX])\] (.+)/g;
    const items: string[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      items.push(match[2]);
    }

    return items;
  }

  /**
   * 用新提取的 TODO 列表更新内部状态。
   * 直接替换整个任务列表（Planner 每次输出的是完整的当前 TODO 状态快照）。
   */
  updateTODO(items: Array<{ text: string; done: boolean }>): void {
    this.tasks = [...items];
  }

  /**
   * 输出格式化的 TODO 状态字符串，用于注入消息上下文。
   */
  getFormattedTODO(): string {
    if (this.tasks.length === 0) return '';

    const lines = this.tasks.map((t) => {
      const mark = t.done ? 'x' : ' ';
      return `- [${mark}] ${t.text}`;
    });

    return `[当前任务追踪]\n${lines.join('\n')}`;
  }

  /** 获取未完成的任务列表 */
  getActiveTasks(): string[] {
    return this.tasks.filter((t) => !t.done).map((t) => t.text);
  }

  /** 获取所有任务（含已完成） */
  getAllTasks(): Array<{ text: string; done: boolean }> {
    return [...this.tasks];
  }

  /** 重置追踪器 */
  reset(): void {
    this.tasks = [];
  }

  /** 从已保存的数据恢复 */
  restore(tasks: Array<{ text: string; done: boolean }>): void {
    this.tasks = [...tasks];
  }
}
