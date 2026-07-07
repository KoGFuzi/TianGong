import { resolve, sep } from 'node:path';
import { mkdir, readFile as fsReadFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { getConfig } from '../../config/config.ts';

// ── 辅助：获取工作区基础路径 ──────────────────────────────

export function getWorkspaceBase(): string {
  const { workspace } = getConfig();
  return resolve(workspace.baseDir);
}

// ── 路径安全校验 ──────────────────────────────────────────

export type PathValidation =
  | { safe: true; path: string }
  | { safe: false; error: string };

export function validatePath(filePath: string): PathValidation {
  if (filePath.includes('..') || filePath.includes('/') || filePath.includes('\\')) {
    return { safe: false, error: `Security: filename "${filePath}" contains path traversal characters. Only plain filenames are allowed.` };
  }
  return { safe: true, path: filePath };
}

// ── 内部：解析会话工作区内的完整路径 ──────────────────────

function resolveSessionPath(sessionId: string, filename: string): PathValidation {
  const validation = validatePath(filename);
  if (!validation.safe) return validation;

  const baseDir = resolve(getWorkspaceBase(), sessionId);
  const fullPath = resolve(baseDir, filename);
  if (!fullPath.startsWith(baseDir + sep) && fullPath !== baseDir) {
    return { safe: false, error: `Security: path traversal detected. File operations are restricted to the workspace directory.` };
  }
  return { safe: true, path: fullPath };
}

function getSessionDir(sessionId: string): string {
  return resolve(getWorkspaceBase(), sessionId);
}

// ── 文件大小校验 ──────────────────────────────────────────

function checkFileSize(content: string, filename: string): PathValidation {
  const { maxFileSize } = getConfig().workspace;
  const byteSize = new TextEncoder().encode(content).byteLength;
  if (byteSize > maxFileSize) {
    return {
      safe: false,
      error: `File "${filename}" exceeds maximum size of ${maxFileSize} bytes (actual: ${byteSize} bytes).`,
    };
  }
  return { safe: true, path: '' };
}

// ── 公开 API ──────────────────────────────────────────────

export async function writeFile(sessionId: string, relativePath: string, content: string): Promise<PathValidation> {
  const sizeCheck = checkFileSize(content, relativePath);
  if (!sizeCheck.safe) return sizeCheck;

  const pathResult = resolveSessionPath(sessionId, relativePath);
  if (!pathResult.safe) return pathResult;

  try {
    await mkdir(getSessionDir(sessionId), { recursive: true });
    await Bun.write(pathResult.path, content);
    return { safe: true, path: pathResult.path };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { safe: false, error: `Failed to write file: ${errorMsg}` };
  }
}

export async function readFile(sessionId: string, relativePath: string): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  const pathResult = resolveSessionPath(sessionId, relativePath);
  if (!pathResult.safe) return { ok: false, error: pathResult.error };

  try {
    const content = await fsReadFile(pathResult.path, 'utf-8');
    const { maxFileSize } = getConfig().workspace;
    if (new TextEncoder().encode(content).byteLength > maxFileSize) {
      return { ok: false, error: `File "${relativePath}" exceeds maximum size of ${maxFileSize} bytes.` };
    }
    return { ok: true, content };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to read file: ${errorMsg}` };
  }
}

// ── 脚本执行 ──────────────────────────────────────────────

const EXECUTE_TIMEOUT_MS = 10_000;

function getInterpreter(filename: string): string | null {
  const ext = filename.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'py': return 'python';
    case 'sh': return 'bash';
    case 'ts': return 'bun';
    case 'js': return 'bun';
    default: return null;
  }
}

/**
 * Search PATH directories for an executable (pure-JS, no child process).
 */
function findInPath(name: string): string | undefined {
  const pathEnv = process.env['PATH'] ?? '';
  const separator = platform() === 'win32' ? ';' : ':';
  const extensions = platform() === 'win32' ? (process.env['PATHEXT'] ?? '.EXE').split(';') : [''];
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
 * Resolve a POSIX-compatible shell on Windows.
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

export function getShell(): readonly [string, string] {
  if (platform() === 'win32') {
    return [resolveWindowsShell(), '-c'];
  }
  return ['/bin/sh', '-c'];
}

export async function executeScript(
  sessionId: string,
  scriptPath: string,
  args: string[] = [],
): Promise<{ success: boolean; output?: string; error?: string }> {
  const pathResult = resolveSessionPath(sessionId, scriptPath);
  if (!pathResult.safe) return { success: false, error: pathResult.error };

  const interpreter = getInterpreter(scriptPath);
  if (interpreter == null) {
    return { success: false, error: `No interpreter for file extension. Supported: .py, .sh, .ts, .js` };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS);
    const proc = Bun.spawn({
      cmd: [interpreter, pathResult.path, ...args],
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
      return { success: false, output: stdout, error: `Script exited with code ${exitCode}.\nstderr: ${stderr}\nstdout: ${stdout}` };
    }
    return { success: true, output: stdout || '(no output)' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: `Script timed out after ${EXECUTE_TIMEOUT_MS / 1000}s. File: ${scriptPath}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to execute script: ${errorMsg}` };
  }
}
