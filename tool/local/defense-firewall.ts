import type { ToolExecutionResult } from '../executor.ts';
import { isWindows, isMac } from '../../runtime/platform/index.ts';

/**
 * 防火墙规则查看与生成工具
 * - list: 查看当前防火墙规则
 * - block/allow: 生成对应平台命令（不自动执行）
 */
export async function executeDefenseFirewall(params: {
  action: string;       // 'block' | 'allow' | 'list'
  ip?: string | undefined;          // IP 地址或 CIDR
  port?: string | undefined;        // 端口号
  protocol?: string | undefined;    // 'tcp' | 'udp'
}): Promise<ToolExecutionResult> {
  const { action, ip, port, protocol = 'tcp' } = params;

  try {
    switch (action.toLowerCase()) {
      case 'list':
        return await listFirewallRules();
      case 'block':
      case 'allow': {
        // 输入校验
        const VALID_PROTOCOLS = ['tcp', 'udp'];
        if (params.protocol && !VALID_PROTOCOLS.includes(params.protocol.toLowerCase())) {
          return { success: false, error: `无效的协议: ${params.protocol}，仅支持 tcp/udp` };
        }
        if (params.port && !/^\d{1,5}(-\d{1,5})?$/.test(params.port)) {
          return { success: false, error: `无效的端口格式: ${params.port}` };
        }
        if (params.ip && !/^[\d.a-fA-F:\/]+$/.test(params.ip)) {
          return { success: false, error: `无效的 IP 地址格式: ${params.ip}` };
        }
        return generateRule(action.toLowerCase() as 'block' | 'allow', ip, port, protocol);
      }
      default:
        return { success: false, error: `未知操作: ${action}，支持 block / allow / list` };
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `防火墙操作失败: ${errorMsg}` };
  }
}

/** 列出当前防火墙规则 */
async function listFirewallRules(): Promise<ToolExecutionResult> {
  let cmd: string[];

  if (isWindows()) {
    cmd = ['netsh', 'advfirewall', 'firewall', 'show', 'rule', 'name=all'];
  } else if (isMac()) {
    // macOS 使用 pf 或 socketfilterfw
    cmd = ['/usr/libexec/ApplicationFirewall/socketfilterfw', '--getglobalstate'];
  } else {
    // Linux：尝试 iptables，回退 nft
    cmd = ['iptables', '-L', '-n', '--line-numbers'];
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

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

  // iptables 可能返回非 0 但仍有输出
  if (exitCode !== 0 && stdout.trim().length === 0) {
    // Linux 回退到 nft
    if (!isWindows() && !isMac()) {
      return await listNftRules();
    }
    return { success: false, error: `获取防火墙规则失败 (exit ${exitCode}): ${stderr}` };
  }

  // 截取前 200 行避免输出过大
  const lines = stdout.split('\n');
  const truncated = lines.length > 200;
  const display = truncated ? lines.slice(0, 200).join('\n') + `\n\n... (共 ${lines.length} 行，已截取前 200 行)` : stdout;

  return { success: true, output: `当前防火墙规则:\n\n${display}` };
}

/** Linux nft 回退 */
async function listNftRules(): Promise<ToolExecutionResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  const proc = Bun.spawn({
    cmd: ['nft', 'list', 'ruleset'],
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
    return { success: false, error: `nft 获取规则失败: ${stderr}` };
  }

  return { success: true, output: `当前 nftables 规则:\n\n${stdout}` };
}

/** 生成防火墙规则命令（不自动执行） */
function generateRule(
  action: 'block' | 'allow',
  ip: string | undefined,
  port: string | undefined,
  protocol: string,
): ToolExecutionResult {
  if (ip == null && port == null) {
    return { success: false, error: '至少需要指定 ip 或 port 参数' };
  }

  const lines: string[] = [];
  lines.push(`=== 防火墙规则生成 (${action.toUpperCase()}) ===`);
  lines.push('');

  if (isWindows()) {
    lines.push(...generateWindowsRules(action, ip, port, protocol));
  } else if (isMac()) {
    lines.push(...generateMacRules(action, ip, port, protocol));
  } else {
    lines.push(...generateLinuxRules(action, ip, port, protocol));
  }

  lines.push('');
  lines.push('提示: 以上命令未自动执行。如需应用，请使用 execute_bash 工具手动执行。');

  return { success: true, output: lines.join('\n') };
}

/** 生成 Windows 防火墙命令 */
function generateWindowsRules(
  action: 'block' | 'allow',
  ip: string | undefined,
  port: string | undefined,
  protocol: string,
): string[] {
  const lines: string[] = [];
  const direction = action === 'block' ? 'Block' : 'Allow';
  const ruleName = `TianGong_${direction}_${ip ?? ''}_${port ?? ''}`.replace(/_+$/, '');

  let cmd = `netsh advfirewall firewall add rule name="${ruleName}" dir=in action=${direction}`;

  if (protocol != null) {
    cmd += ` protocol=${protocol.toUpperCase()}`;
  }
  if (port != null) {
    cmd += ` localport=${port}`;
  }
  if (ip != null) {
    cmd += ` remoteip=${ip}`;
  }

  lines.push('[Windows Firewall]');
  lines.push(cmd);

  return lines;
}

/** 生成 Linux iptables 命令 */
function generateLinuxRules(
  action: 'block' | 'allow',
  ip: string | undefined,
  port: string | undefined,
  protocol: string,
): string[] {
  const lines: string[] = [];
  const target = action === 'block' ? 'DROP' : 'ACCEPT';
  const proto = protocol.toLowerCase();

  let cmd = `iptables -A INPUT -p ${proto}`;
  if (port != null) {
    cmd += ` --dport ${port}`;
  }
  if (ip != null) {
    cmd += ` -s ${ip}`;
  }
  cmd += ` -j ${target}`;

  lines.push('[iptables]');
  lines.push(cmd);
  lines.push('');
  lines.push('# 持久化规则（Debian/Ubuntu）:');
  lines.push('iptables-save > /etc/iptables/rules.v4');
  lines.push('');
  lines.push('# 持久化规则（RHEL/CentOS）:');
  lines.push('service iptables save');

  return lines;
}

/** 生成 macOS 防火墙命令 */
function generateMacRules(
  action: 'block' | 'allow',
  ip: string | undefined,
  port: string | undefined,
  protocol: string,
): string[] {
  const lines: string[] = [];
  const proto = protocol.toLowerCase();

  lines.push('[macOS pf 防火墙]');

  if (action === 'block' && ip != null) {
    lines.push(`echo "block in from ${ip} to any proto ${proto}" | sudo pfctl -ef -`);
  } else if (action === 'allow' && port != null) {
    lines.push(`echo "pass in proto ${proto} from any to any port ${port}" | sudo pfctl -ef -`);
  } else if (action === 'block' && port != null) {
    lines.push(`echo "block in proto ${proto} from any to any port ${port}" | sudo pfctl -ef -`);
  } else if (action === 'allow' && ip != null) {
    lines.push(`echo "pass in from ${ip} to any proto ${proto}" | sudo pfctl -ef -`);
  }

  lines.push('');
  lines.push('# 查看当前 pf 规则:');
  lines.push('sudo pfctl -sr');

  return lines;
}
