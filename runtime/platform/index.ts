import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 平台检测 ──────────────────────────────────────────────

/** 检测当前是否为 Windows 平台 */
export function isWindows(): boolean {
  return platform() === 'win32';
}

/** 检测当前是否为 macOS 平台 */
export function isMac(): boolean {
  return platform() === 'darwin';
}

/** 检测当前是否为 Linux 平台 */
export function isLinux(): boolean {
  return platform() === 'linux';
}

// ── 路径工具 ──────────────────────────────────────────────

/** 获取当前平台的路径分隔符（Windows: '\\'，其他: '/'） */
export function getPathSeparator(): string {
  return isWindows() ? '\\' : '/';
}

/** 获取当前平台 PATH 环境变量的分隔符（Windows: ';'，其他: ':'） */
export function getPathEnvSeparator(): string {
  return isWindows() ? ';' : ':';
}

// ── Shell 解析 ────────────────────────────────────────────

/**
 * 在 PATH 环境变量中查找可执行文件（纯 JS 实现，不依赖子进程）。
 * Windows 下会自动尝试 PATHEXT 中列出的扩展名。
 */
export function findInPath(name: string): string | undefined {
  const pathEnv = process.env['PATH'] ?? '';
  const separator = getPathEnvSeparator();
  const extensions = isWindows()
    ? (process.env['PATHEXT'] ?? '.EXE').split(';')
    : [''];
  for (const dir of pathEnv.split(separator)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const full = resolve(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

/**
 * Windows 平台下解析可用的 POSIX Shell。
 * 依次尝试：$SHELL 环境变量 → PATH 中的 bash → Git Bash 常见安装路径。
 */
function resolveWindowsShell(): string {
  const envShell = process.env['SHELL'];
  if (envShell && existsSync(envShell)) return envShell;

  const pathBash = findInPath('bash');
  if (pathBash) return pathBash;

  const candidates = [
    resolve(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    resolve(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    resolve(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return 'bash';
}

/**
 * 获取当前平台的默认 Shell 及其执行参数。
 * Windows: 尝试解析 Git Bash 等 POSIX 兼容 Shell。
 * 非 Windows: 优先使用 $SHELL 环境变量，回退到 /bin/sh。
 */
export function getDefaultShell(): readonly [string, string] {
  if (isWindows()) {
    return [resolveWindowsShell(), '-c'];
  }
  const envShell = process.env['SHELL'];
  if (envShell && existsSync(envShell)) return [envShell, '-c'];
  return ['/bin/sh', '-c'];
}

// ── 解释器查找 ────────────────────────────────────────────

/**
 * 获取当前平台推荐的 Python 解释器命令。
 * Windows: 返回 'python'（Windows 下 python 通常指向 Python 3）。
 * Linux/Mac: 优先查找 python3，找不到则回退到 python。
 */
export function getPythonInterpreter(): string {
  if (isWindows()) {
    return 'python';
  }
  if (findInPath('python3')) {
    return 'python3';
  }
  return 'python';
}

// ── 平台感知的安全命令列表 ────────────────────────────────

/**
 * 获取当前平台下默认允许执行的命令列表。
 * 包含跨平台通用命令，以及各平台专有的常用命令。
 */
export function getDefaultAllowedCommands(): string[] {
  const common = [
    'nmap', 'sqlmap', 'hydra',
    'node', 'bun',
    'curl', 'wget',
    'ping', 'dig', 'nslookup',
  ];

  const windowsOnly = [
    'dir', 'type', 'ipconfig', 'where', 'systeminfo', 'python',
  ];

  const unixOnly = [
    'ls', 'find', 'grep', 'cat',
    'whoami', 'id', 'uname', 'ifconfig',
    'bash', 'sh', 'python3',
    'iptables', 'journalctl', 'netstat', 'ss',
    'tcpdump', 'fail2ban-client', 'auditctl',
    'lsof', 'nft', 'sha256sum', 'md5sum',
  ];

  if (isWindows()) {
    return [...common, ...windowsOnly];
  }
  return [...common, ...unixOnly];
}

/**
 * 获取当前平台下默认禁止执行的危险命令列表。
 * 包含跨平台通用危险命令，以及各平台专有的高危命令。
 */
export function getDefaultBlockedCommands(): string[] {
  const common = [
    'fork bomb',
  ];

  const unixOnly = [
    'rm -rf', 'mkfs', 'dd if=', ':(){',
  ];

  const windowsOnly = [
    'format',
  ];

  if (isWindows()) {
    return [...common, ...windowsOnly];
  }
  return [...common, ...unixOnly];
}
