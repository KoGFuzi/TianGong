import type { AgentConfig, AgentEnhancements } from './types.ts';
import { getConfig } from '../../config/config.ts';
import { plannerAgent, researchAgent, builderAgent, operatorAgent, plannerEnhancements, researchEnhancements, builderEnhancements, operatorEnhancements } from './definitions.ts';

export const agentRegistry: Readonly<Record<string, AgentConfig>> = {
  planner: plannerAgent,
  research: researchAgent,
  builder: builderAgent,
  operator: operatorAgent,
} as const;

export function getAgent(id: string): AgentConfig {
  const base = agentRegistry[id];
  if (base == null) {
    throw new Error(`Agent not found: ${id}`);
  }
  const overrides = getConfig().llm.agents[id];
  if (overrides != null) {
    return {
      ...base,
      modelId: overrides.modelId,
      subscription: overrides.subscription,
      thinkingLevel: overrides.thinkingLevel,
    };
  }
  return base;
}

export { type AgentConfig, type AgentEnhancements } from './types.ts';

const enhancementsRegistry: Readonly<Record<string, AgentEnhancements>> = {
  planner: plannerEnhancements,
  research: researchEnhancements,
  builder: builderEnhancements,
  operator: operatorEnhancements,
} as const;

export function getEnhancements(agentId: string): AgentEnhancements {
  const enhancements = enhancementsRegistry[agentId];
  if (enhancements == null) {
    return { guideRefs: [], chainRefs: [], toolPreferences: [] };
  }
  return enhancements;
}
