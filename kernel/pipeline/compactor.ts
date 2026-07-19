import type { ToolExecutionResult } from '../../tool/executor.ts';
import type { ModelMessage } from 'ai';
import { estimateTokens } from '../../runtime/budget/index.ts';
import { getConfig } from '../../config/config.ts';

// ── 工具分类 ──────────────────────────────────────────────

const FILE_READ_TOOLS = new Set([
  'read_file',
  'read_from_workspace',
  'read_file_from_workspace',
]);

const COMMAND_EXEC_TOOLS = new Set([
  'execute_bash',
]);

const SEARCH_TOOLS = new Set([
  'web_search',
  'grep',
]);

const WRITE_TOOLS = new Set([
  'write_to_workspace',
  'edit_file',
  'write_file',
]);

// ── 辅助函数 ──────────────────────────────────────────────

function outputToString(output: unknown): string {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  return JSON.stringify(output);
}

function omitMarker(linesOrChars: number, unit: '行' | '字符' | '条结果'): string {
  return `\n\n[... 省略 ${linesOrChars} ${unit}，文件内容已处理 ...]\n\n`;
}

/** 按行折叠：保留前 headLines 行 + 尾 tailLines 行 + 省略标记 */
function foldByLines(text: string, headLines: number, tailLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines) return text;

  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const omitted = lines.length - headLines - tailLines;

  return head.join('\n') + omitMarker(omitted, '行') + tail.join('\n');
}

/** 截断到指定字符数，保留头部 */
function truncateChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return text.slice(0, maxChars) + omitMarker(omitted, '字符');
}

/** 搜索类截断：保留前 N 条结果，每条截断至 maxCharsPerItem 字 */
function truncateSearchResults(text: string, maxItems: number, maxCharsPerItem: number): string {
  // 尝试按常见分隔符拆分（换行+数字序号、换行分隔块）
  const blocks = text.split(/\n(?=\d+[\.\)、])|\n(?=- )|\n(?=▶)/);
  if (blocks.length <= 1) {
    // 无法识别分隔符，按字符截断
    return truncateChars(text, maxItems * maxCharsPerItem);
  }

  const kept = blocks.slice(0, maxItems);
  const truncated = kept.map(b => truncateChars(b, maxCharsPerItem));
  const omitted = blocks.length - maxItems;

  let result = truncated.join('\n');
  if (omitted > 0) {
    result += omitMarker(omitted, '条结果');
  }
  return result;
}

// ── compactToolOutput ─────────────────────────────────────

/**
 * 根据工具类型对输出进行折叠/截断，减少注入消息历史的 Token 量。
 *
 * 策略：
 * - 文件读取类（read_file, read_from_workspace, read_file_from_workspace）：保留前30行 + 尾10行 + 省略标记
 * - 命令执行类（execute_bash）：保留首50行 + 尾20行 + 省略标记
 * - 搜索类（web_search, grep）：保留前3条结果，每条截断至200字
 * - 写入类（write_to_workspace, edit_file, write_file）：仅保留确认信息
 * - 其他工具：按 maxTokens * 4 字符数截断，保留头部
 */
export function compactToolOutput(
  toolName: string,
  result: ToolExecutionResult,
  maxTokens?: number,
): ToolExecutionResult {
  const limit = maxTokens ?? getConfig().context.toolOutputMaxTokens;

  // 没有 output 或 output 为空，直接返回
  if (result.output == null || result.output === '') {
    return result;
  }

  const text = outputToString(result.output);

  // Token 数未超限，无需压缩
  if (estimateTokens(text) <= limit) {
    return result;
  }

  let compacted: string;

  if (FILE_READ_TOOLS.has(toolName)) {
    compacted = foldByLines(text, 30, 10);
  } else if (COMMAND_EXEC_TOOLS.has(toolName)) {
    compacted = foldByLines(text, 50, 20);
  } else if (SEARCH_TOOLS.has(toolName)) {
    compacted = truncateSearchResults(text, 3, 200);
  } else if (WRITE_TOOLS.has(toolName)) {
    // 写入类：仅保留确认信息（取前 1 行或原始 output 前 200 字符）
    const firstLine = text.split('\n')[0] ?? '';
    compacted = truncateChars(firstLine, 200);
  } else {
    // 其他工具：按 maxTokens * 4 字符数截断
    compacted = truncateChars(text, limit * 4);
  }

  const base: { success: boolean; output: string; error?: string } = {
    success: result.success,
    output: compacted,
  };
  if (result.error !== undefined) {
    base.error = result.error;
  }
  return base as ToolExecutionResult;
}

// ── compactOldToolResults ─────────────────────────────────

/**
 * 对消息历史中已处理过的工具结果进行二次折叠。
 * 仅保留最近 keepRecent 轮的完整工具结果，更早的替换为占位符。
 */
export function compactOldToolResults(
  messages: ModelMessage[],
  keepRecent?: number,
): ModelMessage[] {
  const keep = keepRecent ?? getConfig().context.slidingWindowSize;

  // 从后往前扫描，计数工具结果消息
  let toolResultCount = 0;
  // 记录需要替换的消息索引（需要替换的 = 超过 keepRecent 的旧消息）
  const indicesToCompact: number[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (isToolResultMessage(msg)) {
      toolResultCount++;
      if (toolResultCount > keep) {
        indicesToCompact.push(i);
      }
    }
  }

  if (indicesToCompact.length === 0) {
    return messages;
  }

  const compactSet = new Set(indicesToCompact);

  return messages.map((msg, idx) => {
    if (!compactSet.has(idx)) return msg;
    return compactMessage(msg);
  });
}

/** 判断一条消息是否是工具结果消息 */
function isToolResultMessage(msg: ModelMessage): boolean {
  // role === 'tool' 的消息
  if (msg.role === 'tool') return true;

  // fallback 路径：user 消息，content 以 '[工具结果' 开头
  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[工具结果')) {
    return true;
  }

  return false;
}

/** 将一条工具结果消息替换为占位符 */
function compactMessage(msg: ModelMessage): ModelMessage {
  if (msg.role === 'tool' && Array.isArray(msg.content)) {
    // 对 tool role 的消息，content 是数组，每项可能是 tool-result
    const newContent = msg.content.map((item: any) => {
      if (item.type === 'tool-result') {
        return {
          type: 'tool-result' as const,
          toolCallId: item.toolCallId ?? '',
          toolName: item.toolName ?? '',
          output: { type: 'json' as const, value: '[content omitted, already processed]' },
        };
      }
      return item;
    });
    return { ...msg, content: newContent } as ModelMessage;
  }

  if (msg.role === 'tool') {
    // content 可能是字符串或其他格式，通过 unknown 中转
    return { ...msg, content: '[content omitted, already processed]' } as unknown as ModelMessage;
  }

  if (msg.role === 'user' && typeof msg.content === 'string' && msg.content.startsWith('[工具结果')) {
    // 提取工具名：[工具结果 XXX: ...]
    const match = msg.content.match(/^\[工具结果\s+(\S+)/);
    const toolName = match?.[1] ?? 'unknown';
    return { ...msg, content: `[工具结果 ${toolName}: content omitted, already processed]` } as ModelMessage;
  }

  return msg;
}
