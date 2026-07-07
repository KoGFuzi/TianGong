import React, { useState, useCallback } from 'react';
import { render, Box, Text, useInput } from 'ink';
import { ChatView } from './components/ChatView.tsx';
import { Logo } from './components/Logo.tsx';
import { useAppStore, bindEventBus } from './store.ts';
import { runEngine } from '../../kernel/handoff-engine.ts';
import { runFirstRunWizard } from '../../config/wizard.tsx';
import { getConfig } from '../../config/config.ts';
import { mcpLifecycle } from '../../tool/mcp/lifecycle.ts';
import { handleMcpCommand, handleSkillCommand, cleanup } from '../../kernel/commands.ts';

function App(): React.JSX.Element {
  const [input, setInput] = useState('');
  const isRunning = useAppStore((s) => s.isRunning);

  const handleSubmit = useCallback(async () => {
    if (input.trim().length === 0 || isRunning) return;
    const query = input.trim();

    // / 命令拦截
    if (query.startsWith('/')) {
      const [cmd, ...args] = query.slice(1).split(' ');
      switch (cmd) {
        case 'clear':
          useAppStore.getState().clearMessages();
          setInput('');
          return;
        case 'mcp': {
          const result = await handleMcpCommand(args[0]);
          useAppStore.getState().addMessage({ agentId: 'system', type: 'system', content: result });
          setInput('');
          return;
        }
        case 'exit':
          try { await cleanup(); } catch { /* 忽略清理错误 */ }
          process.exit(0);
          return;
        case 'skill': {
          const result = handleSkillCommand();
          useAppStore.getState().addMessage({ agentId: 'system', type: 'system', content: result });
          setInput('');
          return;
        }
        default: {
          useAppStore.getState().addMessage({
            agentId: 'system',
            type: 'system',
            content: `未知命令: /${cmd}。可用命令: /clear, /mcp, /exit, /skill`,
          });
          setInput('');
          return;
        }
      }
    }

    setInput('');
    await runEngine(query);
  }, [input, isRunning]);

  // 简易输入处理（Ink TextInput 兼容性）
  useInput((char, key) => {
    if (key.return) {
      void handleSubmit();
    } else if (key.backspace || key.delete) {
      setInput((prev) => prev.slice(0, -1));
    } else if (char != null && !key.ctrl && !key.meta) {
      setInput((prev) => prev + char);
    }
  });

  return (
    <Box flexDirection="column" height="100%">
      <Logo />
      <ChatView />
      <Box borderStyle="single" borderColor="gray" paddingX={1}>
        <Text color="green" bold>{'> '}</Text>
        <Text>{input}</Text>
        {!isRunning && <Text color="gray">▊</Text>}
      </Box>
    </Box>
  );
}

// 启动
(async () => {
  await runFirstRunWizard();

  // MCP 初始化
  const mcpServers = getConfig().mcp.servers;
  if (mcpServers.length > 0) {
    try {
      await mcpLifecycle.start(mcpServers);
    } catch (err) {
      console.log(`[MCP] 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  bindEventBus();
  render(<App />, { exitOnCtrlC: true });
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
