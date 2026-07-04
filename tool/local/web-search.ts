import type { ToolExecutionResult } from '../executor.ts';

const MAX_RESULTS = 5;
const SEARCH_TIMEOUT_MS = 10_000;

export async function executeWebSearch(query: string): Promise<ToolExecutionResult> {
  if (!query || query.trim().length === 0) {
    return { success: false, error: 'Empty search query' };
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const searchUrl = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
    const response = await fetch(searchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const html = await response.text();

    // 解析 Bing HTML 结果
    // 每个结果在 <li class="b_algo"> 中
    // 标题在 <h2><a href="..."> 中
    // 摘要在 <div class="b_caption"><p> 或 class="b_lineclamp..." 中
    const results = parseBingResults(html);

    if (results.length === 0) {
      return { success: true, output: 'No search results found.' };
    }

    const formatted = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.snippet}\n   URL: ${r.url}`).join('\n\n');
    return { success: true, output: `Search results for "${query}":\n\n${formatted}` };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { success: false, error: `Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s` };
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Web search failed: ${errorMsg}` };
  }
}

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

function parseBingResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  // 匹配 b_algo 结果块
  const resultBlocks = html.split(/class="b_algo"/);

  for (let i = 1; i < resultBlocks.length && results.length < MAX_RESULTS; i++) {
    const block = resultBlocks[i] ?? '';

    // 提取标题和URL - h2 > a
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;

    const url = decodeBingUrl(titleMatch[1] ?? '');
    const title = stripHtmlTags(titleMatch[2] ?? '').trim();

    // 提取摘要 - b_caption > p 或 b_lineclamp
    const snippetMatch = block.match(/class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/)
      || block.match(/class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/);
    const snippet = snippetMatch ? stripHtmlTags(snippetMatch[1] ?? '').trim() : '';

    if (title.length > 0) {
      results.push({ title, snippet, url });
    }
  }

  return results;
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

function decodeBingUrl(url: string): string {
  // Bing 有时用重定向 URL，尝试提取真实 URL
  const redirectMatch = url.match(/[?&]redirect=([^&]+)/);
  if (redirectMatch != null) {
    try {
      return decodeURIComponent(redirectMatch[1] ?? url);
    } catch {
      return url;
    }
  }
  return url;
}
