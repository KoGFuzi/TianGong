# 上游 pi 1.1.0 → 1.3.0 移植工程基线（tg-ai）

> 生成于 2026-10-17。上游参照物：本仓同步用的上游源码树（Windows 侧 `F:/Code-Testing/pi-1.3.0`，
> 已拷贝到 Fedora `/tmp/pi-130/packages/ai`；`@earendil-works/pi-ai` 1.3.0，2026-10-15）。
> 本文件是 `tg-ai` 从上游 1.1.0 升到 1.3.0 的**唯一落点基线**，覆盖 1.2.0 与 1.3.0 两个版本的全部
> changelog 条目。上游 agent / telemetry 包在 1.2.0/1.3.0 零改动，不涉及。
>
> 落点分支：**V2**。`v1` 冻结不落。每批次单独成 commit，提交前跑第 6 节验证协议。
>
> **命名规则（最高约束）**：移植时把上游逻辑**翻译进**房规命名——`@earendil-works/pi-ai` →
> `@OnePanda-TgSec/tg-ai`、`pi.*` 消息种 → `tg.*`、`Pi*` 标识符 → `Tg*`、`PI_*` 环境变量 → `TG_*`、
> `pi-messages` → `tg-messages`、`getPiUserAgent` → `getTgUserAgent`。**禁止**反向修改房规。
> `packages/tui/native/` 与 vendored 的 `packages/codemode`、`packages/mcp` 本轮**完全不动**。
>
> **保护清单（本仓自有特性，移植中不得回退）**：`src/config-paths.ts`、`src/auth/api-key.ts`、
> `src/auth/credential-store-file.ts`、`src/auth-node.ts`、`src/utils/concurrency-limit.ts`、
> `src/utils/provider-spans.ts`、`src/api/tg-messages*.ts`、`src/utils/tg-user-agent.ts`
> （哈希对账确认这 8 个文件 upstream 无对应物，是本仓自有实现）。

---

## 0. 对账基线（先读）

上游 1.3.0 `packages/ai` 与本仓 `packages/ai` 逐文件 sha256 对账（2026-10-17 实测）：

- **228 个文件哈希一致**——其中 `src/providers/data/*.json`、`src/models.generated.ts`、
  `src/providers/*.models.ts` 全部**零房规命名**（grep 实证），意味着数据/生成层可**整文件字节复制**。
- 上游**新增**文件（8 代码 + 9 测试）：`src/providers/model-schema.ts`、`src/providers/compat-schema.ts`、
  `src/providers/openrouter-api.ts`、`scripts/ai-gateway-pricing.ts` 及测试
  `json-parse / model-cost-tiers / compat-schema / openai-responses-mid-convo-effort /
  openrouter-user-models / anthropic-error-tool-result-images / anthropic-strict-tool-fallback /
  transform-messages-cross-model-thinking / radius-thinking-replay-e2e`。
- `src/utils/assistant-message-frame.ts` 上游 1.3.0 已删除；本仓仅 `src/index.ts` 一处 re-export
  加 `test/assistant-message-frame.test.ts`，**删除面极小**。
- 上游 1.3.0 把 `compat.supportsMidConvoEffort` 等模型兼容开关落在新 schema 模块
  （`model-schema.ts` / `compat-schema.ts`，typebox），本仓无此二文件，属 1.2.0/1.3.0 新增。

## 1. 批次结构（唯一 cherry-pick 序）

### 批次 1：数据与生成层（字节复制，零命名翻译）

上游 1.3.0 的模型目录再生成产物，全部无房规命名，整文件覆盖即可：

| 上游文件 | 动作 |
| --- | --- |
| `src/providers/data/*.json`（24 个，含 `.manifest.json`） | 整目录覆盖 |
| `src/models.generated.ts` | 覆盖 |
| `src/providers/*.models.ts`（全部 40 个） | 覆盖 |
| `src/providers/model-schema.ts`、`src/providers/compat-schema.ts` | 新增 |
| `src/providers/openrouter-api.ts` | 新增 |
| `scripts/generate-models.ts`、`scripts/check-model-data.ts`、`scripts/openrouter-catalog.ts`、`scripts/ai-gateway-pricing.ts` | 覆盖/新增（本仓不跑再生成，仅保持脚本与上游一致） |
| `src/image-models.ts` | 覆盖前先 diff——若含命名则只搬数据差 |
| 对应测试：`model-data-validation / generate-models-strict / model-cost-tiers / compat-schema / providers` 等无命名测试 | 覆盖/新增 |

**验收**：`bun run check` 全绿；`ai` 包测试（Node 跑 vitest）全绿。注意本仓 `scripts/model-data.ts`
与 `scripts/models-dev-reasoning-options.ts`、`scripts/openrouter-reasoning-options.ts` 是既有文件，
覆盖前先 diff 确认上游改动只是数据管线演化，不带命名。

### 批次 2：修复类（changelog 1.2.0 Fixed + 1.3.0 Fixed 的代码侧）

逐条（上游落点 → 本仓落点，落点行号以实现时实测为准）：

| # | 条目（来源版本） | 上游落点 | 本仓落点 |
| --- | --- | --- | --- |
| A2-1 | Mistral 超时只等响应头（1.2.0 #10609） | `api/mistral-conversations.ts` | 同名 |
| A2-2 | "The upstream provider returned an error" 可重试（1.2.0 #10842） | `utils/retry.ts` | 同名（注意本仓 :111 附近已有 ChatGPT 文案，勿混） |
| A2-3 | 网关 "Unable to forward upstream stream" 可重试（1.3.0 #10920） | `utils/retry.ts` | 同名 |
| A2-4 | "The service is temporarily unavailable" 可重试（1.3.0 #10965） | `utils/retry.ts` | 同名 |
| A2-5 | 工具调用参数含非法 `\u` 转义不丢字段（1.3.0 #10868） | `utils/json-parse.ts`（新增上游测试 `json-parse.test.ts`） | 同名 |
| A2-6 | 畸形 JSON 工具调用带 `argumentsError`（1.3.0 #10897） | `utils/validation.ts` + `api/openai-*.ts` | 同名 |
| A2-7 | OpenAI 兼容流 reasoning+content 同 chunk 乱序（1.3.0 #10926） | `api/openai-completions.ts` | 同名 |
| A2-8 | Anthropic/Bedrock 错误工具结果带图先发结果后发图（1.3.0 #10794） | `api/transform-messages.ts` + `api/anthropic-messages.ts` + `api/bedrock-converse-stream.ts`（上游测试 `anthropic-error-tool-result-images.test.ts`） | 同名 |
| A2-9 | Anthropic `strict:"prefer"` 被拒降级重试（1.2.0 #10409） | `api/anthropic-messages.ts`（上游测试 `anthropic-strict-tool-fallback.test.ts`） | 同名 |

### 批次 3：provider 行为与模型目录行为

| # | 条目（来源版本） | 上游落点 | 本仓落点 |
| --- | --- | --- | --- |
| A3-1 | `kimi-coding` 改走 `https://api.kimi.com/coding/v1` + base URL 须含 `/v1`（1.3.0 #10720） | `providers/kimi-coding.ts`、`auth/oauth/kimi-coding.ts`（数据已在批次 1 的 `data/kimi-coding.json`） | 同名 |
| A3-2 | OpenCode Zen/Go 迁 `opencode.ai/inference`，Go 加 Google GenAI 支持（1.3.0） | `providers/opencode-go.ts`、`api/google-*.ts`（数据在批次 1） | 同名 |
| A3-3 | OpenCode Go MiniMax M2.7 改 Anthropic Messages（1.3.0） | `providers/opencode-go.ts` + compat | 同名 |
| A3-4 | Gemini 4+ 发送 `thinkingLevel`（1.3.0 #10890） | `api/google-shared.ts`、`api/google-vertex.ts` | 同名 |
| A3-5 | Xiaomi MiMo `minimal` 等级修正（1.3.0 #10818） | 数据层（批次 1 已带）+ `providers/xiaomi.ts` 如有逻辑 | 同名 |
| A3-6 | Claude Haiku 5.5 / Opus 5 支持 `off`（`thinking:{type:"disabled"}`）（1.3.0 #10753） | `api/anthropic-messages.ts` | 同名 |
| A3-7 | 模型切换丢弃他模型 thinking 块（1.3.0 #10995，上游测试 `transform-messages-cross-model-thinking.test.ts`） | `api/transform-messages.ts` | 同名 |

### 批次 4：Added 与 Breaking

| # | 条目（来源版本） | 上游落点 | 本仓落点 |
| --- | --- | --- | --- |
| A4-1 | **Breaking**：删 `AssistantMessageFrame*` 与 `reduceAssistantMessageFrames()`（1.3.0） | 上游已删 | 删 `src/utils/assistant-message-frame.ts` + `test/assistant-message-frame.test.ts` + `src/index.ts` 的导出；先 grep 全仓消费者 |
| A4-2 | GPT-6 保缓存的 thinking level 切换：`configuration_update` input items + `compat.supportsMidConvoEffort`（1.3.0 #10853，上游测试 `openai-responses-mid-convo-effort.test.ts`） | `api/openai-responses.ts`、`api/openai-responses-shared.ts`、`compat.ts`、schema 模块 | 同名（`Tg*` 翻译） |
| A4-3 | `personalizeOpenRouterCatalog()` + `RefreshModelsContext.baseUrl`（1.2.0 #10353/#10672，上游测试 `openrouter-user-models.test.ts`） | `providers/openrouter.ts`、`providers/openrouter-api.ts`、`types.ts`、`auth/oauth/openrouter.ts` | 同名 |
| A4-4 | `package.json` 与上游 1.3.0 对齐（exports/scripts/diff 出的增量），保住本仓 name/version/repository 行 | `package.json` | 手工合并 |

## 2. 翻译对照（实现时逐处套用）

上游 → 本仓：`@earendil-works/pi-ai`→`@OnePanda-TgSec/tg-ai`；`pi.agent`/`pi.live`/`pi.usage`/`pi.generation`
→`tg.*`；`PiMessages*`→`TgMessages*`；`PiAnthropic`→`TgAnthropic`；`piMessagesApi`→`tgMessagesApi`；
`PI_CACHE_RETENTION`/`PI_OAUTH_CALLBACK_HOST`→`TG_*`；`api/pi-messages.ts`→`api/tg-messages.ts`；
`utils/pi-user-agent.ts`→`utils/tg-user-agent.ts`；User-Agent 产品 token `pi (`→`tg (`。
**数据字面量（模型 id、provider id、API 协议串如 `configuration_update`）不翻译。**

## 3. 验证协议（每批次 commit 前强制）

1. `bun run check`（house-standard / biome / tsc / relative-imports）全绿。
2. `ai` 包测试用 **Node** 跑：`packages/ai` 下
   `PATH="$HOME/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH" node ../../node_modules/vitest/vitest.mjs --run`
   全绿（bun 跑 vitest 对含 worker/http 的套件有已知假红，参照 vendored 包先例）。
3. 每批次一个 commit，格式 `fix(ai)/feat(ai)/chore(ai): ...`，正文注明上游条目与 issue 号。

## 4. 回滚矩阵

每批次独立 commit，可单独 `git revert`。批次 1（数据层）与批次 2–4（代码层）无交织文件
（数据层零命名、代码层全命名），回滚互不牵连。A4-1 删除项回滚 = revert 该 commit。
