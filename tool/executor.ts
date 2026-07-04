import { resolve, sep } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { platform } from 'node:os';
import { existsSync } from 'node:fs';
import { executeWebSearch } from './local/web-search.ts';

export interface ToolExecutionResult {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
}

const EXECUTE_TIMEOUT_MS = 10_000;
const WORKSPACE_BASE = resolve(__dirname, '../../runtime/workspace');

function resolveWorkspacePath(sessionId: string, filename: string): { safe: true; path: string } | { safe: false; error: string } {
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return { safe: false, error: `Security: filename "${filename}" contains path traversal characters. Only plain filenames are allowed.` };
  }
  const baseDir = resolve(WORKSPACE_BASE, sessionId);
  const fullPath = resolve(baseDir, filename);
  if (!fullPath.startsWith(baseDir + sep) && fullPath !== baseDir) {
    return { safe: false, error: `Security: path traversal detected. File operations are restricted to the workspace directory.` };
  }
  return { safe: true, path: fullPath };
}

function getWorkspaceDir(sessionId: string): string {
  return resolve(WORKSPACE_BASE, sessionId);
}

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  sessionId: string = 'default',
): Promise<ToolExecutionResult> {
  switch (toolName) {
    case 'execute_bash':
      return executeBash(args.command as string);
    case 'write_to_workspace':
      return writeToWorkspace(sessionId, args.filename as string, args.content as string);
    case 'execute_workspace_script':
      return executeWorkspaceScript(sessionId, args.filename as string, (args.args as string[]) ?? []);
    case 'web_search':
      return executeWebSearch(args.query as string);
    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
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
 * Priority:
 *   1. $SHELL env var (if the file exists)
 *   2. `bash` found by traversing PATH (pure JS, no external command)
 *   3. Well-known Git Bash install locations
 *   4. Bare 'bash' as last-resort fallback (relies on PATH at spawn time)
 */
function resolveWindowsShell(): string {
  // 1. Honour $SHELL if it points to an existing executable
  const envShell = process.env['SHELL'];
  if (envShell && existsSync(envShell)) return envShell;

  // 2. Traverse PATH to find bash.exe
  const pathBash = findInPath('bash');
  if (pathBash) return pathBash;

  // 3. Well-known Git Bash install locations
  const candidates = [
    resolve(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    resolve(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    resolve(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  // 4. Last resort — hope bash is resolvable at spawn time
  return 'bash';
}

function getShell(): readonly [string, string] {
  if (platform() === 'win32') {
    return [resolveWindowsShell(), '-c'];
  }
  // Linux / macOS: use default POSIX shell
  return ['/bin/sh', '-c'];
}

async function executeBash(command: string): Promise<ToolExecutionResult> {
  if (!command || command.trim().length === 0) {
    return { success: false, error: 'Empty command' };
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
  const pathResult = resolveWorkspacePath(sessionId, filename);
  if (!pathResult.safe) return { success: false, error: pathResult.error };
  try {
    await mkdir(getWorkspaceDir(sessionId), { recursive: true });
    await Bun.write(pathResult.path, content);
    return { success: true, output: `File "${filename}" written successfully to workspace (${content.length} bytes).` };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to write file: ${errorMsg}` };
  }
}

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

async function executeWorkspaceScript(sessionId: string, filename: string, args: string[]): Promise<ToolExecutionResult> {
  const pathResult = resolveWorkspacePath(sessionId, filename);
  if (!pathResult.safe) return { success: false, error: pathResult.error };
  const interpreter = getInterpreter(filename);
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
      return { success: false, error: `Script timed out after ${EXECUTE_TIMEOUT_MS / 1000}s. File: ${filename}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to execute script: ${errorMsg}` };
  }
}
