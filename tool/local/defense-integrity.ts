import type { ToolExecutionResult } from '../executor.ts';
import { createHash } from 'node:crypto';
import { readdir, stat, readFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

/** 基线条目 */
interface BaselineEntry {
  path: string;
  hash: string;
  size: number;
  mtime: string;
}

/** 基线 JSON 结构 */
interface Baseline {
  algorithm: string;
  createdAt: string;
  targetPath: string;
  files: BaselineEntry[];
}

/** 差异报告 */
interface DiffReport {
  added: string[];
  modified: string[];
  deleted: string[];
  unchanged: number;
}

/**
 * 文件完整性检查工具
 * 计算文件/目录哈希值，支持与基线对比检测篡改
 */
export async function executeDefenseIntegrity(params: {
  targetPath: string;     // 文件或目录路径
  algorithm?: string | undefined;     // 哈希算法，默认 'sha256'
  baseline?: string | undefined;      // 基线文件路径（JSON 格式），用于对比
}): Promise<ToolExecutionResult> {
  const { targetPath, algorithm = 'sha256', baseline } = params;

  if (!targetPath || targetPath.trim().length === 0) {
    return { success: false, error: 'targetPath 不能为空' };
  }

  try {
    const resolvedPath = resolve(targetPath);
    const pathStat = await stat(resolvedPath);

    // 收集文件哈希
    let currentFiles: BaselineEntry[];

    if (pathStat.isFile()) {
      const hash = await computeFileHash(resolvedPath, algorithm);
      currentFiles = [{
        path: resolvedPath,
        hash,
        size: pathStat.size,
        mtime: pathStat.mtime.toISOString(),
      }];
    } else if (pathStat.isDirectory()) {
      currentFiles = await scanDirectory(resolvedPath, algorithm);
    } else {
      return { success: false, error: `不支持的路径类型: ${resolvedPath}` };
    }

    // 如果提供了基线，进行对比
    if (baseline != null && baseline.trim().length > 0) {
      return await compareWithBaseline(baseline, currentFiles, resolvedPath, algorithm);
    }

    // 没有基线，生成基线并返回
    const baselineData: Baseline = {
      algorithm,
      createdAt: new Date().toISOString(),
      targetPath: resolvedPath,
      files: currentFiles,
    };

    const lines: string[] = [];
    lines.push(`=== 文件完整性基线 ===`);
    lines.push(`目标: ${resolvedPath}`);
    lines.push(`算法: ${algorithm}`);
    lines.push(`文件数: ${currentFiles.length}`);
    lines.push(`生成时间: ${baselineData.createdAt}`);
    lines.push('');
    lines.push('--- 文件哈希列表 ---');

    for (const entry of currentFiles) {
      const displayPath = pathStat.isFile() ? resolvedPath : relative(resolvedPath, entry.path);
      lines.push(`  ${entry.hash}  ${displayPath}  (${formatSize(entry.size)})`);
    }

    lines.push('');
    lines.push('提示: 将以下内容保存为 JSON 文件，可作为后续对比基线:');
    lines.push(JSON.stringify(baselineData, null, 2));

    return { success: true, output: lines.join('\n') };
  } catch (err) {
    if (err instanceof Error && err.message.includes('ENOENT')) {
      return { success: false, error: `路径不存在: ${targetPath}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `完整性检查失败: ${errorMsg}` };
  }
}

/** 计算单个文件的哈希值 */
async function computeFileHash(filePath: string, algorithm: string): Promise<string> {
  const content = await readFile(filePath);
  const hash = createHash(algorithm);
  hash.update(content);
  return hash.digest('hex');
}

/** 递归扫描目录，计算所有文件哈希 */
async function scanDirectory(dirPath: string, algorithm: string): Promise<BaselineEntry[]> {
  const entries: BaselineEntry[] = [];
  const items = await readdir(dirPath, { withFileTypes: true });

  for (const item of items) {
    const fullPath = join(dirPath, item.name);

    if (item.isDirectory()) {
      // 递归扫描子目录
      const subEntries = await scanDirectory(fullPath, algorithm);
      entries.push(...subEntries);
    } else if (item.isFile()) {
      try {
        const fileStat = await stat(fullPath);
        const hash = await computeFileHash(fullPath, algorithm);
        entries.push({
          path: fullPath,
          hash,
          size: fileStat.size,
          mtime: fileStat.mtime.toISOString(),
        });
      } catch {
        // 跳过无法读取的文件
        entries.push({
          path: fullPath,
          hash: 'ERROR',
          size: 0,
          mtime: '',
        });
      }
    }
    // 跳过符号链接等特殊文件
  }

  return entries;
}

/** 与基线对比，生成差异报告 */
async function compareWithBaseline(
  baselinePath: string,
  currentFiles: BaselineEntry[],
  targetPath: string,
  algorithm: string,
): Promise<ToolExecutionResult> {
  let baselineContent: string;
  try {
    baselineContent = await readFile(baselinePath, 'utf-8');
  } catch {
    return { success: false, error: `基线文件不存在或无法读取: ${baselinePath}` };
  }

  let baseline: Baseline;
  try {
    baseline = JSON.parse(baselineContent) as Baseline;
  } catch {
    return { success: false, error: `基线文件格式错误（非有效 JSON）: ${baselinePath}` };
  }

  // 构建映射
  const baselineMap = new Map<string, BaselineEntry>();
  for (const entry of baseline.files) {
    baselineMap.set(entry.path, entry);
  }

  const currentMap = new Map<string, BaselineEntry>();
  for (const entry of currentFiles) {
    currentMap.set(entry.path, entry);
  }

  // 对比
  const report: DiffReport = {
    added: [],
    modified: [],
    deleted: [],
    unchanged: 0,
  };

  // 检查当前文件 vs 基线
  for (const [path, current] of currentMap) {
    const base = baselineMap.get(path);
    if (base == null) {
      report.added.push(path);
    } else if (base.hash !== current.hash) {
      report.modified.push(path);
    } else {
      report.unchanged++;
    }
  }

  // 检查基线中有但当前没有的文件
  for (const [path] of baselineMap) {
    if (!currentMap.has(path)) {
      report.deleted.push(path);
    }
  }

  // 构建输出
  const lines: string[] = [];
  lines.push(`=== 完整性对比报告 ===`);
  lines.push(`目标: ${targetPath}`);
  lines.push(`基线: ${baselinePath}`);
  lines.push(`基线时间: ${baseline.createdAt}`);
  lines.push(`算法: ${algorithm}`);
  lines.push('');
  lines.push(`--- 对比结果 ---`);
  lines.push(`  未变更: ${report.unchanged}`);
  lines.push(`  新增  : ${report.added.length}`);
  lines.push(`  修改  : ${report.modified.length}`);
  lines.push(`  删除  : ${report.deleted.length}`);
  lines.push('');

  const hasChanges = report.added.length > 0 || report.modified.length > 0 || report.deleted.length > 0;

  if (report.added.length > 0) {
    lines.push('--- 新增文件 ---');
    for (const p of report.added) {
      lines.push(`  [NEW] ${p}`);
    }
    lines.push('');
  }

  if (report.modified.length > 0) {
    lines.push('--- 修改文件 ---');
    for (const p of report.modified) {
      const oldEntry = baselineMap.get(p);
      const newEntry = currentMap.get(p);
      lines.push(`  [MODIFIED] ${p}`);
      lines.push(`    基线哈希: ${oldEntry?.hash ?? 'N/A'}`);
      lines.push(`    当前哈希: ${newEntry?.hash ?? 'N/A'}`);
    }
    lines.push('');
  }

  if (report.deleted.length > 0) {
    lines.push('--- 删除文件 ---');
    for (const p of report.deleted) {
      lines.push(`  [DELETED] ${p}`);
    }
    lines.push('');
  }

  if (!hasChanges) {
    lines.push('✓ 所有文件与基线一致，未检测到篡改。');
  } else {
    const total = report.added.length + report.modified.length + report.deleted.length;
    lines.push(`⚠ 检测到 ${total} 处变更，请检查是否为合法修改。`);
  }

  return { success: true, output: lines.join('\n') };
}

/** 格式化文件大小 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
