# @OnePanda-TgSec/tg-ai

One interface to every model provider, with model discovery and provider auth handled for you.

`createModels()` gives you a registry of providers. You ask it for a model by `provider` and `id`;
it resolves credentials, picks the right wire API, and hands back a stream. Providers are opt-in, so
importing this package does not pull in every SDK.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Entry Points](#entry-points)
- [Models](#models)
- [Streaming](#streaming)
- [Providers](#providers)
- [Authentication](#authentication)
- [Model Data](#model-data)
- [Tools and TypeBox](#tools-and-typebox)
- [Utilities](#utilities)
- [Development](#development)
- [Provenance](#provenance)
- [License](#license)

## Installation

```bash
bun add @OnePanda-TgSec/tg-ai
```

## Quick Start

```typescript
import { createModels } from "@OnePanda-TgSec/tg-ai/models";
import { openaiProvider } from "@OnePanda-TgSec/tg-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider()); // reads OPENAI_API_KEY

await models.refresh(); // fetch the live model list for configured providers

const model = models.getModel("openai", "gpt-5.2")!;
const stream = models.streamSimple(model, {
	systemPrompt: ["You are terse."],
	messages: [{ role: "user", content: "Capital of France?" }],
});

for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta);
}
```

## Entry Points

| Import | Contents |
| --- | --- |
| `@OnePanda-TgSec/tg-ai` | Types, the registry interface, `Type`, and shared utilities. Side-effect free. |
| `@OnePanda-TgSec/tg-ai/models` | `createModels()`, `createProvider()`, cost and thinking helpers. |
| `@OnePanda-TgSec/tg-ai/providers/*` | One module per provider, e.g. `providers/openai`. |
| `@OnePanda-TgSec/tg-ai/providers/all` | `builtinProviders()`, every provider factory at once. |
| `@OnePanda-TgSec/tg-ai/api/*` | Wire implementations, e.g. `api/anthropic-messages`. |
| `@OnePanda-TgSec/tg-ai/utils/*` | Retry, validation, transcript helpers, token estimation. |
| `@OnePanda-TgSec/tg-ai/compat` | The older global-API shape, kept working. |
| `@OnePanda-TgSec/tg-ai/oauth` | OAuth login flows on their own. |
| `@OnePanda-TgSec/tg-ai/models.generated` | Generated catalog constants. Do not edit. |

The root entry point deliberately does not load catalogs, provider factories, or OAuth
implementations. Import from the specific path you need.

## Models

`createModels()` returns a `MutableModels`. The registry is synchronous for reads and asynchronous
for anything that touches the network or the credential store.

```typescript
models.getProviders();                       // registered providers
models.getModels("openai");                 // last-known chat models
models.getModel("openai", "gpt-5.2");       // one model, or undefined
models.getModelsOfType("embedding", "openai");
models.getAllModels();                      // every model type, every provider

await models.refresh();                     // refetch dynamic provider lists
await models.getAvailable();                // only models whose auth is configured
await models.getAuth(model);                // resolved credential, or undefined
```

Reads come from the last-known lists. A provider whose refresh throws yields no models rather than
failing the whole call, and `refresh()` reports per-provider errors instead of rejecting.

## Streaming

Four entry points, differing only in how much they know about the wire:

```typescript
models.stream(model, context, options);        // Model<TApi>: typed per API
models.complete(model, context, options);      // one shot, returns the message
models.streamSimple(model, context, options);  // Model<Api>: the portable shape
models.completeSimple(model, context, options);
```

`streamDeferred()` and `fetchDeferred()` handle deferred/long-running responses (batch jobs and
similar): keep the handle, fetch later, cancel if you change your mind.

All of them return an `AssistantMessageEventStream`. Failures are encoded in the stream as protocol
events and a final message with `stopReason` of `"error"` or `"aborted"`. Nothing rejects, so a
consumer that only iterates the stream cannot miss a failure.

Also available: `generateImages()` for image models and `classify()` for classifier models. Neither
rejects; both return an error result instead.

## Providers

```typescript
import { builtinProviders } from "@OnePanda-TgSec/tg-ai/providers/all";

const models = createModels({ providers: builtinProviders() });
```

`createModels({ providers })` registers them at construction. Otherwise `setProvider()` one at a
time. Provider ids are unique; setting the same id twice replaces it.

To wire a provider that is not built in, use `createProvider()`. It takes the base URL, the api
implementation, model metadata, and an auth strategy, and returns a `Provider<TApi>` you can register
like any other.

## Authentication

Two shapes, unified behind `getAuth()`:

- **API keys** from the environment. Provider factories read them by convention
  (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and so on).
- **OAuth** for providers that offer it: Anthropic, OpenAI ChatGPT and Codex, GitHub Copilot,
  OpenRouter, Google, xAI, Mistral, Kimi, and Radius.

```typescript
const auth = await models.getAuth(model);
await models.login("github-copilot", "oauth", interaction);
await models.logout("github-copilot");
await models.checkAuth("openai");
```

`getAuth()` rejects with a `ModelsError` rather than silently continuing: code `"oauth"` when a token
refresh failed (the stored credential is preserved so a retry or a re-login works), code `"auth"`
when key resolution or the credential store failed. Request paths surface those rejections as stream
errors.

For a short-lived token that expires mid-run, resolve it per request instead of once:

```typescript
const agent = new Agent({ getApiKey: async (provider) => (await models.getAuth(provider))?.apiKey });
```

## Model Data

Provider model lists are generated, not hand-maintained.

```bash
bun run generate:models         # writes src/models.generated.ts and src/providers/data/
bun run hydrate:model-data      # only the provider data
bun run generate:model-catalog  # publishable catalog under .artifacts/model-catalog
bun run check:model-data        # verify the checked-in data is internally consistent
```

`src/providers/data/` is gitignored. Run `generate:models` before building or testing this package;
CI does the same. `src/models.generated.ts` is checked in but generated: edit
`scripts/generate-models.ts`, never the output.

## Tools and TypeBox

Tool schemas are TypeBox, re-exported so there is exactly one copy in a dependency tree:

```typescript
import { Type } from "@OnePanda-TgSec/tg-ai";

const parameters = Type.Object({ city: Type.String(), units: Type.Optional(Type.Union([Type.Literal("c"), Type.Literal("f")])) });
```

`validateToolArguments()` and the other helpers in `utils/validation` turn a raw tool call into
typed parameters, or into the error message the model should see.

## Utilities

`utils/retry` for retry policy with provider-aware backoff, `utils/transcript` for turning
`AgentMessage[]` into provider messages and back, `utils/estimate` for token estimation,
`utils/overflow` for context-window accounting, `utils/json-parse` for partial and streamed JSON,
`utils/event-stream` for stream helpers, and `utils/diagnostics` for provider error classification.

## Development

From the monorepo root:

```bash
bun run generate:models   # required first: src/providers/data/ is gitignored
bun run check             # house standard, formatting, types
bun run test              # every package suite
bun run test packages/ai  # this package only
```

## Provenance

Adopted from the [pi agent](https://github.com/earendil-works/pi) project as
`@earendil-works/pi-ai` and rebranded under `@OnePanda-TgSec`. No module was added, removed, or
restructured; the naming layer was renamed throughout, including the `api/tg-messages.ts`
implementation and its `TgMessages*` types, which now carry the `tg-` prefix. See
[`docs/provenance.md`](../../docs/provenance.md) in the workspace root.

## License

MIT