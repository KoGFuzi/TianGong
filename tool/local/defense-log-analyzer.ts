import type { ToolExecutionResult } from '../executor.ts';

/** 日志分析统计 */
interface AnalysisStats {
  totalLines: number;
  matchedLines: number;
  criticalCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  otherCount: number;
}

/**
 * 日志分析工具
 * 读取日志文件，按 severity / pattern / timeRange 过滤，返回统计摘要和关键行
 */
export async function executeDefenseLogAnalyzer(params: {
  logPath: string;       // 日志文件路径
  pattern?: string | undefined;      // 过滤关键词/正则
  timeRange?: string | undefined;    // 如 "1h", "24h", "2024-01-01~2024-01-02"
  severity?: string | undefined;     // 'all' | 'error' | 'warning' | 'critical'
  maxLines?: number | undefined;     // 最大分析行数，默认 1000
}): Promise<ToolExecutionResult> {
  const { logPath, pattern, timeRange, severity = 'all', maxLines = 1000 } = params;

  if (!logPath || logPath.trim().length === 0) {
    return { success: false, error: 'logPath 不能为空' };
  }

  try {
    // 读取日志文件
    const content = await Bun.file(logPath).text();
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    // 限制分析行数
    const linesToAnalyze = allLines.slice(0, maxLines);

    // 编译正则（如果提供了 pattern）
    let patternRegex: RegExp | null = null;
    if (pattern != null && pattern.trim().length > 0) {
      try {
        patternRegex = new RegExp(pattern, 'i');
      } catch {
        // 如果不是有效正则，当作普通关键词
        patternRegex = new RegExp(escapeRegex(pattern), 'i');
      }
    }

    // 解析时间范围
    const timeFilter = parseTimeRange(timeRange);

    // 过滤和分析
    const matchedLines: string[] = [];
    const stats: AnalysisStats = {
      totalLines,
      matchedLines: 0,
      criticalCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      otherCount: 0,
    };

    for (const line of linesToAnalyze) {
      if (line.trim().length === 0) continue;

      // 按 severity 过滤
      if (severity !== 'all') {
        const lineSeverity = detectSeverity(line);
        if (!matchesSeverity(lineSeverity, severity)) continue;
      }

      // 按 pattern 过滤
      if (patternRegex != null && !patternRegex.test(line)) continue;

      // 按时间范围过滤
      if (timeFilter != null) {
        const lineTime = extractTimestamp(line);
        if (lineTime != null && !isInTimeRange(lineTime, timeFilter)) continue;
      }

      // 统计
      const lineSeverity = detectSeverity(line);
      switch (lineSeverity) {
        case 'critical': stats.criticalCount++; break;
        case 'error': stats.errorCount++; break;
        case 'warning': stats.warningCount++; break;
        case 'info': stats.infoCount++; break;
        default: stats.otherCount++; break;
      }

      stats.matchedLines++;

      // 收集匹配行（限制数量避免输出过大）
      if (matchedLines.length < 50) {
        matchedLines.push(line.trim());
      }
    }

    // 构建输出
    const summary = buildSummary(stats, matchedLines, logPath);
    return { success: true, output: summary };
  } catch (err) {
    if (err instanceof Error && err.message.includes('ENOENT')) {
      return { success: false, error: `日志文件不存在: ${logPath}` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `日志分析失败: ${errorMsg}` };
  }
}

/** 检测行中的日志级别 */
function detectSeverity(line: string): string {
  const lower = line.toLowerCase();
  // 常见日志级别关键词
  if (/\b(crit|critical|fatal|emerg|emergency|alert)\b/.test(lower)) return 'critical';
  if (/\b(error|err|fail|failed|failure|exception)\b/.test(lower)) return 'error';
  if (/\b(warn|warning)\b/.test(lower)) return 'warning';
  if (/\b(info|notice|debug)\b/.test(lower)) return 'info';
  return 'other';
}

/** 检查行级别是否匹配过滤条件 */
function matchesSeverity(lineSeverity: string, filter: string): boolean {
  switch (filter.toLowerCase()) {
    case 'critical': return lineSeverity === 'critical';
    case 'error': return lineSeverity === 'critical' || lineSeverity === 'error';
    case 'warning': return lineSeverity === 'critical' || lineSeverity === 'error' || lineSeverity === 'warning';
    default: return true;
  }
}

/** 转义正则特殊字符 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 时间范围解析结果 */
interface TimeFilter {
  start: Date;
  end: Date;
}

/** 解析时间范围字符串 */
function parseTimeRange(timeRange?: string): TimeFilter | null {
  if (timeRange == null || timeRange.trim().length === 0) return null;

  const now = new Date();

  // 相对时间：如 "1h", "24h", "30m", "7d"
  const relativeMatch = timeRange.match(/^(\d+)([hmd])$/i);
  if (relativeMatch != null) {
    const value = parseInt(relativeMatch[1]!, 10);
    const unit = relativeMatch[2]!.toLowerCase();
    const ms = unit === 'h' ? 3600_000 : unit === 'm' ? 60_000 : 86400_000;
    return { start: new Date(now.getTime() - value * ms), end: now };
  }

  // 绝对时间范围：如 "2024-01-01~2024-01-02"
  const rangeMatch = timeRange.match(/^(.+?)~(.+)$/);
  if (rangeMatch != null) {
    const start = new Date(rangeMatch[1]!.trim());
    const end = new Date(rangeMatch[2]!.trim());
    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
      return { start, end };
    }
  }

  return null;
}

/** 从日志行中提取时间戳 */
function extractTimestamp(line: string): Date | null {
  // 常见日志时间戳格式
  // ISO 格式: 2024-01-01T12:00:00
  const isoMatch = line.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  if (isoMatch != null) {
    const d = new Date(isoMatch[1]!);
    if (!isNaN(d.getTime())) return d;
  }

  // syslog 格式: Jan  1 12:00:00
  const syslogMatch = line.match(/([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2}:\d{2})/);
  if (syslogMatch != null) {
    const year = new Date().getFullYear();
    const d = new Date(`${syslogMatch[1]} ${syslogMatch[2]} ${year} ${syslogMatch[3]}`);
    if (!isNaN(d.getTime())) return d;
  }

  // 简单日期: 2024-01-01 12:00:00
  const simpleMatch = line.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (simpleMatch != null) {
    const d = new Date(simpleMatch[1]!);
    if (!isNaN(d.getTime())) return d;
  }

  return null;
}

/** 检查时间是否在范围内 */
function isInTimeRange(time: Date, filter: TimeFilter): boolean {
  return time >= filter.start && time <= filter.end;
}

/** 构建分析摘要输出 */
function buildSummary(stats: AnalysisStats, matchedLines: string[], logPath: string): string {
  const lines: string[] = [];
  lines.push(`=== 日志分析报告 ===`);
  lines.push(`文件: ${logPath}`);
  lines.push(`总行数: ${stats.totalLines}`);
  lines.push(`匹配行数: ${stats.matchedLines}`);
  lines.push('');
  lines.push('--- 级别统计 ---');
  lines.push(`  CRITICAL : ${stats.criticalCount}`);
  lines.push(`  ERROR    : ${stats.errorCount}`);
  lines.push(`  WARNING  : ${stats.warningCount}`);
  lines.push(`  INFO     : ${stats.infoCount}`);
  lines.push(`  OTHER    : ${stats.otherCount}`);
  lines.push('');

  if (matchedLines.length > 0) {
    lines.push('--- 关键匹配行（最多50条）---');
    for (const line of matchedLines) {
      lines.push(`  ${line}`);
    }
  } else {
    lines.push('--- 无匹配行 ---');
  }

  return lines.join('\n');
}
