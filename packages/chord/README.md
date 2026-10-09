# @OnePanda-TgSec/chord

应用组合运行时：服务、复制状态、RPC 与插件。

Chord 是独立的。它不依赖本工作区里的任何包，运行时也只依赖自己的 bundler，因此可以独立发布。

- **服务**是带声明身份的强类型接口。provider 实现一个；consumer 按 id 与地址解析一个。服务可
  以是本地的、经由传输层远程的，或两者兼有。
- **复制状态**是一份带有序副本集合的 JSON 文档。每次编辑都会变成一个操作批次，任何副本应用后
  都能到达相同的值。这正是本地对象与远程对等方在没有谁是权威、且彼此可见的前提下收敛的原因。
- **Facet** 是打包单元：一个具名的服务、状态与配置的组合，由宿主在运行时加载。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [服务](#服务)
- [复制状态](#复制状态)
- [Facet](#facet)
- [远程服务](#远程服务)
- [Context](#context)
- [Delta 引擎](#delta-引擎)
- [入口](#入口)
- [开发](#开发)
- [来源](#来源)
- [License](#license)

## 安装

```bash
bun add @OnePanda-TgSec/chord
```

## 快速开始

```typescript
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { createFacetHost, defineFacet, defineService, replicatedState } from "@OnePanda-TgSec/chord";

interface Counter {
	increment(): Promise<number>;
	read(): number;
}

const CounterService = defineService<Counter>("app.counter", { local: true });

const counterFacet = defineFacet({
	id: "app.counter",
	services: [CounterService],
	state: replicatedState({ total: 0 }),
	async setup({ services, state }) {
		services.provide(CounterService, {
			increment: async () => ++state.value.total,
			read: () => state.value.total,
		});
	},
});

const host = await createFacetHost({ facets: [counterFacet] });
const counter = host.services.resolve(CounterService, BACKGROUND_CONTEXT);
await counter.increment();
console.log(counter.read());
```

## 服务

```typescript
const Weather = defineService<WeatherApi>("app.weather");                 // 仅本地
const Grid = defineService<GridApi>("app.grid", { mode: "remote" });      // 经传输层解析
```

`defineService` 返回一个 `Service<T>`——一个类型化的 id，而不是类。两端就 id 与接口达成一致即
可；彼此都不需要对方的引用。`local: true` 是"无法远程触达"服务的简写。

## 复制状态

`replicatedState(initial)` 返回一个由 facet 持有的可变句柄，以及任何人都可以订阅的只读
`ReplicatedState`。

这份契约是操作层面的，不是装饰性的：一次编辑经过 `Change`，`Change` 被 `prepare()` 成不可变的
`{ base, value, ops }`，副本应用这些 ops。没有人去 patch 一个共享对象。如果两个副本并发编辑，按
既定顺序应用双方的 op 集合会让两者收敛到相同的值——这就是全部意义所在。

`replicatedState` 是 JSON。`isJsonValue()` 与 `copyJson()` 守卫这条边界。

操作格式、重放规则与变更归属表见 [`src/delta/README.md`](src/delta/README.md)。

## Facet

facet 是一个具名的、自包含的单元：服务、状态，以及一个把它们接线起来的可选 `setup`。宿主通过
`FacetLoader` 加载 facet，因此 facet 集合可以在宿主运行期间变化。

```typescript
const loader = combineFacetLoaders([
	createStaticFacetLoader([coreFacet, counterFacet]),
	pluginLoader,
]);
const host = await createFacetHost({ facets: [], loader });
```

## 远程服务

远程服务就是经由传输层看到的本地服务。`createRemoteServiceBinding()` 描述一个，
`createRemoteServiceEndpoint()` 暴露一个 provider，`RemoteServiceProvider` 实现传输层一侧。

失败是类型化的：`RemoteServiceError`，带 `REMOTE_SERVICE_ERROR_CODES` 中的 code，用
`isRemoteServiceErrorCode()` 检查。一次失败的远程调用不是无法区分的通用错误。

线上编解码位于 `services/wire.ts`，以编/解码成对导出（`parseServiceCatalogue`、
`parseServiceCall`、`parseServiceSubscriptionSnapshot` 及对应的 wire 侧函数），因此用任何语言写
一个传输层都很容易。

## Context

每个异步调用都携带取消语义的 `Context`。

```typescript
import { BACKGROUND_CONTEXT, withAbortSignal, withCancel, awaitWithContext } from "@OnePanda-TgSec/chord/context";

const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
const value = await awaitWithContext(fetchSomething(context), context);
cancel();
```

`BACKGROUND_CONTEXT` 永不取消。`TODO_CONTEXT` 是"调用点应该带 context、但还没有"的标记。
`createContextKey` 与 `withContextValue` 附加请求级取值。

## Delta 引擎

复制状态背后的 diff/apply 引擎是一个独立入口：

```typescript
import { apply, applyImmutable, diffRevisions, track } from "@OnePanda-TgSec/chord/delta";

const tracker = track({ output: "" });
const change = tracker.beginChange();
change.state.output += "done\n";
const prepared = change.prepare();
const ops = diffRevisions(prepared.base, prepared.value);
tracker.adopt(prepared);
```

优先用 `applyImmutable` 而不是 `apply`：它永远不会把可变副本交给调用方——所有权 bug 是被防住
的，不是靠文档约束的。

## 入口

| 导入 | 内容 |
| --- | --- |
| `@OnePanda-TgSec/chord` | 服务、复制状态、facet、远程绑定类型。无副作用。 |
| `@OnePanda-TgSec/chord/context` | `Context`、取消辅助、`BACKGROUND_CONTEXT`。 |
| `@OnePanda-TgSec/chord/delta` | `track`、`diffRevisions`、`apply`、`applyImmutable`、路径与 op 校验。 |
| `@OnePanda-TgSec/chord/bundler` | 把 facet 包打包成内容寻址的产物。 |
| `@OnePanda-TgSec/chord/node` | Node 侧 loader：bundle loader、artifact loader、manifest reader。 |

## 开发

从 monorepo 根目录：

```bash
bun run check             # house standard、格式、类型
bun run test              # 每个包套件
bun run test packages/chord
```

Delta 基准：

```bash
cd packages/chord && bunx vitest bench
```

## 来源

从 [pi agent](https://github.com/earendil-works/pi) 项目以 `@earendil-works/chord` 身份采用，改牌
到 `@OnePanda-TgSec`。模块无增删重组，公开 API 不变。包名保持 `chord`、不带 `tg-` 前缀：这个前缀
标记端到端自有的包，而本包是整体采用进来的。见工作区根目录的
[`docs/provenance.md`](../../docs/provenance.md)。

## License

MIT
