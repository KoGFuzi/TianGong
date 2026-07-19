/**
 * 脚本工具加载器
 *
 * 扫描 tool/local/ 目录下的 .py / .php 文件，解析头部元数据声明，
 * 自动注册为可被 Agent 调用的工具。工具被调用时，参数以 JSON 字符串形式通过
 * 命令行参数传入脚本（argv[1]），脚本通过 stdout 返回结果。
 *
 * 支持的语言及元数据前缀：
 *   - Python (.py)  → `# @tiangong-tool {JSON}`
 *   - PHP    (.php) → `// @tiangong-tool {JSON}`
 *
 * Python 工具示例：
 * ```python
 * #!/usr/bin/env python3
 * # @tiangong-tool {"name":"port_scan","description":"Scan target ports","agents":["operator"],"inputs":{"target":{"type":"string","description":"Target host"}}}
 * import json, sys
 * args = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
 * print(json.dumps({"output": "scan result"}))
 * ```
 *
 * PHP 工具示例：
 * ```php
 * <?php
 * // @tiangong-tool {"name":"whois_lookup","description":"WHOIS 查询","agents":["research"],"inputs":{"domain":{"type":"string","description":"域名"}}}
 * $args = json_decode($argv[1] ?? '{}', true);
 * echo json_encode(["output" => "result"]);
 * ```
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { z } from 'zod';
import type { ToolDefinition } from '../registry.ts';
import type { ToolExecutionResult } from '../executor.ts';

// ── 元数据类型 ──────────────────────────────────────────────

interface ScriptInputField {
  readonly type: 'string' | 'number' | 'boolean' | 'array';
  readonly description?: string;
  readonly required?: boolean;
  readonly items?: { type: string }; // 仅 array
}

interface ScriptToolManifest {
  readonly name: string;
  readonly description: string;
  readonly agents?: readonly string[];
  readonly inputs?: Readonly<Record<string, ScriptInputField>>;
}

interface ScriptTool {
  readonly definition: ToolDefinition;
  readonly filePath: string;
}

// ── 元数据解析 ──────────────────────────────────────────────

const MANIFEST_PREFIXES = ['# @tiangong-tool', '// @tiangong-tool'];

// 不同语言的注释起始标记（用于判断是否继续扫描 manifest）
const COMMENT_PREFIXES = ['#', '//', '<?php', '/*', '*', '*/', '"""', "'''"];

/**
 * 从脚本文件头部解析 `# @tiangong-tool {JSON}` 或 `// @tiangong-tool {JSON}` 声明。
 * 仅扫描文件前 20 行。
 */
function parseManifest(filePath: string): ScriptToolManifest | null {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').slice(0, 20);

  for (const line of lines) {
    const trimmed = line.trim();

    // 检测 manifest 声明行
    let jsonStr: string | null = null;
  for (const prefix of MANIFEST_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        jsonStr = trimmed.slice(prefix.length).trim();
        break;
      }
    }
    if (jsonStr != null) {
      try {
        const manifest = JSON.parse(jsonStr) as ScriptToolManifest;
        if (manifest.name == null || manifest.description == null) {
          console.log(`[script-loader] 跳过 ${filePath}: manifest 缺少 name 或 description`);
          return null;
        }
        return manifest;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`[script-loader] 解析 ${filePath} 元数据失败: ${msg}`);
        return null;
      }
    }

    // 空行和注释行继续扫描，遇到代码行则停止
    if (trimmed.length > 0) {
      const isComment = COMMENT_PREFIXES.some(p => trimmed.startsWith(p));
      if (!isComment) break;
    }
  }
  return null;
}

/**
 * 根据 manifest.inputs 构建 Zod schema。
 */
function buildInputSchema(inputs: ScriptToolManifest['inputs']): z.ZodType {
  if (inputs == null) {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(inputs)) {
    let fieldSchema: z.ZodType;
    switch (field.type) {
      case 'number':
        fieldSchema = z.number().describe(field.description ?? '');
        break;
      case 'boolean':
        fieldSchema = z.boolean().describe(field.description ?? '');
        break;
      case 'array':
        fieldSchema = z.array(z.string()).describe(field.description ?? '');
        break;
      case 'string':
      default:
        fieldSchema = z.string().describe(field.description ?? '');
        break;
    }
    if (field.required === false) {
      fieldSchema = fieldSchema.optional();
    }
    shape[key] = fieldSchema;
  }
  return z.object(shape);
}

// ── 扫描加载 ────────────────────────────────────────────────

let _cachedTools: ScriptTool[] | null = null;

/**
 * 扫描 tool/local/ 目录，加载所有带有效 manifest 的 .py 文件。
 * 结果缓存，仅在首次调用时扫描。
 */
export function loadScriptTools(): ScriptTool[] {
  if (_cachedTools != null) return _cachedTools;

  const localDir = resolve(__dirname);
  _cachedTools = [];

  if (!existsSync(localDir)) {
    return _cachedTools;
  }

  let entries: string[];
  try {
    // 扫描 .py 和 .php 文件
    entries = readdirSync(localDir).filter(f => f.endsWith('.py') || f.endsWith('.php'));
  } catch {
    return _cachedTools;
  }

  for (const filename of entries) {
    const filePath = join(localDir, filename);
    const manifest = parseManifest(filePath);
    if (manifest == null) continue;

    const definition: ToolDefinition = {
      name: manifest.name,
      description: manifest.description,
      inputSchema: buildInputSchema(manifest.inputs),
      allowedAgents: manifest.agents ?? [],
    };

    _cachedTools.push({ definition, filePath });
  }

  if (_cachedTools.length > 0) {
    console.log(`[script-loader] 已加载 ${_cachedTools.length} 个脚本工具: ${_cachedTools.map(t => t.definition.name).join(', ')}`);
  }

  return _cachedTools;
}

/**
 * 重新扫描（开发期热更新用）。
 */
export function reloadScriptTools(): ScriptTool[] {
  _cachedTools = null;
  return loadScriptTools();
}

// ── 执行 ────────────────────────────────────────────────────

const SCRIPT_TIMEOUT_MS = 30_000;

/**
 * 执行脚本工具：参数以 JSON 字符串通过 argv[1] 传入，结果通过 stdout 返回。
 */
export async function executeScriptTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const tools = loadScriptTools();
  const target = tools.find(t => t.definition.name === toolName);
  if (target == null) {
    return { success: false, error: `Script tool not found: ${toolName}` };
  }

  // 根据文件扩展名选择解释器
  const ext = target.filePath.split('.').pop()?.toLowerCase();
  const interpreter = ext === 'php' ? 'php' : 'python';

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT_MS);
    const argsJson = JSON.stringify(args);

    const proc = Bun.spawn({
      cmd: [interpreter, target.filePath, argsJson],
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
      return {
        success: false,
        output: stdout,
        error: `Script exited with code ${exitCode}.\nstderr: ${stderr}\nstdout: ${stdout}`,
      };
    }
    return { success: true, output: stdout || '(no output)' };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: `Script timed out after ${SCRIPT_TIMEOUT_MS / 1000}s. Tool: ${toolName}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Failed to execute script tool "${toolName}": ${errorMsg}` };
  }
}

/**
 * 获取所有脚本工具的 ToolDefinition。
 */
export function getScriptToolDefinitions(): readonly ToolDefinition[] {
  return loadScriptTools().map(t => t.definition);
}

/**
 * 获取脚本工具的 ToolDefinition + 文件路径映射（供 executor 查询）。
 */
export function getScriptToolNames(): ReadonlySet<string> {
  return new Set(loadScriptTools().map(t => t.definition.name));
}
