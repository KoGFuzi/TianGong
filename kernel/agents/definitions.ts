import type { AgentConfig, AgentEnhancements } from './types.ts';
import { plannerAgent } from './planner.ts';
import { researchAgent } from './research.ts';
import { builderAgent } from './builder.ts';
import { operatorAgent } from './operator.ts';

export { plannerAgent, researchAgent, builderAgent, operatorAgent };

export const plannerEnhancements: AgentEnhancements = {
  guideRefs: [],
};

export const researchEnhancements: AgentEnhancements = {
  guideRefs: [],
};

export const builderEnhancements: AgentEnhancements = {
  guideRefs: [],
};

export const operatorEnhancements: AgentEnhancements = {
  guideRefs: [],
};

