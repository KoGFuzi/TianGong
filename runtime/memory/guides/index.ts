import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── 指南文件目录 ──────────────────────────────────────────────

const GUIDES_DIR = resolve(__dirname);

// ── 加载单个指南 ──────────────────────────────────────────────

/**
 * 从 guides 目录加载指定名称的指南文件内容。
 * guideName 为不含扩展名的文件名（如 "general"），对应 general.md。
 * 文件不存在时抛出错误。
 */
export function loadGuide(guideName: string): string {
  const filePath = resolve(GUIDES_DIR, `${guideName}.md`);
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    throw new Error(`Guide not found: ${guideName} (expected ${filePath})`);
  }
}

// ── 批量加载指南 ──────────────────────────────────────────────

/**
 * 批量加载多个指南，拼接为可注入 system prompt 的文本。
 * 如果 guideRefs 为空数组，返回空字符串（向后兼容）。
 */
export function loadGuides(guideRefs: readonly string[]): string {
  if (guideRefs.length === 0) {
    return '';
  }

  const sections = guideRefs.map(ref => {
    const content = loadGuide(ref);
    return `## Guide: ${ref}\n\n${content}`;
  });

  return sections.join('\n\n---\n\n');
}

// ── 列出可用指南 ──────────────────────────────────────────────

/**
 * 列出 guides 目录下所有可用的指南文件名（不含 .md 扩展名）。
 */
export function listGuides(): string[] {
  try {
    return readdirSync(GUIDES_DIR)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch {
    return [];
  }
}
