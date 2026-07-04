export type ModelProvider = 'openai' | 'anthropic' | 'deepseek' | 'custom';

const PROVIDER_ENV_KEYS: Record<ModelProvider, readonly string[]> = {
  openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  custom: ['CUSTOM_API_KEY', 'OPENAI_API_KEY'], // custom 回退到 OPENAI_API_KEY
};

export class KeyManager {
  private cache: Map<string, string> = new Map();

  getKey(provider: ModelProvider): string {
    const cached = this.cache.get(provider);
    if (cached != null) return cached;

    const envKeys = PROVIDER_ENV_KEYS[provider];
    if (envKeys == null) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    for (const envKey of envKeys) {
      const value = process.env[envKey];
      if (value != null && value.length > 0) {
        this.cache.set(provider, value);
        return value;
      }
    }

    throw new Error(`No API key found for provider "${provider}". Set ${envKeys.join(' or ')} environment variable.`);
  }

  hasKey(provider: ModelProvider): boolean {
    try {
      this.getKey(provider);
      return true;
    } catch {
      return false;
    }
  }

  getProviderForModel(modelId: string): ModelProvider {
    if (modelId.startsWith('claude-')) return 'anthropic';
    if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) return 'openai';
    if (modelId.startsWith('deepseek-')) return 'deepseek';
    return 'custom';
  }
}

export const keyManager = new KeyManager();
