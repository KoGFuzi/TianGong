import { create } from 'zustand';
import { eventBus } from '../../runtime/eventbus/splitter.ts';

export interface ChatMessage {
  readonly id: string;
  readonly agentId: string;
  readonly type: 'thinking' | 'text' | 'tool-call' | 'tool-result' | 'handoff' | 'error' | 'system';
  readonly content: string;
  readonly timestamp: number;
}

interface AppState {
  readonly messages: ChatMessage[];
  readonly activeAgent: string;
  readonly isRunning: boolean;
  readonly engineWaiting: boolean; // 引擎挂起等待用户新输入
  readonly streamingText: string;
  readonly currentTool: string | null;
  readonly stepCount: number;
  readonly lastInput: string;

  // Actions
  addMessage: (msg: Omit<ChatMessage, 'id' | 'timestamp'>) => void;
  setActiveAgent: (agentId: string) => void;
  setRunning: (running: boolean) => void;
  setEngineWaiting: (waiting: boolean) => void;
  appendStream: (chunk: string) => void;
  clearStream: () => void;
  setCurrentTool: (tool: string | null) => void;
  setStepCount: (count: number) => void;
  clearMessages: () => void;
  setLastInput: (input: string) => void;
}

let msgCounter = 0;

export const useAppStore = create<AppState>()((set) => ({
  messages: [],
  activeAgent: 'planner',
  isRunning: false,
  engineWaiting: false,
  streamingText: '',
  currentTool: null,
  stepCount: 0,
  lastInput: '',

  addMessage: (msg) => set((state) => ({
    messages: [...state.messages, { ...msg, id: `msg_${++msgCounter}`, timestamp: Date.now() }],
  })),
  setActiveAgent: (agentId) => set({ activeAgent: agentId }),
  setRunning: (running) => set({ isRunning: running }),
  setEngineWaiting: (waiting) => set({ engineWaiting: waiting }),
  appendStream: (chunk) => set((state) => ({ streamingText: state.streamingText + chunk })),
  clearStream: () => set({ streamingText: '' }),
  setCurrentTool: (tool) => set({ currentTool: tool }),
  setStepCount: (count) => set({ stepCount: count }),
  clearMessages: () => set({ messages: [] }),
  setLastInput: (input) => set({ lastInput: input }),
}));

// EventBus → Store 绑定
export function bindEventBus(): void {
  eventBus.on('engine:start', ({ userInput }) => {
    useAppStore.getState().setRunning(true);
    useAppStore.getState().setLastInput(userInput);
    useAppStore.getState().addMessage({ agentId: 'system', type: 'system', content: `> ${userInput}` });
  });

  eventBus.on('agent:thinking', ({ agentId }) => {
    useAppStore.getState().setActiveAgent(agentId);
    useAppStore.getState().addMessage({ agentId, type: 'thinking', content: '思考中...' });
  });

  eventBus.on('agent:switch', ({ fromAgentId, toAgentId, reason }) => {
    useAppStore.getState().setActiveAgent(toAgentId);
    useAppStore.getState().addMessage({
      agentId: toAgentId,
      type: 'handoff',
      content: `${fromAgentId ?? 'system'} → ${toAgentId}: ${reason}`,
    });
  });

  eventBus.on('llm:stream', ({ chunk }) => {
    useAppStore.getState().appendStream(chunk);
  });

  eventBus.on('engine:text', ({ agentId }) => {
    const stream = useAppStore.getState().streamingText;
    if (stream.length > 0) {
      useAppStore.getState().addMessage({ agentId, type: 'text', content: stream });
    }
    useAppStore.getState().clearStream();
  });

  eventBus.on('tool:stream-start', ({ toolName, args }) => {
    useAppStore.getState().setCurrentTool(toolName);
    useAppStore.getState().addMessage({
      agentId: useAppStore.getState().activeAgent,
      type: 'tool-call',
      content: `${toolName}(${JSON.stringify(args).slice(0, 80)})`,
    });
  });

  eventBus.on('tool:stream-end', ({ toolName, result }) => {
    useAppStore.getState().setCurrentTool(null);
    const resultStr = typeof result === 'string' ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200);
    useAppStore.getState().addMessage({
      agentId: useAppStore.getState().activeAgent,
      type: 'tool-result',
      content: `${toolName}: ${resultStr}`,
    });
  });

  eventBus.on('engine:error', ({ agentId, error }) => {
    useAppStore.getState().addMessage({ agentId: agentId ?? 'system', type: 'error', content: error });
  });

  // 引擎完成一轮输出，挂起等待用户新输入 → 解除 isRunning 锁定
  eventBus.on('engine:awaiting_input', ({ agentId, message }) => {
    if (message.length > 0) {
      const stream = useAppStore.getState().streamingText;
      if (stream.length > 0) {
        useAppStore.getState().addMessage({ agentId, type: 'text', content: stream });
      }
      useAppStore.getState().clearStream();
    }
    useAppStore.getState().setRunning(false);
    useAppStore.getState().setEngineWaiting(true);
  });

  eventBus.on('engine:end', ({ reason, totalSteps }) => {
    useAppStore.getState().setRunning(false);
    useAppStore.getState().setEngineWaiting(false);
    useAppStore.getState().setStepCount(totalSteps);
    useAppStore.getState().clearStream();
    useAppStore.getState().addMessage({ agentId: 'system', type: 'system', content: `结束 | ${reason} | ${totalSteps} 步` });
  });
}
