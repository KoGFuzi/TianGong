import type { ToolExecutionResult } from '../executor.ts';
import { isWindows, isMac } from '../../runtime/platform/index.ts';

/** 端口监听条目 */
interface PortEntry {
  protocol: string;
  localAddress: string;
  localPort: number;
  state: string;
  pid: string;
  processName: string;
}

/**
 * 端口扫描与进程分析工具
 * 根据平台选择 netstat / ss / lsof 命令，解析输出并返回监听端口列表
 */
export async function executeDefenseScanner(params: {
  portRange?: string | undefined;    // 如 "1-1024" 或 "80,443,8080"
  protocol?: string | undefined;     // 'tcp' | 'udp'
  format?: string | undefined;       // 'brief' | 'detailed'
}): Promise<ToolExecutionResult> {
  const { portRange, protocol, format = 'detailed' } = params;

  try {
    // 根据平台选择命令
    let cmd: string[];
    if (isWindows()) {
      cmd = ['netstat', '-ano'];
    } else if (isMac()) {
      cmd = ['lsof', '-i', '-P', '-n'];
    } else {
      // Linux：优先 ss，回退 netstat
      cmd = ['ss', '-tunlp'];
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15_000);

    const proc = Bun.spawn({
      cmd,
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

    if (exitCode !== 0 && stdout.trim().length === 0) {
      return { success: false, error: `命令执行失败 (exit ${exitCode}): ${stderr}` };
    }

    // 解析输出为条目列表
    let entries: PortEntry[];
    if (isWindows()) {
      entries = parseNetstatWindows(stdout);
    } else if (isMac()) {
      entries = parseLsof(stdout);
    } else {
      entries = parseSs(stdout);
    }

    // 按协议过滤
    if (protocol != null) {
      const proto = protocol.toLowerCase();
      entries = entries.filter(e => e.protocol.toLowerCase().includes(proto));
    }

    // 按端口范围过滤
    if (portRange != null) {
      const portSet = parsePortRange(portRange);
      if (portSet != null) {
        entries = entries.filter(e => portSet.has(e.localPort));
      }
    }

    if (entries.length === 0) {
      return { success: true, output: '未找到匹配的监听端口/进程。' };
    }

    // 格式化输出
    const output = formatEntries(entries, format);
    return { success: true, output };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: '端口扫描超时（15s）' };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `端口扫描失败: ${errorMsg}` };
  }
}

/** 解析 Windows netstat -ano 输出 */
function parseNetstatWindows(stdout: string): PortEntry[] {
  const entries: PortEntry[] = [];
  const lines = stdout.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // 跳过标题行和空行
    if (!trimmed || trimmed.startsWith('Active') || trimmed.startsWith('Proto')) continue;

    // 格式: Proto  Local Address      Foreign Address    State       PID
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    const proto = parts[0] ?? '';
    const localAddr = parts[1] ?? '';
    const state = parts.length >= 6 ? parts[3] ?? '' : '';
    const pid = parts[parts.length - 1] ?? '';

    // 只关注 LISTENING / UDP (UDP 无状态)
    if (!proto.startsWith('TCP') && !proto.startsWith('UDP')) continue;
    if (proto.startsWith('TCP') && state !== 'LISTENING') continue;

    const lastColon = localAddr.lastIndexOf(':');
    const portStr = lastColon >= 0 ? localAddr.slice(lastColon + 1) : '';
    const port = parseInt(portStr, 10);
    if (isNaN(port)) continue;

    entries.push({
      protocol: proto,
      localAddress: localAddr,
      localPort: port,
      state: state || 'N/A',
      pid,
      processName: '', // netstat 不直接提供进程名，需额外查询
    });
  }

  return entries;
}

/** 解析 Linux ss -tunlp 输出 */
function parseSs(stdout: string): PortEntry[] {
  const entries: PortEntry[] = [];
  const lines = stdout.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Netid') || trimmed.startsWith('State')) continue;

    // 格式: Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
    const parts = trimmed.split(/\s+/);
    if (parts.length < 5) continue;

    const proto = parts[0] ?? '';
    const state = parts[1] ?? '';
    const localAddr = parts[4] ?? '';

    // 只关注 LISTEN 状态（tcp）或所有 udp
    if (proto === 'tcp' && state !== 'LISTEN') continue;

    const lastColon = localAddr.lastIndexOf(':');
    const portStr = lastColon >= 0 ? localAddr.slice(lastColon + 1) : '';
    const port = parseInt(portStr, 10);
    if (isNaN(port)) continue;

    // 提取进程信息
    const processInfo = parts.slice(6).join(' ');
    const pidMatch = processInfo.match(/pid=(\d+)/);

    entries.push({
      protocol: proto.toUpperCase(),
      localAddress: localAddr,
      localPort: port,
      state: state || 'N/A',
      pid: pidMatch?.[1] ?? '',
      processName: '',
    });
  }

  return entries;
}

/** 解析 Mac lsof -i -P -n 输出 */
function parseLsof(stdout: string): PortEntry[] {
  const entries: PortEntry[] = [];
  const lines = stdout.split('\n');
  const seen = new Set<string>(); // 去重

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('COMMAND')) continue;

    // 格式: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) continue;

    const command = parts[0] ?? '';
    const pid = parts[1] ?? '';
    const type = parts[4] ?? '';
    const name = parts[8] ?? '';

    // 只关注 TCP/UDP
    if (type !== 'IPv4' && type !== 'IPv6') continue;

    // 提取端口
    const lastColon = name.lastIndexOf(':');
    const portStr = lastColon >= 0 ? name.slice(lastColon + 1) : '';
    const port = parseInt(portStr, 10);
    if (isNaN(port)) continue;

    // 判断协议
    const proto = name.includes('UDP') ? 'UDP' : 'TCP';

    // 去重 key
    const key = `${proto}:${port}:${pid}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 只关注监听状态
    const state = parts[7] ?? '';
    if (proto === 'TCP' && state !== 'LISTEN' && state !== '(LISTEN)') continue;

    entries.push({
      protocol: proto,
      localAddress: name,
      localPort: port,
      state: proto === 'UDP' ? 'N/A' : 'LISTEN',
      pid,
      processName: command,
    });
  }

  return entries;
}

/** 解析端口范围字符串为端口号集合 */
function parsePortRange(range: string): Set<number> | null {
  const ports = new Set<number>();

  // 支持逗号分隔
  const parts = range.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    // 支持范围 如 1-1024
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch != null) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      for (let i = start; i <= end && i <= 65535; i++) {
        ports.add(i);
      }
    } else {
      const port = parseInt(trimmed, 10);
      if (!isNaN(port) && port >= 0 && port <= 65535) {
        ports.add(port);
      }
    }
  }

  return ports.size > 0 ? ports : null;
}

/** 格式化输出条目 */
function formatEntries(entries: PortEntry[], format: string): string {
  const header = `发现 ${entries.length} 个监听端口:\n\n`;

  if (format === 'brief') {
    const lines = entries.map(e =>
      `  ${e.protocol.padEnd(6)} :${String(e.localPort).padEnd(6)} ${e.state.padEnd(12)} PID:${e.pid || 'N/A'}`
    );
    return header + lines.join('\n');
  }

  // detailed 格式
  const lines = entries.map(e =>
    `  协议: ${e.protocol}  地址: ${e.localAddress}  端口: ${e.localPort}  状态: ${e.state}  PID: ${e.pid || 'N/A'}  进程: ${e.processName || '未知'}`
  );
  return header + lines.join('\n');
}
