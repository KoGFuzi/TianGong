import 'dotenv/config';
import * as readline from 'node:readline';
import { eventBus } from '../runtime/eventbus/splitter.ts';
import { runEngine } from './handoff-engine.ts';
import { getConfig } from '../config/config.ts';
import { runFirstRunWizard } from '../config/wizard.tsx';
import { handleMcpCommand, handleSkillCommand, initializeMcp, cleanup } from './commands.ts';

// ===== 默认 EventBus 事件监听（所有 console.log 集中在这里）=====

function registerDefaultEventHandlers(): void {
  eventBus.on('engine:start', ({ userInput }) => {
    console.log(`\n🚀 Engine started | Input: "${userInput}"`);
  });

  eventBus.on('agent:thinking', ({ agentId }) => {
    console.log(`\n🤔 [${agentId}] is thinking...`);
  });

  eventBus.on('llm:stream', ({ chunk }) => {
    process.stdout.write(chunk);
  });

  eventBus.on('engine:text', ({ agentId }) => {
    console.log(`\n  ── [${agentId}] finished ──`);
  });

  eventBus.on('agent:switch', ({ fromAgentId, toAgentId, reason }) => {
    console.log(`\n🔄 Handoff: ${fromAgentId} → ${toAgentId} | Reason: ${reason}`);
  });

  eventBus.on('tool:call', ({ agentId, toolName, args }) => {
    console.log(`\n🔧 [${agentId}] calls tool: ${toolName}`, args);
  });

  eventBus.on('tool:result', ({ agentId, toolName, result }) => {
    console.log(`\n✅ [${agentId}] tool result: ${toolName}`, result);
  });

  eventBus.on('engine:error', ({ agentId, error }) => {
    console.error(`\n❌ [${agentId ?? 'system'}] Error: ${error}`);
  });

  eventBus.on('engine:end', ({ reason, totalSteps }) => {
    console.log(`\n🏁 Engine ended | Reason: ${reason} | Steps: ${totalSteps}`);
  });
}

// ===== CLI 交互循环 =====

async function startCliLoop(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = (): Promise<string> =>
    new Promise(resolve => {
      rl.question('\n> ', resolve);
    });

  console.log('TianGong v2 - Multi-Agent Engine (Temporary CLI)');
  console.log('可用命令: /clear, /mcp, /exit, /skill\n');

  while (true) {
    const input = await askQuestion();
    const line = input.trim();
    if (line.length === 0) continue;

    // 交互命令处理（以 / 开头）
    if (line.startsWith('/')) {
      const [cmd, ...args] = line.slice(1).split(' ');
      switch (cmd) {
        case 'clear':
          console.clear();
          break;
        case 'mcp':
          console.log(await handleMcpCommand(args[0]));
          break;
        case 'exit':
          rl.close();
          await cleanup();
          console.log('再见！');
          process.exit(0);
          break;
        case 'skill':
          console.log(handleSkillCommand());
          break;
        default:
          console.log(`未知命令: /${cmd}。可用命令: /clear, /mcp, /exit, /skill`);
      }
      continue; // 不传递给 engine
    }

    // 兼容旧写法：直接输入 exit
    if (line.toLowerCase() === 'exit') {
      rl.close();
      await cleanup();
      console.log('再见！');
      process.exit(0);
    }

    await runEngine(line);
  }
}

// ===== Bootstrap 主流程 =====

async function main(): Promise<void> {
  // 1. 加载配置（含首次运行向导）
  await runFirstRunWizard();
  console.log(`TianGong v2 - Model: ${getConfig().llm.defaultModel} | Max Steps: ${getConfig().budget.maxStepsPerTask}`);

  // 2. 预热 MCP 服务器
  const mcpServers = getConfig().mcp.servers;
  if (mcpServers.length > 0) {
    console.log(`[MCP] 正在初始化 ${mcpServers.length} 个 MCP 服务器...`);
  }
  console.log(await initializeMcp());

  // 3. 注册默认事件监听
  registerDefaultEventHandlers();

  // 4. 启动 CLI 交互循环
  await startCliLoop();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
