/**
 * 运行时模型/订阅覆盖表
 * 供 /model 命令写入、getAgent 读取，解除 commands ↔ agents 循环依赖。
 */

interface RuntimeOverride {
  subscription: string;
  modelId?: string;
}

const runtimeOverrides = new Map<string, RuntimeOverride>();

export function getRuntimeOverride(agentId: string): RuntimeOverride | undefined {
  return runtimeOverrides.get(agentId);
}

export function setRuntimeOverride(agentId: string, override: RuntimeOverride): void {
  runtimeOverrides.set(agentId, override);
}

export function getAllRuntimeOverrides(): ReadonlyMap<string, RuntimeOverride> {
  return runtimeOverrides;
}
