import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Box, Text, useInput, useApp } from 'ink';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stringifyJsonc } from './jsonc.ts';
import type { AgentModelConfig, ThinkingLevel } from './config.ts';
import { resetConfig, LOCAL_PROVIDER_PRESETS, CLOUD_PROVIDER_PRESETS } from './config.ts';

// ── 内部类型 ────────────────────────────────────────────────

type Phase =
  | 'subscription_type'
  | 'subscription_details'
  | 'more_subscriptions'
  | 'agent_subscription'
  | 'agent_model_fetching'
  | 'agent_model_select'
  | 'agent_model'
  | 'agent_thinking'
  | 'preview'
  | 'done';

interface SubData {
  provider: 'openai' | 'anthropic' | 'ollama' | 'lm-studio';
  baseURL: string;
  apiKey: string;
}

interface AgentData {
  subscription: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

interface FetchedModel {
  id: string;
  ownedBy?: string;
}

const MODEL_FETCH_TIMEOUT_MS = 8_000;

/**
 * 调用 {baseURL}/models 获取可用模型列表。
 * 兼容 OpenAI 标准 /models 接口（含 Ollama、LM Studio、DeepSeek、Kimi、Qwen 等）。
 */
async function fetchModelList(sub: SubData): Promise<FetchedModel[]> {
  const base = sub.baseURL.replace(/\/+$/, '');
  const url = `${base}/models`;
  const headers: Record<string, string> = {};
  if (sub.apiKey !== '') {
    headers['Authorization'] = `Bearer ${sub.apiKey}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json() as { data?: Array<{ id: string; owned_by?: string }>; models?: Array<{ id: string; owned_by?: string }> };
    const raw = data.data ?? data.models ?? [];
    const models: FetchedModel[] = raw.map(m => ({ id: m.id, ...(m.owned_by != null ? { ownedBy: m.owned_by } : {}) }));
    // 按 id 排序，方便查找
    models.sort((a, b) => a.id.localeCompare(b.id));
    return models;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface SelectOption {
  label: string;
  value: string;
}

// ── 常量 ────────────────────────────────────────────────────

const AGENT_NAMES = ['planner', 'research', 'builder', 'operator'] as const;

const EMPTY_SUB: SubData = { provider: 'openai', baseURL: '', apiKey: '' };

/** 步骤停留超过此毫秒数后显示「按 n 跳过」提示 */
const STUCK_HINT_MS = 5_000;

// ── TextInput 组件 ──────────────────────────────────────────

function TextInput(props: {
  onSubmit: (value: string) => void;
  defaultValue?: string;
  mask?: boolean;
  placeholder?: string;
}): React.JSX.Element {
  const [value, setValue] = useState(props.defaultValue ?? '');

  useInput((char, key) => {
    if (key.return) {
      props.onSubmit(value);
    } else if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1));
    } else if (char != null && !key.ctrl && !key.meta) {
      setValue(prev => prev + char);
    }
  });

  const display = props.mask === true ? '*'.repeat(value.length) : value;

  return (
    <Box>
      <Text color="green">{'> '}</Text>
      {display.length > 0 ? (
        <Text>{display}</Text>
      ) : (
        <Text color="gray">{props.placeholder ?? ''}</Text>
      )}
      <Text color="gray">▊</Text>
    </Box>
  );
}

// ── Select 组件 ─────────────────────────────────────────────

function Select(props: {
  options: SelectOption[];
  onSelect: (value: string) => void;
}): React.JSX.Element {
  const [highlight, setHighlight] = useState(0);

  useInput((_char, key) => {
    if (key.upArrow) {
      setHighlight(prev => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setHighlight(prev => Math.min(props.options.length - 1, prev + 1));
    } else if (key.return) {
      const opt = props.options[highlight];
      if (opt != null) props.onSelect(opt.value);
    }
  });

  return (
    <Box flexDirection="column">
      {props.options.map((opt, i) => (
        <Text key={opt.value}>
          {i === highlight ? '> ' : '  '}
          {opt.label}
        </Text>
      ))}
    </Box>
  );
}

// ── 向导主组件 ──────────────────────────────────────────────

function Wizard(props: { onComplete: () => void }): React.JSX.Element {
  const { exit } = useApp();

  // ── 核心状态 ──
  const [phase, setPhase] = useState<Phase>('subscription_type');
  const [subscriptions, setSubscriptions] = useState<Record<string, SubData>>({});
  const [currentSubType, setCurrentSubType] = useState<string>('coding');
  const [currentSubData, setCurrentSubData] = useState<SubData>({ ...EMPTY_SUB });
  const [detailStep, setDetailStep] = useState(0); // 0=provider 1=baseURL 2=apiKey

  const [agents, setAgents] = useState<Record<string, AgentData>>({});
  const [currentAgentIndex, setCurrentAgentIndex] = useState(0);
  const [currentAgentData, setCurrentAgentData] = useState<AgentData>({ subscription: '', modelId: '', thinkingLevel: 'medium' });
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // ── 卡死检测 + 防竞态推进锁 ──
  const phaseEnteredAt = useRef(Date.now());
  const [showStuckHint, setShowStuckHint] = useState(false);
  // 防止同一帧内 Enter（子组件 TextInput）与 'n'（Wizard 级 useInput）
  // 同时触发 exit()/onComplete() 导致双重卸载
  const advancingRef = useRef(false);

  useEffect(() => {
    phaseEnteredAt.current = Date.now();
    setShowStuckHint(false);
    advancingRef.current = false; // 阶段切换后重置锁
    const timer = setTimeout(() => setShowStuckHint(true), STUCK_HINT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // 备用推进：按 'n' 强制退出（仅在 done 阶段，Enter 失效时可用）
  useInput((char) => {
    if (char === 'n' && showStuckHint && phase === 'done') {
      if (advancingRef.current) return;
      advancingRef.current = true;
      exit();
      props.onComplete();
    }
    // 拉取模型阶段按 'n' 跳过，转手动输入
    if (char === 'n' && phase === 'agent_model_fetching') {
      setPhase('agent_model');
    }
  });

  // ── 写入配置文件 ──
  const writeFiles = useCallback(() => {
    // 构建 subscriptions 对象
    const subsOut: Record<string, Record<string, string>> = {};
    for (const [key, s] of Object.entries(subscriptions)) {
      const obj: Record<string, string> = {
        provider: s.provider,
        baseURL: s.baseURL,
      };
      if (s.apiKey !== '') {
        obj['apiKey'] = s.apiKey;
      }
      subsOut[key] = obj;
    }

    // 构建 agents 对象
    const agentsOut: Record<string, AgentModelConfig> = {};
    for (const name of AGENT_NAMES) {
      const a = agents[name];
      if (a != null) {
        agentsOut[name] = {
          subscription: a.subscription,
          modelId: a.modelId,
          thinkingLevel: a.thinkingLevel,
        };
      }
    }

    const llmConfig = {
      subscriptions: subsOut,
      agents: agentsOut,
    };
    writeFileSync(
      resolve(__dirname, 'LLMconfig.jsonc'),
      stringifyJsonc(llmConfig, 'TianGong v2 LLM 配置'),
    );

    // 仅在 mcp.jsonc 不存在时写入，避免覆盖用户已有配置
    const mcpPath = resolve(__dirname, 'mcp.jsonc');
    if (!existsSync(mcpPath)) {
      writeFileSync(
        mcpPath,
        stringifyJsonc({ servers: [], timeout: 15000 }, 'TianGong v2 MCP 配置'),
      );
    }

    setPhase('done');
  }, [subscriptions, agents]);

  // ── 重置所有状态（重新配置时使用） ──
  const resetAll = useCallback(() => {
    setSubscriptions({});
    setCurrentSubType('coding');
    setCurrentSubData({ ...EMPTY_SUB });
    setDetailStep(0);
    setAgents({});
    setCurrentAgentIndex(0);
    setCurrentAgentData({ subscription: '', modelId: '', thinkingLevel: 'medium' });
    setPhase('subscription_type');
  }, []);

  // ── 阶段 A：选订阅类型 ──
  const handleSubscriptionTypeSelect = useCallback((value: string) => {
    const typeKey = value; // 'coding' or 'token'
    // 检查是否已存在同类型订阅
    if (subscriptions[typeKey] != null) {
      // 已存在，覆盖：直接加载已有数据进入编辑
      setCurrentSubType(typeKey);
      setCurrentSubData({ ...subscriptions[typeKey]! });
    } else {
      setCurrentSubType(typeKey);
      setCurrentSubData({ ...EMPTY_SUB });
    }
    setDetailStep(0);
    setPhase('subscription_details');
  }, [subscriptions]);

  // ── 阶段 A：填写订阅详情 ──
  const handleDetailSelect = useCallback((value: string) => {
    // detailStep === 0: provider select
    // 占位符（分隔标题）忽略
    if (value.startsWith('__placeholder')) return;
    // 云厂商预设：填充 provider + baseURL，跳过 URL 输入直接进入 apiKey 步骤
    const cloudPreset = CLOUD_PROVIDER_PRESETS[value as keyof typeof CLOUD_PROVIDER_PRESETS];
    if (cloudPreset != null) {
      setCurrentSubData(prev => ({ ...prev, provider: cloudPreset.provider, baseURL: cloudPreset.baseURL }));
      setDetailStep(2);
      return;
    }
    const provider = value as SubData['provider'];
    // 本地模型预设：自动填充 baseURL，跳过 URL 输入直接进入 apiKey 步骤
    if (provider === 'ollama' || provider === 'lm-studio') {
      const preset = LOCAL_PROVIDER_PRESETS[provider];
      setCurrentSubData(prev => ({ ...prev, provider, baseURL: preset.baseURL }));
      setDetailStep(2);
    } else {
      setCurrentSubData(prev => ({ ...prev, provider }));
      setDetailStep(1);
    }
  }, []);

  const handleDetailText = useCallback((value: string) => {
    if (detailStep === 1) {
      // baseURL
      setCurrentSubData(prev => ({ ...prev, baseURL: value }));
      setDetailStep(2);
    } else if (detailStep === 2) {
      // apiKey (可空)
      setCurrentSubData(prev => ({ ...prev, apiKey: value }));
      // 保存订阅
      setSubscriptions(prev => ({
        ...prev,
        [currentSubType]: { ...currentSubData, apiKey: value },
      }));
      setPhase('more_subscriptions');
    }
  }, [detailStep, currentSubType, currentSubData]);

  // ── 阶段 A：是否更多订阅 ──
  const handleMoreSubsSelect = useCallback((value: string) => {
    if (value === 'yes') {
      setPhase('subscription_type');
    } else {
      // 进入 Agent 配置，初始化第一个 agent
      setCurrentAgentIndex(0);
      const subKeys = Object.keys(subscriptions);
      const defaultSub = subKeys[0] ?? '';
      setCurrentAgentData({ subscription: defaultSub, modelId: '', thinkingLevel: 'medium' });
      setPhase('agent_subscription');
    }
  }, [subscriptions]);

  // ── 阶段 B：Agent 配置 ──
  const handleAgentSubscriptionSelect = useCallback((value: string) => {
    setCurrentAgentData(prev => ({ ...prev, subscription: value }));
    setFetchedModels([]);
    setFetchError(null);
    setPhase('agent_model_fetching');
  }, []);

  // 自动拉取模型列表
  useEffect(() => {
    if (phase !== 'agent_model_fetching') return;
    const sub = subscriptions[currentAgentData.subscription];
    if (sub == null || sub.baseURL === '') {
      setPhase('agent_model');
      return;
    }
    let cancelled = false;
    fetchModelList(sub)
      .then(models => {
        if (cancelled) return;
        if (models.length > 0) {
          setFetchedModels(models);
          setPhase('agent_model_select');
        } else {
          setPhase('agent_model');
        }
      })
      .catch(err => {
        if (cancelled) return;
        setFetchError(err instanceof Error ? err.message : String(err));
        setPhase('agent_model');
      });
    return () => { cancelled = true; };
  }, [phase, subscriptions, currentAgentData.subscription]);

  const handleAgentModelSelect = useCallback((value: string) => {
    if (value === '__manual__') {
      setPhase('agent_model');
      return;
    }
    setCurrentAgentData(prev => ({ ...prev, modelId: value }));
    setPhase('agent_thinking');
  }, []);

  const handleAgentModelText = useCallback((value: string) => {
    if (value.trim().length === 0) return;
    setCurrentAgentData(prev => ({ ...prev, modelId: value }));
    setPhase('agent_thinking');
  }, []);

  const handleAgentThinkingSelect = useCallback((value: string) => {
    const agentName = AGENT_NAMES[currentAgentIndex]!;
    const finalData: AgentData = {
      ...currentAgentData,
      thinkingLevel: value as ThinkingLevel,
    };
    setAgents(prev => ({ ...prev, [agentName]: finalData }));

    if (currentAgentIndex < AGENT_NAMES.length - 1) {
      // 下一个 agent
      const nextIdx = currentAgentIndex + 1;
      setCurrentAgentIndex(nextIdx);
      const subKeys = Object.keys(subscriptions);
      const defaultSub = subKeys[0] ?? '';
      setCurrentAgentData({ subscription: defaultSub, modelId: '', thinkingLevel: 'medium' });
      setPhase('agent_subscription');
    } else {
      // 所有 agent 配置完毕，进入预览
      setPhase('preview');
    }
  }, [currentAgentIndex, currentAgentData, subscriptions]);

  // ── 阶段 C：预览确认 ──
  const handlePreviewSelect = useCallback((value: string) => {
    if (value === 'confirm') {
      writeFiles();
    } else {
      resetAll();
    }
  }, [writeFiles, resetAll]);

  // ── 阶段 D：完成页 ──
  const handleDoneSubmit = useCallback(() => {
    if (advancingRef.current) return;
    advancingRef.current = true;
    exit();
    props.onComplete();
  }, [exit, props]);

  // ── 渲染 ──

  // 阶段 A1：选订阅类型
  if (phase === 'subscription_type') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">╔══════════════════════════════════════╗</Text>
        <Text bold color="cyan">║   TianGong v2  首次运行配置向导      ║</Text>
        <Text bold color="cyan">╚══════════════════════════════════════╝</Text>
        <Text> </Text>
        <Text>步骤 A：选择订阅类型</Text>
        <Text> </Text>
        <Select
          key="sub-type"
          options={[
            { label: 'Coding Plan', value: 'coding' },
            { label: 'Token Plan', value: 'token' },
          ]}
          onSelect={handleSubscriptionTypeSelect}
        />
        <Text color="gray">已配置订阅: {Object.keys(subscriptions).length > 0 ? Object.keys(subscriptions).join(', ') : '(无)'}</Text>
      </Box>
    );
  }

  // 阶段 A2：填写订阅详情
  if (phase === 'subscription_details') {
    const stepLabel = ['Provider', 'Base URL', 'API Key'][detailStep]!;
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── {currentSubType} Plan 配置 ({detailStep + 1}/3) ──</Text>
        <Text> </Text>
        {detailStep === 0 && (
          <>
            <Text>选择 Provider：</Text>
            <Select
              key="sub-provider"
              options={[
                { label: '── 云厂商预设 ──', value: '__placeholder__' },
                { label: CLOUD_PROVIDER_PRESETS['deepseek-openai'].label, value: 'deepseek-openai' },
                { label: CLOUD_PROVIDER_PRESETS['deepseek-anthropic'].label, value: 'deepseek-anthropic' },
                { label: CLOUD_PROVIDER_PRESETS['qwen-openai'].label, value: 'qwen-openai' },
                { label: CLOUD_PROVIDER_PRESETS['qwen-anthropic'].label, value: 'qwen-anthropic' },
                { label: CLOUD_PROVIDER_PRESETS['glm'].label, value: 'glm' },
                { label: CLOUD_PROVIDER_PRESETS['kimi'].label, value: 'kimi' },
                { label: CLOUD_PROVIDER_PRESETS['minimax'].label, value: 'minimax' },
                { label: '── 自定义 ──', value: '__placeholder2__' },
                { label: 'OpenAI', value: 'openai' },
                { label: 'Anthropic', value: 'anthropic' },
                { label: 'Ollama（本地）', value: 'ollama' },
                { label: 'LM Studio（本地）', value: 'lm-studio' },
              ]}
              onSelect={handleDetailSelect}
            />
          </>
        )}
        {detailStep === 1 && (
          <>
            <Text>Base URL：</Text>
            <TextInput
              key="sub-baseURL"
              onSubmit={handleDetailText}
              defaultValue={currentSubData.baseURL}
              placeholder="https://api.openai.com/v1"
            />
          </>
        )}
        {detailStep === 2 && (
          <>
            <Text>API Key（可留空回车跳过，将回退到环境变量）：</Text>
            <TextInput
              key="sub-apiKey"
              onSubmit={handleDetailText}
              mask
              placeholder="sk-..."
            />
          </>
        )}
        <Text color="gray">当前: {stepLabel} | provider: {currentSubData.provider}</Text>
      </Box>
    );
  }

  // 阶段 A3：是否更多订阅
  if (phase === 'more_subscriptions') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── 订阅配置完成 ──</Text>
        <Text> </Text>
        <Text>已配置的订阅: {Object.keys(subscriptions).join(', ')}</Text>
        <Text> </Text>
        <Text>是否还有其他订阅需要添加？</Text>
        <Select
          key="more-subs"
          options={[
            { label: '是，继续添加', value: 'yes' },
            { label: '否，进入 Agent 配置', value: 'no' },
          ]}
          onSelect={handleMoreSubsSelect}
        />
      </Box>
    );
  }

  // 阶段 B：Agent 配置
  const agentName = AGENT_NAMES[currentAgentIndex]!;
  const subKeys = Object.keys(subscriptions);

  if (phase === 'agent_subscription') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── Agent: {agentName} ({currentAgentIndex + 1}/4) ──</Text>
        <Text> </Text>
        <Text>选择订阅计划：</Text>
        <Select
          key={`agent-${currentAgentIndex}-sub`}
          options={subKeys.map(k => ({ label: k, value: k }))}
          onSelect={handleAgentSubscriptionSelect}
        />
      </Box>
    );
  }

  // 阶段 B2：拉取模型列表中
  if (phase === 'agent_model_fetching') {
    const sub = subscriptions[currentAgentData.subscription];
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── Agent: {agentName} ({currentAgentIndex + 1}/4) ──</Text>
        <Text> </Text>
        <Text color="yellow">⏳ 正在获取可用模型列表…</Text>
        <Text color="gray">  端点: {sub?.baseURL ?? '(未知)'}/models</Text>
        <Text color="gray">  按 n 跳过，手动输入模型名</Text>
      </Box>
    );
  }

  // 阶段 B2b：从列表选择模型
  if (phase === 'agent_model_select') {
    const sub = subscriptions[currentAgentData.subscription];
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── Agent: {agentName} ({currentAgentIndex + 1}/4) ──</Text>
        <Text> </Text>
        <Text>选择模型（共 {fetchedModels.length} 个，订阅: {currentAgentData.subscription}）：</Text>
        <Select
          key={`agent-${currentAgentIndex}-model-select`}
          options={[
            ...fetchedModels.map((m, i) => ({
              label: `${m.id}${m.ownedBy != null ? `  [${m.ownedBy}]` : ''}${i < 10 ? '' : ''}`,
              value: m.id,
            })),
            { label: '── 手动输入模型名 ──', value: '__manual__' },
          ]}
          onSelect={handleAgentModelSelect}
        />
        <Text color="gray">上下键选择，Enter 确认；选「手动输入」可自行填写</Text>
      </Box>
    );
  }

  // 阶段 B3：手动输入模型 ID（获取失败或用户选择手动输入）
  if (phase === 'agent_model') {
    const sub = subscriptions[currentAgentData.subscription];
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── Agent: {agentName} ({currentAgentIndex + 1}/4) ──</Text>
        <Text> </Text>
        {fetchError != null && (
          <Text color="red">⚠ 自动获取失败（{fetchError}），请手动输入</Text>
        )}
        <Text>Model ID（当前订阅: {currentAgentData.subscription}）：</Text>
        <Text color="gray">  端点: {sub?.baseURL ?? '(未知)'}</Text>
        <TextInput
          key={`agent-${currentAgentIndex}-model`}
          onSubmit={handleAgentModelText}
          placeholder="deepseek-chat, gpt-4o, qwen-plus…"
        />
      </Box>
    );
  }

  if (phase === 'agent_thinking') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── Agent: {agentName} ({currentAgentIndex + 1}/4) ──</Text>
        <Text> </Text>
        <Text>Thinking Level：</Text>
        <Select
          key={`agent-${currentAgentIndex}-think`}
          options={[
            { label: '低 (low)', value: 'low' },
            { label: '中 (medium)', value: 'medium' },
            { label: '高 (high)', value: 'high' },
          ]}
          onSelect={handleAgentThinkingSelect}
        />
      </Box>
    );
  }

  // 阶段 C：预览确认
  if (phase === 'preview') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">── 配置预览 ──</Text>
        <Text> </Text>

        <Text bold>订阅 (Subscriptions):</Text>
        {Object.entries(subscriptions).map(([key, s]) => (
          <Box key={key} flexDirection="column">
            <Text color="yellow">  [{key}]</Text>
            <Text>    provider: {s.provider}</Text>
            {s.baseURL !== '' ? <Text>    baseURL: {s.baseURL}</Text> : <Text color="red">    baseURL: (空!)</Text>}
            <Text>    apiKey: {s.apiKey !== '' ? '****' : '(未设置)'}</Text>
          </Box>
        ))}
        <Text> </Text>

        <Text bold>Agent 配置:</Text>
        {AGENT_NAMES.map(name => {
          const a = agents[name];
          if (a == null) return <Text key={name} color="red">  {name}: (未配置)</Text>;
          return (
            <Text key={name}>
              {'  '}{name}: sub={a.subscription}, model={a.modelId !== '' ? a.modelId : <Text color="red">(空!)</Text>}, thinking={a.thinkingLevel}
            </Text>
          );
        })}
        <Text> </Text>

        <Select
          key="preview-confirm"
          options={[
            { label: '✓ 确认写入配置', value: 'confirm' },
            { label: '✗ 重新配置', value: 'redo' },
          ]}
          onSelect={handlePreviewSelect}
        />
      </Box>
    );
  }

  // 阶段 C：完成页
  if (phase === 'done') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="green">✓ 配置文件写入成功！</Text>
        <Text> </Text>
        <Text color="yellow">  • config/LLMconfig.jsonc</Text>
        <Text color="yellow">  • config/mcp.jsonc</Text>
        <Text> </Text>
        <Text color="gray">{showStuckHint ? '按回车键，或按 n 退出向导…' : '按回车键退出向导…'}</Text>
        <TextInput
          key="done"
          onSubmit={handleDoneSubmit}
          placeholder="按回车退出"
        />
      </Box>
    );
  }

  // Fallback
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="gray">加载中…</Text>
    </Box>
  );
}

// ── 导出 ────────────────────────────────────────────────────

export async function runFirstRunWizard(opts?: { force?: boolean }): Promise<void> {
  const llmPath = resolve(__dirname, 'LLMconfig.jsonc');
  const force = opts?.force === true || process.argv.includes('--setup');
  if (existsSync(llmPath) && !force) return;

  await new Promise<void>((resolvePromise) => {
    const instance = render(
      <Wizard
        onComplete={() => {
          instance.unmount();
          resetConfig();
          resolvePromise();
        }}
      />,
      { exitOnCtrlC: true },
    );
  });
}
