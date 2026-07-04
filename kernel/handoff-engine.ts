import type { ModelMessage, ToolSet } from 'ai';
import { resolve } from 'node:path';
import { eventBus } from '../runtime/eventbus/splitter.ts';
import { SessionManager } from '../runtime/session/manager.ts';
import type { SessionState } from '../runtime/session/manager.ts';
import { getAgent } from './agents/index.ts';
import { streamAgentResponse } from '../model/provider.ts';
import type { StreamAgentResponse } from '../model/provider.ts';
import { getToolsForAgent, buildToolSet, executeTool, getMcpToolsForAgent, buildMcpToolSet, mcpClient } from '../tool/index.ts';
import type { ToolExecutionResult } from '../tool/index.ts';
import { getConfig } from '../config/config.ts';
import { BudgetManager, estimateTokens } from '../runtime/budget/index.ts';

export async function runEngine(userInput: string, sessionId?: string): Promise<void> {
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

  // 尝试恢复已有会话
  const savedState = sessionManager.loadState(sid);
  if (savedState != null) {
    activeAgentId = savedState.activeAgentId;
    messages = savedState.messages as ModelMessage[];
    stepCount = savedState.stepCount;
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
      return;
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

    let response: StreamAgentResponse;
    try {
      response = await streamAgentResponse(agent, messages, tools);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      eventBus.emit('engine:error', { agentId: agent.id, error: errorMessage });
      eventBus.emit('engine:end', { reason: 'error', totalSteps: stepCount });
      return;
    }

    // 追踪 token 使用
    if (response.text != null) {
      budgetManager.addUsage(sid, estimateTokens(response.text));
    }

    // 将模型回复消息追加到历史
    messages.push(...response.responseMessages);
    saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount });

    // 发送完整文本事件
    if (response.text) {
      eventBus.emit('engine:text', { agentId: agent.id, text: response.text });
    }

    // 先执行所有业务工具（非 handoff），确保每个 tool-call 都有 tool-result
    const businessToolCalls = response.toolCalls.filter(
      tc => tc.toolName !== 'handoff_to_agent'
    );

    for (const tc of businessToolCalls) {
      eventBus.emit('tool:stream-start', {
        toolName: tc.toolName,
        args: (tc.input as Record<string, unknown>) ?? {},
      });

      // 工具执行路由：MCP 工具 vs 本地工具
      let result: ToolExecutionResult;
      if (tc.toolName.startsWith('mcp_')) {
        result = await mcpClient.callTool(tc.toolName, tc.input as Record<string, unknown>);
      } else {
        result = await executeTool(tc.toolName, tc.input as Record<string, unknown>, sid);
      }

      eventBus.emit('tool:stream-end', {
        toolName: tc.toolName,
        result: result.output ?? result.error,
      });

      eventBus.emit('tool:result', {
        agentId: agent.id,
        toolName: tc.toolName,
        result: result.output ?? result.error,
      });

      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result' as const,
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: 'json' as const, value: result.success ? { success: true, output: result.output } : { success: false, error: result.error } },
        }],
      });
    }
    saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount });

    // 检查 handoff_to_agent 调用
    const handoffCall = response.toolCalls.find(
      tc => tc.toolName === 'handoff_to_agent'
    );

    if (handoffCall != null) {
      const input = handoffCall.input as {
        target_agent_id: string;
        reason: string;
        task: string;
      };

      // 校验目标 Agent 是否存在
      try {
        getAgent(input.target_agent_id);
      } catch {
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result' as const,
            toolCallId: handoffCall.toolCallId,
            toolName: 'handoff_to_agent',
            output: { type: 'json' as const, value: { error: `Agent "${input.target_agent_id}" does not exist.` } },
          }],
        });
        continue;
      }

      // 校验 allowedHandoffs
      if (!agent.allowedHandoffs.includes(input.target_agent_id)) {
        messages.push({
          role: 'tool',
          content: [{
            type: 'tool-result' as const,
            toolCallId: handoffCall.toolCallId,
            toolName: 'handoff_to_agent',
            output: { type: 'json' as const, value: { error: `Not allowed to handoff to "${input.target_agent_id}". Allowed: [${agent.allowedHandoffs.join(', ')}]` } },
          }],
        });
        continue;
      }

      // 为 handoff_to_agent 工具调用提供 tool-result（闭合工具调用）
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result' as const,
          toolCallId: handoffCall.toolCallId,
          toolName: 'handoff_to_agent',
          output: { type: 'json' as const, value: { success: true, target: input.target_agent_id } },
        }],
      });

      const prevAgentId = activeAgentId;
      activeAgentId = input.target_agent_id;

      eventBus.emit('agent:switch', {
        fromAgentId: prevAgentId,
        toAgentId: activeAgentId,
        reason: input.reason,
      });
      saveSessionState({ activeAgentId, messages: messages as unknown[], stepCount });

      messages.push({
        role: 'user',
        content: `[Handoff from ${agent.name}]: ${input.task}`,
      });
      continue;
    }

    // 如果有业务工具被执行，让模型根据工具结果继续思考
    if (businessToolCalls.length > 0) {
      continue;
    }

    // 无工具调用 → 纯文本输出，任务完成
    eventBus.emit('engine:end', { reason: 'no_handoff', totalSteps: stepCount });
    return;
  }

  eventBus.emit('engine:end', { reason: 'handoff_limit', totalSteps: stepCount });
  } finally {
    sessionManager.close();
  }
}
