# @OnePanda-TgSec/chord

Application composition runtime: services, replicated state, RPC, and plugins.

Chord is standalone. It depends on nothing in this workspace and nothing at runtime except its own
bundler, so it stays publishable on its own.

- **Services** are typed interfaces with a declared identity. A provider implements one; consumers
  resolve one by id and address. Services can be local, remote over a transport, or both.
- **Replicated state** is a JSON document with an ordered set of replicas. Every edit is turned
  into an operation batch that any replica can apply to reach the same value. That is what makes a
  local object and a remote peer converge without either being authoritative in a way the other
  cannot see.
- **Facets** are the packaging unit: a named bundle of services, state, and configuration that a
  host loads at runtime.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Services](#services)
- [Replicated State](#replicated-state)
- [Facets](#facets)
- [Remote Services](#remote-services)
- [Context](#context)
- [Delta Engine](#delta-engine)
- [Entry Points](#entry-points)
- [Development](#development)
- [Provenance](#provenance)
- [License](#license)

## Installation

```bash
bun add @OnePanda-TgSec/chord
```

## Quick Start

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

## Services

```typescript
const Weather = defineService<WeatherApi>("app.weather");                 // local only
const Grid = defineService<GridApi>("app.grid", { mode: "remote" });      // resolved over a transport
```

`defineService` returns a `Service<T>`, a typed id rather than a class. Two sides agree on the id and
the interface; neither needs a reference to the other. `local: true` is shorthand for a service that
cannot be reached remotely.

## Replicated State

`replicatedState(initial)` returns a mutable handle owned by a facet, and a read-only
`ReplicatedState` that anyone can subscribe to.

The contract is operational, not decorative: an edit goes through a `Change`, the change is
`prepare()`d into immutable `{ base, value, ops }`, and replicas apply the ops. Nobody patches a
shared object. If two replicas edit concurrently, applying both op sets in a defined order converges
both to the same value — that is the whole point.

`replicatedState` is JSON. `isJsonValue()` and `copyJson()` guard that boundary.

For the operation format, replay rules, and the mutation-ownership table, see
[`src/delta/README.md`](src/delta/README.md).

## Facets

A facet is a named, self-contained unit: services, state, and an optional `setup` that wires them
together. Hosts load facets through a `FacetLoader`, so the set can change while the host runs.

```typescript
const loader = combineFacetLoaders([
	createStaticFacetLoader([coreFacet, counterFacet]),
	pluginLoader,
]);
const host = await createFacetHost({ facets: [], loader });
```

## Remote Services

A remote service is a local service seen through a transport. `createRemoteServiceBinding()` describes
one, `createRemoteServiceEndpoint()` exposes a provider, and `RemoteServiceProvider` implements the
transport side.

Failures are typed: `RemoteServiceError` with codes from `REMOTE_SERVICE_ERROR_CODES`, checked with
`isRemoteServiceErrorCode()`. A remote call that fails is not an indistinguishable generic error.

Wire encoding lives in `services/wire.ts` and is exported as encode/decode pairs
(`parseServiceCatalogue`, `parseServiceCall`, `parseServiceSubscriptionSnapshot`, and their wire
counterparts) so a transport is easy to write in any language.

## Context

Every async call takes a `Context` carrying cancellation.

```typescript
import { BACKGROUND_CONTEXT, withAbortSignal, withCancel, awaitWithContext } from "@OnePanda-TgSec/chord/context";

const { context, cancel } = withCancel(BACKGROUND_CONTEXT);
const value = await awaitWithContext(fetchSomething(context), context);
cancel();
```

`BACKGROUND_CONTEXT` never cancels. `TODO_CONTEXT` is the marker for a call site that should take a
context but does not have one yet. `createContextKey` and `withContextValue` attach request-scoped
values.

## Delta Engine

The diff/apply engine behind replicated state is its own entry point:

```typescript
import { apply, applyImmutable, diffRevisions, track } from "@OnePanda-TgSec/chord/delta";

const tracker = track({ output: "" });
const change = tracker.beginChange();
change.state.output += "done\n";
const prepared = change.prepare();
const ops = diffRevisions(prepared.base, prepared.value);
tracker.adopt(prepared);
```

Prefer `applyImmutable` over `apply`: it never hands a caller a mutable replica, which is how
ownership bugs get prevented instead of documented.

## Entry Points

| Import | Contents |
| --- | --- |
| `@OnePanda-TgSec/chord` | Services, replicated state, facets, remote binding types. Side-effect free. |
| `@OnePanda-TgSec/chord/context` | `Context`, cancellation helpers, `BACKGROUND_CONTEXT`. |
| `@OnePanda-TgSec/chord/delta` | `track`, `diffRevisions`, `apply`, `applyImmutable`, path and op validation. |
| `@OnePanda-TgSec/chord/bundler` | Bundling a facet package into a content-addressed artifact. |
| `@OnePanda-TgSec/chord/node` | Node-side loaders: bundle loader, artifact loader, manifest reader. |

## Development

From the monorepo root:

```bash
bun run check             # house standard, formatting, types
bun run test              # every package suite
bun run test packages/chord
```

Delta benchmarks:

```bash
cd packages/chord && bunx vitest bench
```

## Provenance

Adopted from the [pi agent](https://github.com/earendil-works/pi) project as `@earendil-works/chord`
and rebranded under `@OnePanda-TgSec`. No module was added, removed, or restructured, and the public
API is unchanged. The name stays `chord` without a `tg-` prefix: the prefix marks packages owned end
to end, and this one was adopted whole. See
[`docs/provenance.md`](../../docs/provenance.md) in the workspace root.

## License

MIT