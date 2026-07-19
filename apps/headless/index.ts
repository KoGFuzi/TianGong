import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventBus } from '../../runtime/eventbus/splitter.ts';
import { runEngine } from '../../kernel/handoff-engine.ts';

// JSON Lines 输出
function emit(event: string, data: unknown): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...(data as Record<string, unknown>),
  });
  process.stdout.write(line + '\n');
}

// 订阅所有事件
const eventHandlers: Record<string, (data: unknown) => void> = {
  'engine:start': (d: unknown) => emit('engine:start', d),
  'agent:thinking': (d: unknown) => emit('agent:thinking', d),
  'agent:switch': (d: unknown) => emit('agent:switch', d),
  'tool:call': (d: unknown) => emit('tool:call', d),
  'tool:result': (d: unknown) => emit('tool:result', d),
  'engine:text': (d: unknown) => emit('engine:text', d),
  'engine:error': (d: unknown) => emit('engine:error', d),
  'engine:end': (d: unknown) => emit('engine:end', d),
  'llm:stream': (d: unknown) => emit('llm:stream', d),
  'tool:stream-start': (d: unknown) => emit('tool:stream-start', d),
  'tool:stream-end': (d: unknown) => emit('tool:stream-end', d),
  'budget:exceeded': (d: unknown) => emit('budget:exceeded', d),
};

for (const [event, handler] of Object.entries(eventHandlers)) {
  eventBus.on(event, handler);
}

// CLI 入口
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // 非交互模式：检查配置文件是否存在，不存在时发出警告（不阻塞）
  const llmConfigPath = resolve(__dirname, '../../config/LLMconfig.jsonc');
  if (!existsSync(llmConfigPath)) {
    emit('headless:warning', {
      message: 'LLMconfig.jsonc not found. Run interactive mode (bun run start) to set up configuration, or use environment variables.'
    });
  }

  if (args.length === 0) {
    // 从 stdin 读取（管道模式）
    emit('headless:init', { mode: 'stdin' });

    const chunks: string[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(String(chunk));
    }
    const input = chunks.join('').trim();

    if (input.length > 0) {
      await runEngine(input);
    }
  } else {
    // 命令行参数模式
    const input = args.join(' ');
    emit('headless:init', { mode: 'args', input });
    await runEngine(input);
  }

  emit('headless:exit', {});
}

main().catch((err: unknown) => {
  const errorMsg = err instanceof Error ? err.message : String(err);
  emit('headless:fatal', { error: errorMsg });
  emit('headless:exit', { code: 1 });
  process.exit(1);
});
