import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { mcpClient } from '../tool/mcp/client.ts';
import { mcpLifecycle } from '../tool/mcp/lifecycle.ts';
import { getConfig } from '../config/config.ts';
import { agentRegistry } from './agents/index.ts';
import { setRuntimeOverride, getAllRuntimeOverrides } from './runtime-overrides.ts';
import { SessionManager } from '../runtime/session/manager.ts';
import { estimateMessagesTokens } from '../runtime/budget/index.ts';

// ===== 交互命令处理函数（共享模块）=====

export async function handleMcpCommand(sub?: string): Promise<string> {
  switch (sub) {
    case 'status': {
      if (mcpClient.isConnected()) {
        const tools = mcpClient.getTools();
        const lines = [`✓ MCP 已连接（${tools.length} 个工具可用）`];
        if (mcpLifecycle.isRunning()) {
          lines.push('  健康检查: 运行中');
        }
        return lines.join('\n');
      }
      return '✗ MCP 未连接';
    }
    case 'disconnect': {
      await mcpLifecycle.shutdown();
      return '✓ MCP 已断开';
    }
    case 'reconnect': {
      const servers = getConfig().mcp.servers;
      if (servers.length === 0) {
        return '✗ 未配置 MCP 服务器，请先在 config/mcp.jsonc 中配置';
      }
      console.log(`正在重新连接 ${servers.length} 个 MCP 服务器...`);
      try {
        await mcpLifecycle.start(servers);
        return '✓ MCP 重连完成';
      } catch (err) {
        return `✗ MCP 重连失败: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    case 'tools': {
      const tools = mcpClient.getTools();
      if (tools.length === 0) {
        return '暂无可用 MCP 工具';
      }
      const lines = [`可用 MCP 工具 (${tools.length}):`];
      for (const t of tools) {
        lines.push(`  - ${t.name}: ${t.description || '(无描述)'}`);
      }
      return lines.join('\n');
    }
    default:
      return 'MCP 子命令: status, disconnect, reconnect, tools\n用法: /mcp <子命令>';
  }
}

export function handleSkillCommand(): string {
  const skillDir = join(process.cwd(), 'skill');
  try {
    const entries = readdirSync(skillDir, { withFileTypes: true });
    const skills = entries
      .filter(e => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx') || e.name.endsWith('.md')))
      .map(e => e.name);
    if (skills.length === 0) {
      return '暂无可用 skill';
    }
    const lines = [`可用 skill (${skills.length}):`];
    for (const s of skills) {
      lines.push(`  - ${s.replace(/\.(ts|tsx|md)$/, '')}`);
    }
    return lines.join('\n');
  } catch {
    return '暂无可用 skill';
  }
}

// ===== /model 命令：运行时订阅切换 =====

export function handleModelCommand(args: string[]): string {
  const config = getConfig();
  const subKeys = Object.keys(config.llm.subscriptions);
  const agentIds = Object.keys(agentRegistry);
  const allOverrides = getAllRuntimeOverrides();

  // /model — 显示所有 agent 当前模型配置
  if (args.length === 0) {
    const lines = ['当前模型配置:'];
    for (const id of agentIds) {
      const override = allOverrides.get(id);
      const configOverride = config.llm.agents[id];
      const sub = override?.subscription ?? configOverride?.subscription ?? '(默认)';
      const model = override?.modelId ?? configOverride?.modelId ?? '(默认)';
      const subInfo = config.llm.subscriptions[sub];
      const provider = subInfo?.provider ?? '未配置';
      const isOverridden = override != null ? ' [运行时覆盖]' : '';
      lines.push(`  ${id}: subscription=${sub} (${provider}), model=${model}${isOverridden}`);
    }
    lines.push('');
    lines.push(`可用订阅: ${subKeys.length > 0 ? subKeys.join(', ') : '(无)'}`);
    lines.push('用法: /model <agent> <subscription> [modelId]');
    return lines.join('\n');
  }

  // /model <agent> <subscription> [modelId]
  if (args.length < 2) {
    return '用法: /model <agent> <subscription> [modelId]\n示例: /model planner token\n示例: /model builder local qwen2.5:7b';
  }

  const [agentId, subKey, modelId] = args;

  // 校验 agent
  if (!agentIds.includes(agentId!)) {
    return `未知 Agent: ${agentId}\n可用: ${agentIds.join(', ')}`;
  }

  // 校验 subscription
  if (!subKeys.includes(subKey!)) {
    return `未知订阅: ${subKey}\n可用: ${subKeys.join(', ')}`;
  }

  // 应用覆盖
  const override: { subscription: string; modelId?: string } = { subscription: subKey! };
  if (modelId != null && modelId.length > 0) {
    override.modelId = modelId;
  }
  setRuntimeOverride(agentId!, override);

  const subInfo = config.llm.subscriptions[subKey!];
  const lines = [`✓ ${agentId} 已切换:`];
  lines.push(`  subscription: ${subKey} (${subInfo?.provider ?? '未知'})`);
  if (override.modelId != null) {
    lines.push(`  model: ${override.modelId}`);
  }
  return lines.join('\n');
}

// ===== /session 命令：会话状态查看 =====

export function handleSessionCommand(
  args: string[],
  sessionId?: string,
  currentState?: { messages: unknown[]; stepCount: number; todoList?: Array<{ text: string; done: boolean }> },
): string {
  const dbPath = resolve(__dirname, '../runtime/memory/tiangong.db');
  const sessionManager = new SessionManager(dbPath);

  try {
    const sub = args[0];
    switch (sub) {
      case 'status': {
        if (sessionId == null || currentState == null) {
          return '当前没有活跃的会话';
        }
        const tokenCount = estimateMessagesTokens(currentState.messages as any);
        const lines = [
          `会话 ID: ${sessionId}`,
          `消息数: ${currentState.messages.length}`,
          `步骤数: ${currentState.stepCount}`,
          `估算 Token: ${tokenCount}`,
          `上下文窗口: ${getConfig().context.contextWindow}`,
          `Token 占比: ${((tokenCount / getConfig().context.contextWindow) * 100).toFixed(1)}%`,
        ];
        if (currentState.todoList != null && currentState.todoList.length > 0) {
          const done = currentState.todoList.filter(t => t.done).length;
          lines.push(`TODO: ${done}/${currentState.todoList.length} 已完成`);
        }
        return lines.join('\n');
      }
      case 'summary': {
        if (sessionId == null) return '当前没有活跃的会话';
        const summary = sessionManager.getSessionSummary(sessionId);
        if (summary == null) return '当前会话暂无摘要（Token 使用未达到阈值，尚未触发自动摘要）';
        return `当前会话摘要:\n${summary}`;
      }
      case 'todo': {
        if (currentState?.todoList == null || currentState.todoList.length === 0) {
          return '当前没有 TODO 任务';
        }
        const lines = currentState.todoList.map(t => {
          const mark = t.done ? 'x' : ' ';
          return `- [${mark}] ${t.text}`;
        });
        return `当前 TODO 列表:\n${lines.join('\n')}`;
      }
      case 'list': {
        const sessions = sessionManager.listSessions();
        if (sessions.length === 0) return '暂无历史会话';
        const lines = [`历史会话 (${sessions.length}):`];
        for (const s of sessions) {
          lines.push(`  ${s.id}  消息: ${s.messageCount}  步骤: ${s.stepCount}`);
        }
        return lines.join('\n');
      }
      default:
        return [
          '/session 子命令:',
          '  status  — 显示当前会话 Token 用量、消息数、TODO 状态',
          '  summary — 显示当前摘要内容',
          '  todo    — 显示当前 TODO 列表',
          '  list    — 列出所有历史会话',
          '用法: /session <子命令>',
        ].join('\n');
    }
  } finally {
    sessionManager.close();
  }
}

// ===== 清理（共享）=====

export async function cleanup(): Promise<void> {
  try {
    await Promise.race([
      mcpLifecycle.shutdown(),
      new Promise<void>(resolve => setTimeout(resolve, 2000)),
    ]);
  } catch { /* ignore */ }
}

// ===== MCP 初始化（共享）=====

export async function initializeMcp(): Promise<string> {
  const servers = getConfig().mcp.servers;
  if (servers.length === 0) {
    return '[MCP] 未配置 MCP 服务器，跳过初始化';
  }
  try {
    await mcpLifecycle.start(servers);
    return `[MCP] 初始化完成（${servers.length} 个服务器）`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `[MCP] 初始化失败: ${msg}\n[MCP] 提示: 请检查 config/mcp.jsonc 中的服务器地址是否正确、服务器是否已启动`;
  }
}
