# @OnePanda-TgSec/tg-telemetry

Vendor-neutral telemetry contracts, a typed schema, and a conformance suite for adapters.

The point of this package is that an adapter author should not have to read anyone's SDK docs. You
implement two interfaces, and the conformance suite tells you exactly what you got wrong.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Contracts](#contracts)
- [Typed Schemas](#typed-schemas)
- [Implementing an Adapter](#implementing-an-adapter)
- [Conformance](#conformance)
- [In-Memory Recorder](#in-memory-recorder)
- [Entry Points](#entry-points)
- [Development](#development)
- [Provenance](#provenance)
- [License](#license)

## Installation

```bash
bun add @OnePanda-TgSec/tg-telemetry
```

## Quick Start

```typescript
import { NOOP_TELEMETRY_CONTEXT } from "@OnePanda-TgSec/tg-telemetry";

await NOOP_TELEMETRY_CONTEXT.startSpan({ name: "agent.turn" }, async (span) => {
	span.setAttributes({ "agent.model": "gpt-5.2", "agent.turn_index": 3 });
	span.addEvent("tool.call", { "tool.name": "weather" });
	span.setStatus({ status: "ok" });
});
```

`NOOP_TELEMETRY_CONTEXT` is the default when telemetry is not configured. It implements the same
interfaces and does nothing, so instrumentation can be written unconditionally.

## Contracts

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

Two properties matter and are what the conformance suite checks:

- **`startSpan` takes a callback, not a handle.** A span cannot outlive the work it measures. That
  removes the most common telemetry bug, a span that is started in one place and closed in another
  after an early return.
- **A `TelemetrySpan` is itself a `TelemetryContext`,** so nesting is `span.startSpan(...)` with no
  plumbing.

`SpanStatus` is `{ status: "ok" }` or `{ status: "error"; error?: { name; message } }`.

## Typed Schemas

A schema declares the spans and events an application emits, with per-attribute types. The types
then flow into the code that starts the spans, so a typo in an attribute name or a string where a
number belongs is a compile error.

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

Mark an attribute `sensitive: true` when it must not leave the process; adapters are expected to
redact it. `cardinality: "high"` warns adapter authors that unbounded values belong in an example
field instead.

## Implementing an Adapter

Implement `TelemetryContext`. `startSpan` must call the callback exactly once, with a `TelemetrySpan`
that forwards `addEvent`, `setAttributes`, and `setStatus` to the vendor SDK, and must:

- run the callback to completion and return its value,
- propagate the callback's rejection as the `startSpan` rejection,
- record `status` when the span closes, applying `status.default` unless `setStatus` overrode it,
- not swallow errors from `addEvent`, `setAttributes`, or `setStatus`.

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

The suite exercises callback completion, error propagation, nesting, attribute overwrites, event
ordering, and status resolution, then reports failures as individual test cases. Turn off
`expectEvents` or `expectStatus` if your vendor genuinely cannot deliver them; the suite will not
assert what you disclaimed.

## In-Memory Recorder

`InMemoryTelemetryContext` records spans and events instead of exporting them. Useful in tests, and
useful in development when you want to see what instrumentation actually fires:

```typescript
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";

const telemetry = new InMemoryTelemetryContext();
// ... run work ...
telemetry.spans; // RecordedTelemetrySpan[]
telemetry.reset();
```

## Entry Points

| Import | Contents |
| --- | --- |
| `@OnePanda-TgSec/tg-telemetry` | Contracts, schema types, `defineTelemetrySchema`, `createTypedSpanStarter`, `NOOP_TELEMETRY_CONTEXT`, `InMemoryTelemetryContext`. |
| `@OnePanda-TgSec/tg-telemetry/testing` | `createTelemetryAdapterConformance` and its option types. |

Keep `/testing` out of production bundles: it exists to fail adapters, not to ship.

## Development

From the monorepo root:

```bash
bun run check             # house standard, formatting, types
bun run test              # every package suite
bun run test packages/telemetry
```

## Provenance

Adopted from the [pi agent](https://github.com/earendil-works/pi) project as
`@earendil-works/pi-telemetry` and rebranded under `@OnePanda-TgSec`. No module was added, removed, or
restructured, and the public API is unchanged. See
[`docs/provenance.md`](../../docs/provenance.md) in the workspace root.

## License

MIT