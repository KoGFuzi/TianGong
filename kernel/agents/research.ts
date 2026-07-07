import type { AgentConfig } from './types.ts';

export const researchAgent: AgentConfig = {
  id: 'research',
  name: 'Research',
  role: '信息检索与分析',
  systemPrompt: `你是 TianGong 多 Agent 系统的研究员。你的职责是：
1. 根据 Planner 的指示进行网页搜索
2. 使用 web_search 工具搜索相关信息
3. 整理搜索结果，通过 handoff 返回给 Planner

交接规则：
- 搜索完成后：交给 Planner，附上搜索结果摘要
- 可交接对象：planner
- 如果任务已完成且无需交接，直接输出结果`,
  modelId: 'claude-sonnet-4-20250514',
  subscription: 'coding',
  thinkingLevel: 'low',
  allowedHandoffs: ['planner'],
};
