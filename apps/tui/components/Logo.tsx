import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { useAppStore } from '../store.ts';

/*
 * TianGong Logo - hollow (outline) ASCII art with random color themes
 *
 * Left:  ASCII art "TIANGONG" (block font, 5 rows x 6 cols, hollow style)
 * Right: Title / subtitle / version info (with borderLeft separator)
 * Frame: Ink Box borderStyle="round"
 */

// -- Color themes --------------------------------------------------------

interface ColorTheme {
  readonly name: string;
  readonly artColor: string;
  readonly titleColor: string;
  readonly borderColor: string;
  readonly subtitleColor: string;
}

const THEMES: readonly ColorTheme[] = [
  {
    name: 'ember',
    artColor: 'red',
    titleColor: 'red',
    borderColor: 'red',
    subtitleColor: 'yellow',
  },
  {
    name: 'amber',
    artColor: 'yellow',
    titleColor: 'yellow',
    borderColor: 'yellow',
    subtitleColor: 'white',
  },
  {
    name: 'midnight',
    artColor: 'blue',
    titleColor: 'cyan',
    borderColor: 'blue',
    subtitleColor: 'gray',
  },
];

const activeTheme = THEMES[Math.floor(Math.random() * THEMES.length)]!;

// -- Block char constant -------------------------------------------------

const BK = '\u2588'; // full block

// -- Hollow letter definitions (6 wide x 5 tall) -------------------------

// prettier-ignore
const LETTERS: Record<string, readonly string[]> = {
  T: [
    BK+BK+BK+BK+BK+BK,
    '  '+BK+BK+'  ',
    '  '+BK+BK+'  ',
    '  '+BK+BK+'  ',
    '  '+BK+BK+'  ',
  ],
  I: [
    BK+BK+BK+BK+BK+BK,
    '  '+BK+BK+'  ',
    '  '+BK+BK+'  ',
    '  '+BK+BK+'  ',
    BK+BK+BK+BK+BK+BK,
  ],
  A: [
    ' '+BK+BK+BK+BK+' ',
    BK+'    '+BK,
    BK+BK+BK+BK+BK+BK,
    BK+'    '+BK,
    BK+'    '+BK,
  ],
  N: [
    BK+'   '+BK+' ',
    BK+BK+'  '+BK+' ',
    BK+' '+BK+' '+BK+' ',
    BK+'  '+BK+BK+' ',
    BK+'   '+BK+' ',
  ],
  G: [
    ' '+BK+BK+BK+BK+BK,
    BK+'     ',
    BK+'  '+BK+BK+BK,
    BK+'    '+BK,
    ' '+BK+BK+BK+BK+' ',
  ],
  O: [
    ' '+BK+BK+BK+BK+' ',
    BK+'    '+BK,
    BK+'    '+BK,
    BK+'    '+BK,
    ' '+BK+BK+BK+BK+' ',
  ],
};

const WORD = 'TIANGONG';
const LETTER_HEIGHT = 5;
const LETTER_WIDTH = 6;
const GAP = 1;

// -- Build ASCII art lines -----------------------------------------------

/** Visual width in terminal (█ = 2, most others = 1) */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x2500 ? 2 : 1;
  return w;
}

/** Pad string to a target *visual* width with spaces */
function padToVisualWidth(s: string, target: number): string {
  const diff = target - visualWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

function buildArtLines(): string[] {
  const rawRows: string[] = [];
  for (let row = 0; row < LETTER_HEIGHT; row++) {
    let line = '';
    for (let li = 0; li < WORD.length; li++) {
      const ch = WORD[li]!;
      const glyph = LETTERS[ch]!;
      if (li > 0) line += ' '.repeat(GAP);
      line += (glyph[row] ?? '').padEnd(LETTER_WIDTH);
    }
    rawRows.push(line);
  }
  // Pad every row to the same visual width so the block is rectangular
  const maxVW = Math.max(...rawRows.map(visualWidth));
  return rawRows.map((r) => padToVisualWidth(r, maxVW));
}

const ART_LINES = buildArtLines();

// -- Component -----------------------------------------------------------

const AGENT_LABELS: Record<string, { readonly icon: string; readonly color: string }> = {
  planner: { icon: '🧭', color: 'cyan' },
  research: { icon: '', color: 'green' },
  builder: { icon: '🔧', color: 'yellow' },
  operator: { icon: '', color: 'magenta' },
};



export function Logo(): React.JSX.Element {
  const { stdout } = useStdout();
  const termCols = stdout?.columns ?? 120;
  const innerW = termCols - 2; // subtract outer border chars (│ left + │ right)

  const activeAgent = useAppStore((s) => s.activeAgent);
  const isRunning = useAppStore((s) => s.isRunning);
  const currentTool = useAppStore((s) => s.currentTool);
  const stepCount = useAppStore((s) => s.stepCount);

  const label = AGENT_LABELS[activeAgent] ?? { icon: '●', color: 'white' };
  const bc = activeTheme.borderColor;

  return (
    <Box
      borderStyle="round"
      borderColor={bc}
      flexDirection="column"
      marginBottom={1}
    >
      {/* Top section: ASCII art + info */}
      <Box flexDirection="row" paddingX={1} paddingY={1}>
        {/* Left: ASCII art */}
        <Box flexDirection="column">
          {ART_LINES.map((line, i) => (
            <Text key={`art${i}`} color={activeTheme.artColor}>{line}</Text>
          ))}
        </Box>

        {/* Center separator: single vertical line spanning all rows */}
        <Box width={1} marginLeft={1} marginRight={1}>
          <Text color={bc}>{'│\n│\n│\n│\n│'}</Text>
        </Box>

        {/* Right: info rows */}
        <Box
          flexDirection="column"
          justifyContent="center"
        >
          <Text color={activeTheme.titleColor} bold>Tiangong v2.0</Text>
          <Text color={activeTheme.subtitleColor}>Multi-Agent Security Engine</Text>
          <Text>{' '}</Text>
          <Text color={activeTheme.titleColor} bold>Features</Text>
          <Text color={activeTheme.subtitleColor}>• AI SDK streaming • MCP tools</Text>
          <Text color={activeTheme.subtitleColor}>• Session persistence • Budget control</Text>
        </Box>
      </Box>

      {/* Separator line — exact width from terminal columns */}
      <Text color={bc}>{'─'.repeat(innerW)}</Text>

      {/* Bottom section: Status bar */}
      <Box paddingX={1}>
        <Text bold color={label.color as any}>{label.icon} {activeAgent}</Text>
        <Text dimColor> │ </Text>
        <Text dimColor>{isRunning ? '运行中' : '空闲'}</Text>
        {currentTool != null && (
          <>
            <Text dimColor> │ </Text>
            <Text color="yellow"> {currentTool}</Text>
          </>
        )}
        <Text dimColor> │ </Text>
        <Text dimColor>步骤 {stepCount}</Text>
      </Box>
    </Box>
  );
}
