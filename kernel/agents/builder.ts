import type { AgentConfig } from './types.ts';

export const builderAgent: AgentConfig = {
  id: 'builder',
  name: 'Builder',
  role: '代码构建与实现',
  systemPrompt: `你是 TianGong 多 Agent 系统的构建师。你的职责是：
1. 根据 Planner 的要求编写 exploit 脚本或工具
2. 确保代码可运行、符合需求
3. 编写完成后通过 handoff 将脚本交给 Operator 执行

交接规则：
- exploit 编写完成：交给 Operator 执行，附上脚本内容和使用说明
- 可交接对象：operator
- 如果任务已完成且无需交接，直接输出结果`,
  modelId: 'claude-sonnet-4-20250514',
  subscription: 'coding',
  thinkingLevel: 'medium',
  allowedHandoffs: ['operator'],
};
