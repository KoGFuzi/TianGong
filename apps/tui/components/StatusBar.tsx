import React from 'react';
import { Box, Text } from 'ink';
import { useAppStore } from '../store.ts';
import { AGENT_LABELS } from '../constants.ts';

export function StatusBar(): React.JSX.Element {
  const activeAgent = useAppStore((s) => s.activeAgent);
  const isRunning = useAppStore((s) => s.isRunning);
  const currentTool = useAppStore((s) => s.currentTool);
  const stepCount = useAppStore((s) => s.stepCount);

  const label = AGENT_LABELS[activeAgent] ?? { icon: '●', color: 'white' };

  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold color={label.color as any}>{label.icon} {activeAgent}</Text>
      <Text dimColor> │ </Text>
      <Text dimColor>{isRunning ? '运行中' : '空闲'}</Text>
      {currentTool != null && (
        <>
          <Text dimColor> │ </Text>
          <Text color="yellow">⏳ {currentTool}</Text>
        </>
      )}
      <Text dimColor> │ </Text>
      <Text dimColor>步骤 {stepCount}</Text>
    </Box>
  );
}
