import React from 'react';
import { Box, Text } from 'ink';
import { useAppStore } from '../store.ts';
import type { ChatMessage } from '../store.ts';

const TYPE_STYLE: Record<string, { readonly prefix: string; readonly color: string }> = {
  thinking: { prefix: '💭', color: 'gray' },
  text: { prefix: '💬', color: 'white' },
  'tool-call': { prefix: '🔧', color: 'yellow' },
  'tool-result': { prefix: '✅', color: 'green' },
  handoff: { prefix: '🔄', color: 'cyan' },
  error: { prefix: '❌', color: 'red' },
  system: { prefix: '⚙', color: 'gray' },
};

function MessageLine({ msg }: { readonly msg: ChatMessage }): React.JSX.Element {
  const style = TYPE_STYLE[msg.type] ?? { prefix: '•', color: 'white' };
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={style.color as any}>{style.prefix} </Text>
        <Text dimColor>[{msg.agentId}] </Text>
        <Text wrap="wrap">{msg.content}</Text>
      </Text>
    </Box>
  );
}

export function ChatView(): React.JSX.Element {
  const messages = useAppStore((s) => s.messages);
  const streamingText = useAppStore((s) => s.streamingText);

  // 显示最近 20 条消息
  const visible = messages.slice(-20);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visible.map((msg) => (
        <MessageLine key={msg.id} msg={msg} />
      ))}
      {streamingText.length > 0 && (
        <Box flexDirection="column">
          <Text>
            <Text color="white">💬 </Text>
            <Text wrap="wrap">{streamingText}</Text>
            <Text color="gray">▊</Text>
          </Text>
        </Box>
      )}
    </Box>
  );
}
