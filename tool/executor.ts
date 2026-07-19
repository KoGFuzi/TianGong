import { getShell, writeFile as wsWriteFile, executeScript as wsExecuteScript } from '../runtime/workspace/index.ts';
import { executeWebSearch } from './local/web-search.ts';
import { executeScriptTool, getScriptToolNames } from './local/script-loader.ts';
import { allToolDefinitions } from './registry.ts';
import { mcpClient } from './mcp/client.ts';
import { getConfig } from '../config/config.ts';

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
}

const EXECUTE_TIMEOUT_MS = 10_000;

/**
 * 检查指定 Agent 是否有权调用指定工具。
 * - 本地工具：从 ToolDefinition.allowedAgents 检查（空数组表示所有 Agent 可用）
 * - MCP 工具（mcp_ 前缀）：允许所有 Agent
 */
export function checkPermission(toolName: string, agentId: string): boolean {
  // MCP 工具：允许所有 Agent
  if (toolName.startsWith('mcp_')) {
    return true;
  }
  // 本地工具：查找 ToolDefinition
  const toolDef = allToolDefinitions.find(d => d.name === toolName);
  if (toolDef == null) {
    // 未知工具（如 task_complete 等内置工具）放行
    return true;
  }
  // allowedAgents 为空数组表示不限制
  if (toolDef.allowedAgents.length === 0) {
    return true;
  }
  return toolDef.allowedAgents.includes(agentId);
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string = 'default',
  agentId?: string,
): Promise<ToolExecutionResult> {
  // 鉴权：如果提供了 agentId，先检查权限
  if (agentId != null && !checkPermission(toolName, agentId)) {
    return { success: false, error: `Permission denied: agent "${agentId}" is not allowed to use tool "${toolName}"` };
  }

  // MCP 工具路由：检测 mcp_ 前缀，转发到 MCP client
  if (toolName.startsWith('mcp_')) {
    return mcpClient.callTool(toolName, args);
  }

  switch (toolName) {
    case 'execute_bash':
      return executeBash(args.command as string);
    case 'write_to_workspace':
      return writeToWorkspace(sessionId, args.filename as string, args.content as string);
    case 'execute_workspace_script':
      return executeWorkspaceScript(sessionId, args.filename as string, (args.args as string[]) ?? []);
    case 'web_search':
      return executeWebSearch(args.query as string);
    case 'task_complete':
      return { success: true, output: `任务已完成。摘要: ${args.summary as string}` };
    default:
      // 脚本工具（.py 等）：在动态加载的脚本工具中查找
      if (getScriptToolNames().has(toolName)) {
        return executeScriptTool(toolName, args);
      }
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

async function executeBash(command: string): Promise<ToolExecutionResult> {
  if (!command || command.trim().length === 0) {
    return { success: false, error: 'Empty command' };
  }

  // ── 安全校验：黑名单 + 白名单模式 ──
  const { blockedCommands, allowedCommands } = getConfig().security;
  const trimmedCmd = command.trim();

  // 解析命令的第一个词作为命令名
  const cmdName = trimmedCmd.split(/\s+/)[0] ?? '';

  // 黑名单：包含匹配
  for (const pattern of blockedCommands) {
    if (pattern.length > 0 && trimmedCmd.includes(pattern)) {
      return {
        success: false,
        error: `Command rejected: "${trimmedCmd}" matched blocked pattern "${pattern}". ` +
          `Fix: remove or replace the dangerous subcommand "${pattern}" with a safe alternative.`,
      };
    }
  }

  // 白名单：如果 allowedCommands 非空，命令名必须在列表中
  if (allowedCommands.length > 0 && !allowedCommands.includes(cmdName)) {
    return {
      success: false,
      output: `Command blocked: "${cmdName}" is not in the allowed commands list. Allowed: ${allowedCommands.join(', ')}`,
    };
  }

  try {
    const [shell, shellFlag] = getShell();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);
    const proc = Bun.spawn({
      cmd: [shell, shellFlag, command],
      stdout: 'pipe',
      stderr: 'pipe',
      signal: controller.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeoutId);
    if (exitCode !== 0) {
      return { success: false, output: stdout, error: `Command exited with code ${exitCode}.\nstderr: ${stderr}\nstdout: ${stdout}` };
    }
    return { success: true, output: stdout || '(no output)' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: `Command timed out after ${EXECUTE_TIMEOUT_MS / 1000}s. Command: ${command}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to execute command: ${errorMsg}` };
  }
}

async function writeToWorkspace(sessionId: string, filename: string, content: string): Promise<ToolExecutionResult> {
  const result = await wsWriteFile(sessionId, filename, content);
  if (!result.safe) return { success: false, error: result.error };
  return { success: true, output: `File "${filename}" written successfully to workspace (${content.length} bytes).` };
}

async function executeWorkspaceScript(sessionId: string, filename: string, args: string[]): Promise<ToolExecutionResult> {
  return wsExecuteScript(sessionId, filename, args);
}
