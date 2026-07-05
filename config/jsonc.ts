/**
 * 轻量 JSONC 工具：支持注释的 JSON 解析与序列化，无外部依赖。
 */

/**
 * 逐字符扫描，剥离行注释与块注释，跳过字符串字面量内部。
 * 保留字符串字面量中的所有字符（含转义引号）。
 */
export function stripJsonc(text: string): string {
  let result = '';
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;

    // 字符串字面量（单引号或双引号）
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += ch;
      i++;
      while (i < len) {
        const c = text[i]!;
        result += c;
        // 转义字符：连同下一个字符一起保留
        if (c === '\\' && i + 1 < len) {
          result += text[i + 1]!;
          i += 2;
          continue;
        }
        i++;
        if (c === quote) break;
      }
      continue;
    }

    // 行注释 //
    if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < len && text[i] !== '\n') i++;
      continue;
    }

    // 块注释 /* */
    if (ch === '/' && i + 1 < len && text[i + 1] === '*') {
      i += 2;
      while (i < len && !(text[i] === '*' && i + 1 < len && text[i + 1] === '/')) i++;
      if (i >= len) break; // 未闭合块注释，终止解析
      i += 2; // 跳过闭合 */
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * 解析 JSONC 文本：先剥离注释再 JSON.parse，失败抛出带清晰信息的 Error。
 */
export function parseJsonc(text: string): unknown {
  const stripped = stripJsonc(text);
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`JSONC parse failed: ${msg}`);
  }
}

/**
 * 序列化对象为带缩进的 JSON 字符串，可选在头部添加注释行。
 * 若提供 headerComment，则每行前缀 "// "。
 */
export function stringifyJsonc(obj: unknown, headerComment?: string): string {
  const json = JSON.stringify(obj, null, 2);
  if (headerComment != null && headerComment.length > 0) {
    const lines = headerComment.split('\n').map(line => `// ${line}`);
    return `${lines.join('\n')}\n${json}`;
  }
  return json;
}
