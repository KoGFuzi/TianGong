import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface McpToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpServerConfig {
  readonly name?: string;
  readonly type?: 'stdio' | 'sse';
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
}

const MCP_CALL_TIMEOUT_MS = 15_000;

interface ServerEntry {
  readonly client: Client;
  readonly tools: McpToolInfo[];
  readonly serverName: string;
}

interface ToolRoute {
  readonly serverName: string;
  readonly originalName: string;
}

class McpClientManager {
  /** 键为 serverName，值为该 server 的 client + 工具列表 */
  private readonly servers = new Map<string, ServerEntry>();
  /** 键为完整工具名 mcp_<serverName>_<toolName>，值为路由信息 */
  private readonly toolRoutes = new Map<string, ToolRoute>();
  private initPromise: Promise<void> | null = null;

  /**
   * 批量初始化所有 MCP server。
   * 单个 server 失败时静默跳过，不阻塞其他 server。
   * 若已有已连接的 server（重启场景），先断开旧连接再重新初始化。
   */
  async initializeAll(servers: readonly McpServerConfig[]): Promise<void> {
    // 重启场景：先清理旧连接，确保能重建
    if (this.servers.size > 0) {
      await this._cleanupAll();
    }
    // 防止并发初始化：等待进行中的初始化完成后再判断
    if (this.initPromise != null) {
      await this.initPromise.catch(() => {});
      if (this.servers.size > 0) return;
    }
    this.initPromise = this._doInitAll(servers);
    try {
      await this.initPromise;
    } catch {
      // 整体初始化失败，静默降级
    } finally {
      this.initPromise = null;
    }
  }

  /** 断开所有已连接的 MCP server 并清空路由表 */
  private async _cleanupAll(): Promise<void> {
    for (const entry of this.servers.values()) {
      try { await entry.client.close(); } catch { /* 忽略关闭失败 */ }
    }
    this.servers.clear();
    this.toolRoutes.clear();
  }

  private async _doInitAll(servers: readonly McpServerConfig[]): Promise<void> {
    // 并发初始化所有 server，单个失败不阻塞其他
    await Promise.allSettled(
      servers.map((server, index) => this._initOne(server, index)),
    );
  }

  private async _initOne(server: McpServerConfig, index: number): Promise<void> {
    const serverName = server.name ?? `server${index}`;
    if (this.servers.has(serverName)) return; // 同名 server 跳过

    try {
      const transport = server.type === 'sse' && server.url
        ? new SSEClientTransport(new URL(server.url))
        : new StdioClientTransport({
            command: server.command,
            args: [...server.args],
            ...(server.env != null ? { env: { ...server.env } } : {}),
          });

      const client = new Client({ name: `tiangong-${serverName}`, version: '1.0.0' });
      await client.connect(transport);
      const result = await client.listTools();

      const tools: McpToolInfo[] = result.tools.map(t => ({
        name: t.name,
        description: t.description ?? '',
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }));

      // 存入 server entry + 注册工具路由映射
      this.servers.set(serverName, { client, tools, serverName });
      for (const t of tools) {
        const fullToolName = `mcp_${serverName}_${t.name}`;
        this.toolRoutes.set(fullToolName, { serverName, originalName: t.name });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[MCP] 连接服务器 "${serverName}" 失败: ${errMsg}`);
      throw err; // 仍然抛出，让 initializeAll 的 Promise.allSettled 处理
    }
  }

  /** 兼容包装：单 server 初始化 */
  async initialize(config: McpServerConfig): Promise<void> {
    await this.initializeAll([config]);
  }

  /**
   * 聚合所有 server 的工具，工具名加前缀 mcp_<serverName>_<toolName>（全局唯一）。
   */
  getTools(): McpToolInfo[] {
    const all: McpToolInfo[] = [];
    for (const entry of this.servers.values()) {
      for (const t of entry.tools) {
        all.push({
          name: `mcp_${entry.serverName}_${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }
    return all;
  }

  /**
   * 调用 MCP 工具。
   * fullToolName 为 AI 可见的完整名 mcp_<serverName>_<toolName>，
   * 内部查映射得到 serverName + originalName，路由到对应 server 的 client。
   */
  async callTool(fullToolName: string, args: Record<string, unknown>): Promise<{ success: boolean; output?: string; error?: string }> {
    const route = this.toolRoutes.get(fullToolName);
    if (route == null) {
      return { success: false, error: 'MCP tool not found' };
    }
    const entry = this.servers.get(route.serverName);
    if (entry == null) {
      return { success: false, error: 'MCP server not connected' };
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        entry.client.callTool({ name: route.originalName, arguments: args }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`MCP tool "${fullToolName}" timed out after ${MCP_CALL_TIMEOUT_MS / 1000}s`)), MCP_CALL_TIMEOUT_MS);
        }),
      ]);

      // 提取文本内容
      const contentArr = Array.isArray(result.content) ? result.content : [];
      const text = contentArr
        .filter((c): c is { type: 'text'; text: string } => 'type' in c && c.type === 'text')
        .map(c => c.text)
        .join('\n');

      return { success: true, output: text || '(no output)' };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `MCP tool call failed: ${errorMsg}` };
    } finally {
      if (timeoutId != null) clearTimeout(timeoutId);
    }
  }

  /** 返回 Map 中是否有任一已连接 client */
  isConnected(): boolean {
    return this.servers.size > 0;
  }
}

export const mcpClient = new McpClientManager();

/** 独立导出，供 tool/index.ts 再导出 */
export async function initializeAll(servers: readonly McpServerConfig[]): Promise<void> {
  await mcpClient.initializeAll(servers);
}
