import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { mcpClient } from '../tool/mcp/client.ts';
import { mcpLifecycle } from '../tool/mcp/lifecycle.ts';
import { getConfig } from '../config/config.ts';

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
      .filter(e => e.isFile() && (e.name.endsWith('.ts') || e.name.endsWith('.tsx')))
      .map(e => e.name);
    if (skills.length === 0) {
      return '暂无可用 skill';
    }
    const lines = [`可用 skill (${skills.length}):`];
    for (const s of skills) {
      lines.push(`  - ${s.replace(/\.(ts|tsx)$/, '')}`);
    }
    return lines.join('\n');
  } catch {
    return '暂无可用 skill';
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
