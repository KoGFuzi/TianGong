import type { ThinkingLevel } from '../../config/config.ts';

export interface AgentConfig {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly systemPrompt: string;
  readonly modelId: string;
  readonly subscription: string;
  readonly thinkingLevel: ThinkingLevel;
  readonly allowedHandoffs: readonly string[];
}

export interface AgentEnhancements {
  readonly guideRefs: readonly string[];
}

