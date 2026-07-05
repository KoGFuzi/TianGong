import type { AgentConfig, AgentEnhancements } from './types.ts';
import { plannerAgent } from './planner.ts';
import { researchAgent } from './research.ts';
import { builderAgent } from './builder.ts';
import { operatorAgent } from './operator.ts';

export { plannerAgent, researchAgent, builderAgent, operatorAgent };

export const plannerEnhancements: AgentEnhancements = {
  guideRefs: [],
  chainRefs: [],
  toolPreferences: ['handoff_to_agent'],
};

export const researchEnhancements: AgentEnhancements = {
  guideRefs: [],
  chainRefs: [],
  toolPreferences: ['web_search'],
};

export const builderEnhancements: AgentEnhancements = {
  guideRefs: [],
  chainRefs: [],
  toolPreferences: ['mcp', 'write_to_workspace'],
};

export const operatorEnhancements: AgentEnhancements = {
  guideRefs: [],
  chainRefs: [],
  toolPreferences: ['mcp', 'execute_bash', 'execute_workspace_script'],
};

