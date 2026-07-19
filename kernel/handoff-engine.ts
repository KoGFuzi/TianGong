import type { ModelMessage, ToolSet } from 'ai';
import { resolve } from 'node:path';
import { eventBus } from '../runtime/eventbus/splitter.ts';
import { SessionManager } from '../runtime/session/manager.ts';
import type { SessionState } from '../runtime/session/manager.ts';
import { getAgent } from './agents/index.ts';
import { streamAgentResponse } from '../model/provider.ts';
import type { StreamAgentResponse } from '../model/provider.ts';
import { normalizeToolCalls, formatToolResults } from './pipeline/adapter.ts';
import type { NormalizedToolCall } from './pipeline/adapter.ts';
import { injectToolsToPrompt, parseToolCallsFromText } from './pipeline/fallback.ts';
import { getToolsForAgent, buildToolSet, executeTool, getMcpToolsForAgent, buildMcpToolSet, mcpClient, allToolDefinitions } from '../tool/index.ts';
import { getConfig } from '../config/config.ts';
import { BudgetManager, estimateTokens, estimateMessagesTokens } from '../runtime/budget/index.ts';
import { compactToolOutput, compactOldToolResults } from './pipeline/compactor.ts';
import { shouldSummarize, summarizeMessages, compactMessagesWithSummary } from './pipeline/summarizer.ts';
import { TODOTracker } from './pipeline/todo-tracker.ts';

/**
 * 清洗消息历史：移除孤立的 tool 角色消息。
 *
 * OpenAI Chat Completions API 要求 role='tool' 的消息必须紧跟在
 * 带 tool_calls 的 assistant 消息之后。推理模型（如 DeepSeek V4 Pro）
 * 或 handoff 后的会话恢复可能产生孤立的 tool 消息，导致 400 错误。
 *
 * 策略：扫描每条 tool 消息，若前一条 assistant 消息中没有对应的
 * toolCallId，则将该 tool 消息转为 user 消息（保留上下文但不违反 API 约束）。
 */
function sanitizeMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;

  const result: ModelMessage[] = [];
  // 记录上一条 assistant 消息中的所有 toolCallId
  let lastAssistantToolCallIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // 提取 assistant 消息中的 tool-call ID
      const ids = new Set<string>();
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool-call') {
            const tcPart = part as { toolCallId: string };
            ids.add(tcPart.toolCallId);
          }
        }
      }
      lastAssistantToolCallIds = ids;
      result.push(msg);
    } else if (msg.role === 'tool') {
      // 检查 tool 消息中的 toolCallId 是否在上一条 assistant 消息中
      const content = msg.content;
      const toolCallIds: string[] = [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool-result') {
            const trPart = part as { toolCallId: string };
            toolCallIds.push(trPart.toolCallId);
          }
        }
      }
      const allMatch = toolCallIds.length > 0 && toolCallIds.every(id => lastAssistantToolCallIds.has(id));
      if (allMatch) {
        result.push(msg);
      } else {
        // 孤立 tool 消息 → 转为 user 消息，保留上下文信息
        const textParts = toolCallIds.map(id => `[工具结果 ${id}]`);
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === 'object' && part !== null && 'type' in part && part.type === 'tool-result') {
              const tr = part as { toolName: string; output?: { value?: unknown } };
              textParts.push(`[${tr.toolName}]: ${JSON.stringify(tr.output?.value ?? '')}`);
            }
          }
        }
        result.push({
          role: 'user',
          content: textParts.join('\n'),
        });
      }
    } else {
      // user / system 等角色直接保留，重置 toolCallId 集合
      lastAssistantToolCallIds = new Set();
      result.push(msg);
    }
  }

  return result;
}

/**
 * 检测模型是否支持原生 Tool Call（function calling）。
 * 基于模型 ID 前缀进行启发式判断。
 */
function modelSupportsNativeTools(modelId: string): boolean {
  // OpenAI: GPT-4 系列、GPT-3.5-turbo (0125+) 支持
  if (modelId.startsWith('gpt-4') || modelId.startsWith('gpt-3.5-turbo')) return true;
  // Anthropic: Claude 3+ 系列支持
  if (modelId.startsWith('claude-3') || modelId.startsWith('claude-4')) return true;
  // Google Gemini 系列支持
  if (modelId.startsWith('gemini-')) return true;
  // DeepSeek 系列（通过 Anthropic 兼容 API 支持原生 tool call）
  if (modelId.startsWith('deepseek-')) return true;
  // 未知模型默认不支持，走 fallback 路径
  return false;
}

/** 引擎退出原因 */
export type EngineExitReason = 'completed' | 'budget_exceeded' | 'max_steps' | 'error';

/** 引擎退出结果 */
export interface EngineExitResult {
  readonly reason: EngineExitReason;
  readonly totalSteps: number;
}

// ── 用户输入等待机制 ──────────────────────────────────────
let _inputResolver: ((input: string) => void) | null = null;

/**
 * 挂起引擎，等待外部提供新的用户输入。
 * 返回一个 Promise，直到 `provideUserInput()` 被调用才 resolve。
 */
function waitForUserInput(): Promise<string> {
  return new Promise<string>((resolveInput) => {
    _inputResolver = resolveInput;
  });
}

/**
 * 向引擎提供新的用户输入，恢复被挂起的引擎循环。
 * 由外层 CLI / TUI 在收到用户新消息后调用。
 */
export function provideUserInput(input: string): void {
  if (_inputResolver != null) {
    const resolver = _inputResolver;
    _inputResolver = null;
    resolver(input);
  }
}

export async function runEngine(userInput: string, sessionId?: string): Promise<EngineExitResult> {
  eventBus.emit('engine:start', { userInput });

  const budgetManager = new BudgetManager(getConfig().budget.maxTokensPerSession);

  // Session 初始化
  const sid = sessionId ?? crypto.randomUUID();
  const dbPath = resolve(__dirname, '../runtime/memory/tiangong.db');
  const sessionManager = new SessionManager(dbPath);

  // 辅助函数：异步保存状态
  const saveSessionState = (state: SessionState): void => {
    queueMicrotask(() => {
      try {
        sessionManager.saveState(sid, state);
      } catch {
        // 静默失败，不阻塞引擎
      }
    });
  };

  let activeAgentId = 'planner';
  let messages: ModelMessage[] = [{ role: 'user', content: userInput }];
  let stepCount = 0;
  const todoTracker = new TODOTracker();

  // 尝试恢复已有会话
  const savedState = sessionManager.loadState(sid);
  if (savedState != null) {
    activeAgentId = savedState.activeAgentId;
    messages = savedState.messages as ModelMessage[];
    stepCount = savedState.stepCount;
    if (savedState.todoList != null) {
      todoTracker.restore(savedState.todoList);
    }
  }

  try {
  while (stepCount < getConfig().budget.maxStepsPerTask) {
    const agent = getAgent(activeAgentId);
    stepCount++;

    // 每 10 步向 messages 注入系统提示，提醒 agent 考虑 handoff
    if (stepCount % 10 === 0 && stepCount > 0) {
      messages.push({
        role: 'user',
        content: `[系统提示：你已执行 ${stepCount} 步。如果长时间无进展，考虑总结当前发现并 handoff 给 Planner。]`,
      });
    }

    // 预算检查
    const budgetCheck = budgetManager.checkBudget(sid);
    if (!budgetCheck.allowed) {
      eventBus.emit('budget:exceeded', { sessionId: sid, usage: budgetCheck.usage ?? 0, limit: getConfig().budget.maxTokensPerSession });
      eventBus.emit('engine:end', { reason: 'budget_exceeded', totalSteps: stepCount });
      return { reason: 'budget_exceeded', totalSteps: stepCount };
    }

    eventBus.emit('agent:thinking', { agentId: agent.id });

    // 本地工具
    const toolDefs = getToolsForAgent(agent.id);
    const localTools = buildToolSet(toolDefs);

    // 获取 MCP 工具（仅在已连接时）
    let mcpToolSet: ToolSet = {};
    if (mcpClient.isConnected()) {
      try {
        const context = messages.map(m => typeof m.content === 'string' ? m.content : '').join(' ');
        const agentMcpTools = await getMcpToolsForAgent(agent.id, context);
        mcpToolSet = buildMcpToolSet(agentMcpTools);
      } catch {
        // MCP 工具获取失败，降级为纯本地工具
      }
    }

    // 合并工具集
    const tools: ToolSet = { ...localTools, ...mcpToolSet };

    // 模型能力检测：不支持原生 Tool Call 时，将工具定义注入 prompt
    const sub = getConfig().llm.subscriptions[agent.subscription];
    const supportsTools = sub != null && modelSupportsNativeTools(agent.modelId);
    const effectiveTools = supportsTools ? tools : ({} as ToolSet);

    // Fallback 路径：将工具定义合并到 systemPrompt，而非注入 system 消息
    let enhancedSystemPrompt: string | undefined;
    if (!supportsTools && Object.keys(tools).length > 0) {
      const agentToolDefs = allToolDefinitions.filter(
        d => d.allowedAgents.length === 0 || d.allowedAgents.includes(agent.id)
      );
      if (agentToolDefs.length > 0) {
        enhancedSystemPrompt = injectToolsToPrompt(agentToolDefs, agent.systemPrompt);
      }
    }

    let response: StreamAgentResponse;
    try {
      // 消息处理管线：sanitize → compactOldToolResults → checkAndSummarize → injectTODO
      let safeMessages = sanitizeMessages(messages);
      safeMessages = compactOldToolResults(safeMessages);

      // 检查是否需要触发摘要（每 5 步或 handoff 时检查）
      if (stepCount % 5 === 0 && shouldSummarize(safeMessages)) {
        const originalTokens = estimateMessagesTokens(safeMessages);
        const summary = await summarizeMessages(safeMessages, agent.subscription);
        safeMessages = await compactMessagesWithSummary(safeMessages, summary);
        const summaryTokens = estimateMessagesTokens(safeMessages);
        eventBus.emit('context:summarized', { originalTokens, summaryTokens });

        // 缓存摘要到会话状态
        saveSessionState({
          activeAgentId,
          messages: messages as unknown[],
          stepCount,
          summaryCache: summary,
          todoList: todoTracker.getAllTasks(),
        });
      }

      // 注入 TODO 状态到消息
      const formattedTODO = todoTracker.getFormattedTODO();
      if (formattedTODO.length > 0) {
        safeMessages.push({
          role: 'user',
          content: formattedTODO,
        });
      }

      response = await streamAgentResponse(agent, safeMessages, effectiveTools, enhancedSystemPrompt);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      eventBus.emit('engine:error', { agentId: agent.id, error: errorMessage });
      eventBus.emit('engine:end', { reason: 'error', totalSteps: stepCount });
      return { reason: 'error', totalSteps: stepCount };
    }

    // 追踪 token 使用
    if (response.text != null) {
      budgetManager.addUsage(sid, estimateTokens(response.text));
    }

    // 将模型回复消息追加到历史
    messages.push(...response.responseMessages);

    // 提取 TODO 并更新追踪器
    if (response.text) {
      const todoRegex = /- \[([ xX])\] (.+)/g;
      const newTodos: Array<{ text: string; done: boolean }> = [];
      let todoMatch: RegExpExecArray | null;
      while ((todoMatch = todoRegex.exec(response.text)) !== null) {
        newTodos.push({ text: todoMatch[2], done: todoMatch[1] !== ' ' });
      }
      if (newTodos.length > 0) {
        todoTracker.updateTODO(newTodos);
        eventBus.emit('todo:updated', { todoList: newTodos });
      }
    }

    // Fallback 路径：从文本中解析工具调用（不支持原生 Tool Call 的模型）
    let fallbackCalls: NormalizedToolCall[] = [];
    if (!supportsTools && response.text) {
      fallbackCalls = parseToolCallsFromText(response.text);
    }

    // 使用 normalizeToolCalls 归一化所有工具调用
    const allRawToolCalls = [
      ...response.toolCalls,
      ...fallbackCalls.map(fc => ({
        toolCallId: fc.id,
        toolName: fc.name,
        input: fc.arguments,
      })),
    ];
    const normalizedCalls = normalizeToolCalls(allRawToolCalls);

    saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount, todoList: todoTracker.getAllTasks() });

    // 发送完整文本事件
    if (response.text) {
      eventBus.emit('engine:text', { agentId: agent.id, text: response.text });
    }

    // 先执行所有业务工具（非 handoff），确保每个 tool-call 都有 tool-result
    const businessToolCalls = normalizedCalls.filter(
      tc => tc.name !== 'handoff_to_agent'
    );

    for (const tc of businessToolCalls) {
      eventBus.emit('tool:stream-start', {
        toolName: tc.name,
        args: tc.arguments,
      });

      // 统一通过 executeTool 入口执行（含 MCP 路由与鉴权）
      const result = await executeTool(tc.name, tc.arguments, sid, agent.id);

      eventBus.emit('tool:stream-end', {
        toolName: tc.name,
        result: result.output ?? result.error,
      });

      eventBus.emit('tool:result', {
        agentId: agent.id,
        toolName: tc.name,
        result: result.output ?? result.error,
      });

      // 使用 formatToolResults 格式化结果并注入消息历史
      // 使用 compactToolOutput 压缩工具输出后再注入消息历史
      const compactedResult = compactToolOutput(tc.name, result);

      // 发送事件
      eventBus.emit('context:compacted', {
        removedTokens: Math.max(0, estimateTokens(JSON.stringify(result.output ?? '')) - estimateTokens(JSON.stringify(compactedResult.output ?? ''))),
        toolName: tc.name,
      });

      if (supportsTools) {
        messages.push(formatToolResults(tc.id, tc.name, compactedResult));
      } else {
        // Fallback 路径：以文本消息形式注入工具结果
        const outputText = compactedResult.success
          ? JSON.stringify({ success: true, output: compactedResult.output })
          : JSON.stringify({ success: false, error: compactedResult.error });
        messages.push({
          role: 'user',
          content: `[工具结果 ${tc.name}]: ${outputText}`,
        });
      }
    }
    saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount, todoList: todoTracker.getAllTasks() });

    // 检查 handoff_to_agent 调用
    const handoffCall = normalizedCalls.find(
      tc => tc.name === 'handoff_to_agent'
    );

    if (handoffCall != null) {
      const input = handoffCall.arguments as {
        target_agent_id: string;
        reason: string;
        task: string;
      };

      // 校验目标 Agent 是否存在
      try {
        getAgent(input.target_agent_id);
      } catch {
        if (supportsTools) {
          messages.push(formatToolResults(handoffCall.id, handoffCall.name, {
            success: false,
            error: `Agent "${input.target_agent_id}" does not exist.`,
          }));
        } else {
          messages.push({
            role: 'user',
            content: `[工具结果 handoff_to_agent]: ${JSON.stringify({ error: `Agent "${input.target_agent_id}" does not exist.` })}`,
          });
        }
        continue;
      }

      // 校验 allowedHandoffs
      if (!agent.allowedHandoffs.includes(input.target_agent_id)) {
        if (supportsTools) {
          messages.push(formatToolResults(handoffCall.id, handoffCall.name, {
            success: false,
            error: `Not allowed to handoff to "${input.target_agent_id}". Allowed: [${agent.allowedHandoffs.join(', ')}]`,
          }));
        } else {
          messages.push({
            role: 'user',
            content: `[工具结果 handoff_to_agent]: ${JSON.stringify({ error: `Not allowed to handoff to "${input.target_agent_id}". Allowed: [${agent.allowedHandoffs.join(', ')}]` })}`,
          });
        }
        continue;
      }

      // 为 handoff_to_agent 工具调用提供 tool-result（闭合工具调用）
      if (supportsTools) {
        messages.push(formatToolResults(handoffCall.id, handoffCall.name, {
          success: true,
          output: JSON.stringify({ target: input.target_agent_id }),
        }));
      } else {
        messages.push({
          role: 'user',
          content: `[工具结果 handoff_to_agent]: ${JSON.stringify({ success: true, target: input.target_agent_id })}`,
        });
      }

      const prevAgentId = activeAgentId;
      activeAgentId = input.target_agent_id;

      eventBus.emit('agent:switch', {
        fromAgentId: prevAgentId,
        toAgentId: activeAgentId,
        reason: input.reason,
      });
      saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount, todoList: todoTracker.getAllTasks() });

      messages.push({
        role: 'user',
        content: `[Handoff from ${agent.name}]: ${input.task}`,
      });
      continue;
    }

    // 检查 task_complete 调用 → 任务完成，正常退出
    const taskCompleteCall = normalizedCalls.find(tc => tc.name === 'task_complete');
    if (taskCompleteCall != null) {
      const summary = (taskCompleteCall.arguments as { summary?: string }).summary ?? '';
      eventBus.emit('engine:end', { reason: 'completed', totalSteps: stepCount });
      return { reason: 'completed', totalSteps: stepCount };
    }

    // 如果有业务工具被执行，让模型根据工具结果继续思考
    if (businessToolCalls.length > 0) {
      continue;
    }

    // 无工具调用 → 纯文本输出，通知 UI 层等待用户输入
    eventBus.emit('engine:awaiting_input', {
      agentId: agent.id,
      message: response.text ?? '',
    });

    // 挂起引擎，等待用户提供新输入
    const newUserInput = await waitForUserInput();
    eventBus.emit('engine:user_input', { input: newUserInput });
    messages.push({ role: 'user', content: newUserInput });
    continue;
  }

  // maxStepsPerTask 安全阀耗尽
  eventBus.emit('engine:end', { reason: 'max_steps', totalSteps: stepCount });
  return { reason: 'max_steps', totalSteps: stepCount };
  } finally {
    sessionManager.close();
  }
}
