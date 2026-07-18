// ── 本地部署支持：Ollama 检测与订阅配置生成 ──────────────

/**
 * 检测 Ollama 服务是否可用
 * @param baseURL Ollama API 地址，默认 http://localhost:11434
 */
export async function detectOllama(baseURL = 'http://localhost:11434'): Promise<{ available: boolean }> {
  try {
    const res = await fetch(`${baseURL}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { available: false };
    return { available: true };
  } catch {
    return { available: false };
  }
}

/**
 * 列出 Ollama 已下载的模型
 * @param baseURL Ollama API 地址，默认 http://localhost:11434
 */
export async function listOllamaModels(baseURL = 'http://localhost:11434'): Promise<{ name: string; size: number }[]> {
  try {
    const res = await fetch(`${baseURL}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json() as { models?: { name: string; size: number }[] };
    return (data.models ?? []).map(m => ({ name: m.name, size: m.size }));
  } catch {
    return [];
  }
}

/**
 * 生成本地部署的订阅配置
 * @param type 'ollama' | 'openai'
 * @param opts 可选覆盖参数
 */
export function generateLocalSubscription(
  type: 'ollama' | 'openai',
  opts?: { baseURL?: string; apiKey?: string; modelId?: string },
): { provider: 'openai'; baseURL: string; apiKey: string; modelId?: string } {
  if (type === 'ollama') {
    return {
      provider: 'openai',
      baseURL: opts?.baseURL ?? 'http://localhost:11434/v1',
      apiKey: opts?.apiKey ?? 'ollama',
      ...(opts?.modelId != null ? { modelId: opts.modelId } : {}),
    };
  }
  // openai 兼容 API
  return {
    provider: 'openai',
    baseURL: opts?.baseURL ?? 'http://localhost:8080/v1',
    apiKey: opts?.apiKey ?? 'local',
    ...(opts?.modelId != null ? { modelId: opts.modelId } : {}),
  };
}
