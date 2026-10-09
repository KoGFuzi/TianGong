# @OnePanda-TgSec/tg-telemetry

厂商中立的 telemetry 契约、类型化 span 词表，以及面向适配器实现的 conformance 套件。

这个包的重点是：适配器作者不应该需要读任何厂商的 SDK 文档。你实现两个接口，conformance 套件会
精确告诉你哪里做错了。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [契约](#契约)
- [类型化 Schema](#类型化-schema)
- [Span 词表（第一批）](#span-词表第一批)
- [实现一个适配器](#实现一个适配器)
- [Conformance](#conformance)
- [内存记录器](#内存记录器)
- [入口](#入口)
- [开发](#开发)
- [来源](#来源)
- [License](#license)

## 安装

```bash
bun add @OnePanda-TgSec/tg-telemetry
```

## 快速开始

```typescript
import { NOOP_TELEMETRY_CONTEXT } from "@OnePanda-TgSec/tg-telemetry";

await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "agent.turn" }, async (span) => {
	span.setAttributes({ "agent.model": "gpt-5.2", "agent.turn_index": 3 });
	span.addEvent("tool.call", { "tool.name": "weather" });
	span.setStatus({ status: "ok" });
});
```

未配置 telemetry 时默认使用 `NOOP_TELEMETRY_CONTEXT`：它实现同样的接口但什么都不做，因此埋点代码
可以无条件编写。

## 契约

```typescript
interface TelemetryContext {
	startSpan<T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T>;
}

interface TelemetrySpan extends TelemetryContext {
	addEvent(name: string, attributes?: SpanAttributes): void;
	setAttributes(attributes: SpanAttributes): void;
	setStatus(status: SpanStatus): void;
}
```

两个性质最关键，也是 conformance 套件检查的内容：

- **`startSpan` 接收回调，而不是句柄。** span 不能活得比它测量的工作更久。这消除了最常见的
  telemetry bug：在一处开 span、另一处关 span，而中间早就提前 return 了。
- **`TelemetrySpan` 本身就是 `TelemetryContext`**，嵌套就是 `span.startSpan(...)`，不需要任何
  管道传递。

`SpanStatus` 是 `{ status: "ok" }` 或 `{ status: "error"; error?: { name; message } }`。

## 类型化 Schema

schema 声明应用会发出哪些 span 和 event，以及每个属性的类型。类型会流进开 span 的代码里：属性名
打错、该写 number 的地方写了 string，都是编译错误。

```typescript
import { createTypedSpanStarter, defineTelemetrySchema } from "@OnePanda-TgSec/tg-telemetry";

const schema = defineTelemetrySchema({
	version: 1,
	spans: {
		"agent.turn": {
			description: "One model turn",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"agent.model": { type: "string", description: "Provider model id", required: true },
				"agent.turn_index": { type: "number", description: "Zero-based turn counter", required: true },
			},
			endAttributes: {
				"agent.stop_reason": { type: "string", description: "Why the turn ended", cardinality: "low" },
			},
			events: {
				"tool.call": {
					description: "A tool was invoked",
					attributes: {
						"tool.name": { type: "string", description: "Tool name", required: true },
					},
				},
			},
			status: { default: "ok", errorWhen: "the model request fails or is aborted" },
		},
	},
});

const startSpan = createTypedSpanStarter([schema]);
```

属性标 `sensitive: true` 表示它不允许离开进程，适配器应负责脱敏。`cardinality: "high"` 提醒适配
器作者：无界值应该放进 example 字段，而不是属性。

## Span 词表（第一批）

包内导出一份开箱即用的词表 `TG_SPAN_SCHEMA`，`tg-ai` 与 `tg-agent-core` 的全部埋点都记录在它
上面。词表之外的 span 名在类型层面即被拒绝：

| Span | 层 | 父 | 关键属性（全部低基数） |
| --- | --- | --- | --- |
| `tg.span.provider.acquire` | ai | 调用方上下文 | `provider` |
| `tg.span.provider.request` | ai | 调用方上下文（经 gate 时父于 acquire） | `provider`、`api`、`model`、`stopReason`、`retried`、`tokens.input/output/cacheRead/cacheWrite`、`cost.total`、`errorName` |
| `tg.span.agent.turn` | agent | 调用方上下文 | `provider`、`model`、`stopReason`、`toolCallCount` |
| `tg.span.agent.tool` | agent | `tg.span.agent.turn` 或 `tg.span.agent.tool`（嵌套工具调用） | `toolName`、`isError` |

隐私边界：span 属性只放计数与闭集枚举，不放内容——不进 prompt 文本、工具参数、路径。`model` 用
catalog id（如 `claude-sonnet-5-5`），不是自由文本。

实际形态是一棵树：

```text
tg.span.agent.turn
  ├─ tg.span.provider.acquire
  │    └─ tg.span.provider.request
  └─ tg.span.agent.tool × n
```

## 实现一个适配器

实现 `TelemetryContext`。`startSpan` 必须恰好调用一次回调，并提供一个把 `addEvent`、
`setAttributes`、`setStatus` 转发到厂商 SDK 的 `TelemetrySpan`；它必须：

- 把回调运行到完成并返回其值；
- 把回调的 rejection 原样传播为 `startSpan` 的 rejection；
- 在 span 关闭时记录 `status`：除非 `setStatus` 覆盖，否则应用 `status.default`；
- 不吞掉 `addEvent`、`setAttributes`、`setStatus` 抛出的错误。

## Conformance

```typescript
import { createTelemetryAdapterConformance } from "@OnePanda-TgSec/tg-telemetry/testing";

describe("my adapter", () => {
	createTelemetryAdapterConformance({
		name: "my-vendor",
		createContext: () => new MyVendorTelemetryContext(),
		expectEvents: true,
		expectStatus: true,
	});
});
```

套件会跑回调完成、错误传播、嵌套、属性覆盖、事件顺序、status 决议，并把失败报告为独立的测试用例。
如果你的厂商确实做不到某项，关掉 `expectEvents` 或 `expectStatus`；套件不会断言你声明过做不到的
东西。

## 内存记录器

`InMemoryTelemetryContext` 记录 span 和 event 而不是导出它们。测试可用，开发期想看清埋点到底有
没有触发时也可用：

```typescript
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";

const telemetry = new InMemoryTelemetryContext();
// ... 运行工作 ...
telemetry.spans; // RecordedTelemetrySpan[]
telemetry.reset();
```

## 入口

| 导入 | 内容 |
| --- | --- |
| `@OnePanda-TgSec/tg-telemetry` | 契约、schema 类型、`defineTelemetrySchema`、`createTypedSpanStarter`、`TG_SPAN_SCHEMA`、`NOOP_TELEMETRY_CONTEXT`、`InMemoryTelemetryContext`。 |
| `@OnePanda-TgSec/tg-telemetry/testing` | `createTelemetryAdapterConformance` 及其选项类型。 |

`/testing` 不要进生产 bundle：它存在的意义是让适配器出错，而不是随产品发布。

## 开发

从 monorepo 根目录：

```bash
bun run check             # house standard、格式、类型
bun run test              # 每个包套件
bun run test packages/telemetry
```

## 来源

从 [pi agent](https://github.com/earendil-works/pi) 项目以 `@earendil-works/pi-telemetry` 身份采
用，改牌到 `@OnePanda-TgSec`。词表文件（`src/spans.ts`）为本工作区新增，其余模块无增删重组，公开
API 不变。见工作区根目录的
[`docs/provenance.md`](../../docs/provenance.md)。

## License

MIT
