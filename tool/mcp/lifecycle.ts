import type { McpServerConfig } from './client.ts';
import { mcpClient } from './client.ts';

const HEALTH_CHECK_INTERVAL_MS = 30_000;
const MAX_RESTART_ATTEMPTS = 3;

export class McpLifecycleManager {
  private servers: readonly McpServerConfig[] | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private restartCount = 0;
  private running = false;

  async start(servers: readonly McpServerConfig[]): Promise<void> {
    this.servers = servers;
    this.running = true;
    this.restartCount = 0;
    await mcpClient.initializeAll(servers);
    this.startHealthCheck();
  }

  private startHealthCheck(): void {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(() => {
      void this.performHealthCheck();
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer != null) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private async performHealthCheck(): Promise<void> {
    if (!this.running || this.servers == null) return;

    const alive = this.healthCheck();
    if (!alive) {
      await this.restart();
    }
  }

  healthCheck(): boolean {
    return mcpClient.isConnected();
  }

  async restart(): Promise<void> {
    if (this.servers == null) return;
    if (this.restartCount >= MAX_RESTART_ATTEMPTS) {
      this.running = false;
      this.stopHealthCheck();
      return;
    }

    this.restartCount++;
    try {
      // 用存的 servers 重新初始化
      await mcpClient.initializeAll(this.servers);
    } catch {
      // 重启失败，下次健康检查时再试
    }
  }

  async shutdown(): Promise<void> {
    this.running = false;
    this.stopHealthCheck();
    await mcpClient.closeAll();
    this.servers = null;
  }

  isRunning(): boolean {
    return this.running;
  }
}

export const mcpLifecycle = new McpLifecycleManager();
