import type { McpToolInfo } from './client.ts';
import { mcpClient } from './client.ts';

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟

export class McpToolRegistry {
  /** 缓存工具列表，键维度为完整工具名 mcp_<server>_<tool> */
  private cachedTools: readonly McpToolInfo[] = [];
  private lastRefreshTime = 0;

  async refreshTools(): Promise<void> {
    const tools = mcpClient.getTools();
    this.cachedTools = [...tools];
    this.lastRefreshTime = Date.now();
  }

  private isCacheExpired(): boolean {
    return Date.now() - this.lastRefreshTime > CACHE_TTL_MS;
  }

  async ensureFresh(): Promise<void> {
    if (this.isCacheExpired()) {
      await this.refreshTools();
    }
  }

  searchTools(query: string): McpToolInfo[] {
    const q = query.toLowerCase();
    return this.cachedTools.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.description.toLowerCase().includes(q)
    );
  }

  /** 按完整工具名 mcp_<server>_<tool> 查找 */
  getToolByName(name: string): McpToolInfo | null {
    return this.cachedTools.find(t => t.name === name) ?? null;
  }

  getAllTools(): readonly McpToolInfo[] {
    return this.cachedTools;
  }

  getCacheAge(): number {
    return Date.now() - this.lastRefreshTime;
  }
}

export const mcpToolRegistry = new McpToolRegistry();
