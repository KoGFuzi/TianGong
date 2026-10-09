# @OnePanda-TgSec/tg-ai

一个接口对接所有模型 provider，模型发现与 provider 鉴权替你打理。

`createModels()` 给你一个 provider 注册表。你按 `provider` 和 `id` 要一个模型；它解析凭证、选对
线上 API、交回一条流。provider 是按需注册的：import 这个包不会拖入所有 SDK。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [入口](#入口)
- [Models](#models)
- [流式调用](#流式调用)
- [Providers](#providers)
- [鉴权](#鉴权)
- [模型数据](#模型数据)
- [工具与 TypeBox](#工具与-typebox)
- [工具函数](#工具函数)
- [可观测性](#可观测性)
- [开发](#开发)
- [来源](#来源)
- [License](#license)

## 安装

```bash
bun add @OnePanda-TgSec/tg-ai
```

## 快速开始

```typescript
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import { openaiProvider } from "@OnePanda-TgSec/tg-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider()); // 读取 OPENAI_API_KEY

await models.refresh(); // 拉取已配置 provider 的实时模型列表

const model = models.getModel("openai", "gpt-5.2")!;
const stream = models.streamSimple(model, {
	systemPrompt: ["You are terse."],
	messages: [{ role: "user", content: "Capital of France?" }],
});

for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

## 入口

| 导入 | 内容 |
| --- | --- |
| `@OnePanda-TgSec/tg-ai` | 类型、注册表接口、`Type`、共享工具函数。无副作用。 |
| `@OnePanda-TgSec/tg-ai/models` | `createModels()`、`createProvider()`、费用与 thinking 辅助。 |
| `@OnePanda-TgSec/tg-ai/providers/*` | 每个 provider 一个模块，如 `providers/openai`。 |
| `@OnePanda-TgSec/tg-ai/providers/all` | `builtinProviders()`，所有 provider 工厂一次拿全。 |
| `@OnePanda-TgSec/tg-ai/api/*` | 线上协议实现，如 `api/anthropic-messages`。 |
| `@OnePanda-TgSec/tg-ai/utils/*` | 重试、校验、transcript 辅助、token 估算。 |
| `@OnePanda-TgSec/tg-ai/compat` | 旧的全局 API 形态，保持可用。 |
| `@OnePanda-TgSec/tg-ai/oauth` | OAuth 登录流程，独立入口。 |
| `@OnePanda-TgSec/tg-ai/models.generated` | 生成的 catalog 常量。勿手改。 |

根入口刻意不加载 catalog、provider 工厂或 OAuth 实现。按你需要的具体路径导入。

## Models

`createModels()` 返回一个 `MutableModels`。读操作同步，任何碰网络或凭证存储的操作异步。

```typescript
models.getProviders();                       // 已注册的 provider
models.getModels("openai");                 // 最近一次已知的聊天模型
models.getModel("openai", "gpt-5.2");       // 单个模型，或 undefined
models.getModelsOfType("embedding", "openai");
models.getAllModels();                      // 所有模型类型、所有 provider

await models.refresh();                     // 重新拉取动态 provider 列表
await models.getAvailable();                // 只返回鉴权已配置好的模型
await models.getAuth(model);                // 解析后的凭证，或 undefined
```

读来自最近一次已知列表。某个 provider 的 refresh 抛错只会让它的模型为空，而不会拖垮整个调用；
`refresh()` 按 provider 报告错误而不是 reject。

## 流式调用

四个入口，区别只在它们对线上协议知道多少：

```typescript
models.stream(model, context, options);        // Model<TApi>：按 API 类型化
models.complete(model, context, options);      // 一次性，返回消息
models.streamSimple(model, context, options);  // Model<Api>：可移植形态
models.completeSimple(model, context, options);
```

`streamDeferred()` 与 `fetchDeferred()` 处理 deferred/长时响应（批处理作业之类）：保留句柄，稍后
取结果，改变主意就取消。

四个入口都返回 `AssistantMessageEventStream`。失败以协议事件加一条 `stopReason` 为 `"error"` 或
`"aborted"` 的终局消息编码在流里。什么都不 reject，所以只迭代流的消费者不会漏掉任何失败。

另有 `generateImages()`（图片模型）与 `classify()`（分类模型）。两者都不 reject；失败时返回错误
结果。

## Providers

```typescript
import { builtinProviders } from "@OnePanda-TgSec/tg-ai/providers/all";

const models = createModels({ providers: builtinProviders() });
```

`createModels({ providers })` 在构造时注册它们；否则用 `setProvider()` 逐个注册。provider id 唯
一；同 id 设置两次会替换。

要接入非内置的 provider，用 `createProvider()`：传入 base URL、api 实现、模型元数据与鉴权策略，
返回一个可以像其他 provider 一样注册的 `Provider<TApi>`。

## 鉴权

两种形态，统一在 `getAuth()` 后面：

- **API key**，来自环境变量。provider 工厂按约定读取（`OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）。
- **OAuth**，面向提供 OAuth 的 provider：Anthropic、OpenAI ChatGPT 与 Codex、GitHub Copilot、
  OpenRouter、Google、xAI、Mistral、Kimi、Radius。

```typescript
const auth = await models.getAuth(model);
await models.login("github-copilot", "oauth", interaction);
await models.logout("github-copilot");
await models.checkAuth("openai");
```

`getAuth()` 失败时 reject 一个 `ModelsError` 而不是默默继续：token 刷新失败报 code `"oauth"`（已存
凭证保留，可重试或重新登录），key 解析或凭证存储失败报 code `"auth"`。请求路径把这些 rejection
呈现为流错误。

短期会过期的 token 应该按请求解析，而不是只解析一次：

```typescript
const agent = new Agent({ getApiKey: async (provider) => (await models.getAuth(provider))?.apiKey });
```

## 模型数据

provider 模型列表是生成的，不是手维护的。

```bash
bun run generate:models         # 写出 src/models.generated.ts 与 src/providers/data/
bun run hydrate:model-data      # 只刷新 provider 数据
bun run generate:model-catalog  # 可发布 catalog，写入 .artifacts/model-catalog
bun run check:model-data        # 校验签入数据内部一致
```

`src/providers/data/` 被 gitignore。构建或测试本包前先跑 `generate:models`；CI 同样如此。
`src/models.generated.ts` 签入但属生成物：改 `scripts/generate-models.ts`，永远不改输出。

## 工具与 TypeBox

工具 schema 是 TypeBox，重新导出，保证依赖树里只有一份拷贝：

```typescript
import { Type } from "@OnePanda-TgSec/tg-ai";

const parameters = Type.Object({ city: Type.String(), units: Type.Optional(Type.Union([Type.Literal("c"), Type.Literal("f")])) });
```

`validateToolArguments()` 与 `utils/validation` 里的其他辅助把原始工具调用变成类型化参数，或变成
模型应该看到的错误信息。

## 工具函数

`utils/retry`（带 provider 感知的退避的重试策略）、`utils/transcript`（`AgentMessage[]` 与
provider 消息互转）、`utils/estimate`（token 估算）、`utils/overflow`（上下文窗口计量）、
`utils/json-parse`（部分/流式 JSON）、`utils/event-stream`（流辅助）、`utils/diagnostics`
（provider 错误分类）。

## 可观测性

每个 provider 逻辑调用都记录一个 `tg.span.provider.request` span：开始属性为 `provider`、
`api`、`model`；流 settle 时写入 `stopReason`、`retried`、四个 `tokens.*` 与 `cost.total`，错误时
写 `errorName` 并把 status 置为 error。适配器重试通过内部 `onRetry` 管线上报（重试守卫通过
后、退避等待前触发），`retried` = 重试次数 > 0。

`Models` 的并发 gate 包一层 `tg.span.provider.acquire` span，并把 acquire span 作为请求的父上
下文——gate 拒绝（`ConcurrencyLimitError`）只产生 acquire span，不产生 request span。

埋点入口是一个可选字段：

```typescript
models.streamSimple(model, context, { telemetryContext });
```

不传 `telemetryContext`（或传 `NOOP_TELEMETRY_CONTEXT`）时调用路径原样直通，零开销、零行为差异。
词表定义在 `@OnePanda-TgSec/tg-telemetry` 的 `TG_SPAN_SCHEMA`。

## 开发

从 monorepo 根目录：

```bash
bun run generate:models   # 必须先跑：src/providers/data/ 被 gitignore
bun run check             # house standard、格式、类型
bun run test              # 每个包套件
bun run test packages/ai  # 只跑本包
```

## 来源

从 [pi agent](https://github.com/earendil-works/pi) 项目以 `@earendil-works/pi-ai` 身份采用，改牌
到 `@OnePanda-TgSec`。模块无增删重组；命名层整体改名，包括 `api/tg-messages.ts` 实现及其
`TgMessages*` 类型，现携带 `tg-` 前缀。埋点模块（`utils/provider-spans.ts`）为本工作区新增。见工
作区根目录的 [`docs/provenance.md`](../../docs/provenance.md)。

## License

MIT
