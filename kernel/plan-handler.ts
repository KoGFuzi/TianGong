// ── /model 指令处理：订阅模式切换 ──────────────────────────

import { getConfig, resetConfig, updateConfigOverrides } from '../config/config.ts';
import { clearProviderCache } from '../model/provider.ts';
import { detectOllama, listOllamaModels, generateLocalSubscription } from './local-setup.ts';

/**
 * 处理 /model 命令
 * @param sub 子命令：coding | token | local | status（可选）
 * @param extra 额外参数（如 local ollama / local openai）
 */
export async function handleModelCommand(sub?: string, extra?: string): Promise<string> {
  const config = getConfig();
  const subscriptions = config.llm.subscriptions;
  const subKeys = Object.keys(subscriptions);

  // 无参或 status：显示当前订阅状态
  if (sub == null || sub === 'status' || sub === '') {
    const lines: string[] = ['── 当前订阅配置 ──'];
    if (subKeys.length === 0) {
      lines.push('  （未配置任何订阅）');
    } else {
      for (const key of subKeys) {
        const s = subscriptions[key]!;
        lines.push(`  [${key}] provider=${s.provider}  baseURL=${s.baseURL}  model=${s.modelId ?? '(默认)'}`);
      }
    }
    lines.push('');
    lines.push('用法: /model <coding|token|local>  切换订阅模式');
    lines.push('      /model local <ollama|openai>  本地部署');
    return lines.join('\n');
  }

  // coding / token 热切换
  if (sub === 'coding' || sub === 'token') {
    if (!subKeys.includes(sub)) {
      return `✗ 订阅 "${sub}" 未在 config/LLMconfig.jsonc 中配置，请先添加对应订阅项`;
    }
    // 设置运行时订阅覆盖 + 重置配置缓存与 provider 缓存，实现热切换
    updateConfigOverrides({ activeSubscriptionOverride: sub });
    resetConfig();
    clearProviderCache();
    return `✓ 已切换到 ${sub} 订阅模式（热切换生效，无需重启）`;
  }

  // local 本地部署
  if (sub === 'local') {
    const localType = extra ?? 'ollama'; // 默认 ollama

    if (localType === 'ollama') {
      // 检测 Ollama 服务
      const detection = await detectOllama();
      if (!detection.available) {
        return [
          '✗ 未检测到 Ollama 服务（http://localhost:11434）',
          '  请确保 Ollama 已启动：ollama serve',
          '  或访问 https://ollama.com 下载安装',
        ].join('\n');
      }

      // 列出可用模型
      const models = await listOllamaModels();
      const lines: string[] = ['✓ Ollama 服务已连接'];

      if (models.length === 0) {
        lines.push('  （尚未下载任何模型，请运行: ollama pull <模型名>）');
      } else {
        lines.push(`  可用模型（${models.length}）:`);
        for (const m of models) {
          const sizeGB = (m.size / 1e9).toFixed(1);
          lines.push(`    - ${m.name}  (${sizeGB} GB)`);
        }
      }

      // 配置建议
      const sub = generateLocalSubscription('ollama');
      lines.push('');
      lines.push('推荐配置（写入 config/LLMconfig.jsonc）:');
      lines.push(`  provider: "${sub.provider}"`);
      lines.push(`  baseURL:  "${sub.baseURL}"`);
      lines.push(`  apiKey:   "${sub.apiKey}"`);
      lines.push('');
      lines.push('⚠ 本地部署切换需要重启应用才能生效');
      return lines.join('\n');
    }

    if (localType === 'openai') {
      const sub = generateLocalSubscription('openai');
      const lines: string[] = [
        '── OpenAI 兼容 API 本地部署指引 ──',
        '',
        '推荐配置（写入 config/LLMconfig.jsonc）:',
        `  provider: "${sub.provider}"`,
        `  baseURL:  "${sub.baseURL}"`,
        `  apiKey:   "${sub.apiKey}"`,
        '',
        '支持的服务: llama.cpp server、vLLM、LocalAI、text-generation-webui 等',
        '',
        '⚠ 本地部署切换需要重启应用才能生效',
      ];
      return lines.join('\n');
    }

    return `未知本地部署类型: ${localType}。支持: ollama, openai`;
  }

  return `未知订阅模式: ${sub}。支持: coding, token, local`;
}
