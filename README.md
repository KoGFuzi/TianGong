# TianGong

> 天工 — an all-in-Bun monorepo for the OnePanda-TgSec agent, model, and terminal stack.

Eight packages. One runtime. One scope. Bun is the package manager, the script runner, and the
orchestration layer; `tsc` exists only to emit declarations for publication.

The workspace originated as a subset of the [pi agent](https://github.com/earendil-works/pi)
project. Six packages were adopted and rebranded under `@OnePanda-TgSec`. Two were migrated
verbatim and keep their upstream names. That split is deliberate and is stated in full in
[`docs/provenance.md`](docs/provenance.md).

## Quick start

```bash
bun install              # install the workspace
bun run generate:models  # hydrate packages/ai/src/providers/data (gitignored, network)
bun run build            # build all 8 packages in dependency order
bun run test             # run every package suite in dependency order
bun run check            # house standard, formatting, types, relative imports
```

Requires Bun 1.4+ and Node 22.19+ (Node for `tsc` and the `node:test` suites in `packages/tui`).

## Packages

### House packages — owned under `@OnePanda-TgSec`

| Package | Directory | What it is |
| --- | --- | --- |
| [`@OnePanda-TgSec/tg-ai`](packages/ai) | `packages/ai` | Unified LLM API. Model discovery, provider registry, streaming, OAuth, and an image-model registry behind one interface. |
| [`@OnePanda-TgSec/tg-agent-core`](packages/agent) | `packages/agent` | The agent loop. Transport abstraction, state management, tool execution, attachments. |
| [`@OnePanda-TgSec/tg-gibraltar`](packages/gibraltar) | `packages/gibraltar` | Durable conversation, task, and document runtime. SQLite is the only production backend. Everything is committed to storage before it is shown, so a killed process resumes where it stopped. |
| [`@OnePanda-TgSec/tg-tui`](packages/tui) | `packages/tui` | Terminal UI library with differential rendering, a full text editor, markdown and LaTeX rendering, and terminal images. |
| [`@OnePanda-TgSec/tg-telemetry`](packages/telemetry) | `packages/telemetry` | Vendor-neutral telemetry contracts and a typed schema, with a conformance suite for adapters. |
| [`@OnePanda-TgSec/chord`](packages/chord) | `packages/chord` | Application composition runtime: services, replicated state, RPC, and plugins, plus the delta/diff engine behind replicated JSON documents. |

Dependency graph:

```text
              telemetry ──▶ ai ──▶ agent
                   ▲
chord ─────────────────────▶ gibraltar
```

`tui`, `chord`, and `telemetry` are leaves. Nothing in the workspace depends on them except
`gibraltar` and `agent`, which is what keeps `chord` publishable on its own.

## Configuration

Config spans five XDG roots, resolved the way `opencode` resolves its own — one product directory per
root, each holding only what that root is for:

```text
~/.config/TianGong/          settings            $TIANGONG_CONFIG_DIR, $XDG_CONFIG_HOME
~/.local/share/TianGong/     machine state       $TIANGONG_DATA_DIR,   $XDG_DATA_HOME
├── auth.json                provider credentials, written by `tg-ai login`
└── session.sqlite           default session database
~/.local/state/TianGong/     locks               $TIANGONG_STATE_DIR,  $XDG_STATE_HOME
~/.cache/TianGong/           disposable cache    $TIANGONG_CACHE_DIR,  $XDG_CACHE_HOME
os.tmpdir()/TianGong         scratch
```

```typescript
import { tiangongDataPath, tiangongSessionDbPath } from "@OnePanda-TgSec/tg-ai";

tiangongSessionDbPath(); // ~/.local/share/TianGong/session.sqlite
tiangongDataPath("auth.json");
```

`auth.json` sits under **data**, not config, matching `opencode`: credentials are machine-generated
runtime state, not user-authored configuration. A `$TIANGONG_*_DIR` value must be absolute; a relative
one is rejected rather than silently written next to the working directory.

### Environment variables

Every variable the workspace reads carries the `TG_` prefix:

| Variable | Read by | Effect |
| --- | --- | --- |
| `TG_CACHE_RETENTION` | `tg-ai` | `long` selects long-lived provider prompt caches. |
| `TG_OAUTH_CALLBACK_HOST` | `tg-ai` | Host the local OAuth callback listener binds to. |
| `TG_TUI_WRITE_LOG` | `tg-tui` | Capture the raw ANSI stream written to stdout. |
| `TG_TUI_DEBUG`, `TG_TUI_DEBUG_REDRAW` | `tg-tui` | Main-screen debug output, full-redraw tracing. |
| `TG_TUI_ESC_TIMEOUT` | `tg-tui` | Escape-sequence disambiguation window, in milliseconds. |
| `TG_TRUE_COLOR`, `TG_HYPERLINKS`, `TG_IMAGE_PROTOCOL` | `tg-tui` | Terminal capability overrides. |

Two things keep upstream naming and are deliberately unreachable from TypeScript:
`packages/tui/native/` (the C/Objective-C addon keeps its `PI_NAPI_*` and `PI_CLIPBOARD_*`
preprocessor macros) and `packages/tui/test/fixtures/*.c` (compiled against `native/napi.h`).

### Vendored packages — migrated from pi agent, unchanged

| Package | Directory | Upstream version | What it is |
| --- | --- | --- | --- |
| `@earendil-works/pi-codemode` | `packages/codemode` | `1.0.1` | Sandboxed JavaScript execution where the only capability is calling injected tools (QuickJS/WASI). |
| `@earendil-works/pi-mcp` | `packages/mcp` | `1.0.1` | Standalone Model Context Protocol client: transport-neutral core, stdio and Streamable HTTP transports, OAuth subset, in-memory testing transport. |

## Migration declaration: codemode and mcp

`packages/codemode` and `packages/mcp` were **migrated verbatim from the pi agent project**
(`earendil-works/pi`, MIT, authored upstream as "Earendil Works"). They were **not** renamed,
**not** re-authored, **not** reformatted, and **not** patched.

They keep their upstream package names (`@earendil-works/pi-codemode`,
`@earendil-works/pi-mcp`), their upstream author field, their upstream repository metadata, and
their upstream version numbers. The reason is publishing continuity: both are independently
released packages with their own changelog history, and both track fast-moving upstream surfaces,
so an upstream fix can be pulled in as a straight file replacement rather than a re-derivation.

House packages import them by their upstream names. Those two specifiers are the only
`@earendil-works/*` names any house package may use, and `bun run check:house-standard` fails the
build on any other. Vendored packages never import a house package.

The complete statement — files taken, boundary rules, re-sync procedure, and why each package was
adopted — is in [`docs/provenance.md`](docs/provenance.md).

## House standard

Full rules in [`AGENTS.md`](AGENTS.md). The short version:

- Scope `@OnePanda-TgSec`, root repo `tiangong`, author `KoGFuzi`, MIT, one shared `2.x` version
  line across the root and all six house packages.
- Every identifier carries the `tg` prefix: package names `tg-*`, persisted kinds `tg.*`, types
  `Tg*`, environment variables `TG_*`, product references `TianGong`, config `~/.config/TianGong`.
  No `pi`-prefixed identifier survives in house code.
- `chord` is the recorded exception to the `tg-` package prefix, and `packages/tui/native/` is the
  recorded exception to the identifier rule.
- Vendored packages are frozen. Local adaptations belong in the calling house package.
- Tabs, width 3, line width 120, double quotes, Biome-owned. Only erasable TypeScript syntax.
- Every relative import carries its extension.
- One `packages/*/CHANGELOG.md` per house package, entries under `## [Unreleased]`.

Enforcement lives in `bun run check:house-standard` (`scripts/check-house-standard.ts`), which
classifies every package, asserts house metadata, asserts the vendored freeze, and rejects any
`pi`-prefixed identifier in house code outside a fixed allow-list of third-party and upstream names
(Radius's `radius.pi.dev` gateway, the native addon's C macros, LaTeX, and upstream project URLs).

## Scripts

| Command | What it does |
| --- | --- |
| `bun run build` | Builds all packages in dependency order. `--offline` uses each package's `build:offline`. |
| `bun run build:offline` | Same, skipping the network-backed model catalog refresh. |
| `bun run clean` | Removes `dist/` and generated model data. |
| `bun run check` | House standard, Biome, `tsc --noEmit`, relative-import rule. |
| `bun run check:format:write` | Applies Biome formatting. |
| `bun run check:house-standard` | Package classification, metadata, vendored freeze. |
| `bun run check:relative-imports` | Every relative import must name its extension. |
| `bun run generate:models` | Regenerates `packages/ai/src/models.generated.ts` and `src/providers/data/`. |
| `bun run hydrate:model-data` | Refreshes only the generated provider data. |
| `bun run generate:model-catalog` | Writes the publishable catalog to `.artifacts/model-catalog`. |
| `bun run test` | Every package suite in dependency order. Pass a package to narrow it. |
| `bun run version:patch\|minor\|major` | Moves the shared house version line. Vendored packages keep theirs. |

### Session storage

`@OnePanda-TgSec/tg-gibraltar` persists to **SQLite only**. `openDefaultSqliteStorage()` opens
`~/.local/share/TianGong/session.sqlite` with no argument; `openNodeSqliteStorage(path, { project })`
names a file and scopes every row to one project. Every row carries `project_id` and every read is
filtered by it, so one file can hold several projects without either seeing the other's data. The
append-only JSONL backend was removed: two production file formats means two migration and recovery
paths, and only one was ever going to be tuned. `MemoryStorage` remains, for tests.

```typescript
import { openDefaultSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const storage = await openDefaultSqliteStorage();
console.log(await storage.health()); // integrity, schema version, WAL mode, synchronous, busy timeout
await storage.checkpoint();          // wal_checkpoint(TRUNCATE)
```

`bun test` is **not** the runner. Bun reserves that name for its own runner, which would bypass
every per-package Vitest and `node:test` configuration.

### Storage

SQLite is the only production backend. `openDefaultSqliteStorage()` opens `~/.local/share/TianGong/session.sqlite`
with no argument; `openNodeSqliteStorage(path, { project })` names a file and scopes every row to one
project. Every row carries `project_id` and every read is filtered by it, so one file can hold several
projects without either seeing the other's data. The append-only JSONL backend was removed: two
production file formats means two migration and recovery paths, and only one was ever going to be
tuned. `MemoryStorage` remains, for tests.

```typescript
import { openDefaultSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const storage = await openDefaultSqliteStorage();
console.log(await storage.health()); // integrity, schema version, WAL mode, synchronous, busy timeout
await storage.checkpoint(); // wal_checkpoint(TRUNCATE)
```

## Layout

```text
.
├── AGENTS.md              house standard
├── biome.json             formatting and lint rules for the workspace
├── bunfig.toml            exact versions, hoisted node_modules
├── package.json           Bun workspace root
├── tsconfig.base.json     compiler options every package build extends
├── tsconfig.json          root type check, workspace path map
├── tsconfig.scripts.json  type check for scripts/, with Bun globals
├── vitest.base.ts         shared Vitest alias map
├── docs/provenance.md     package origins, including the vendored declaration
├── scripts/               Bun orchestration and house-standard checks
├── .githooks/             pre-commit gate, installed by `bun run prepare`
└── packages/              the eight workspace packages
```

## License

MIT. See [`LICENSE`](LICENSE).

Vendored packages retain their upstream licenses. `packages/mcp/LICENSES/` carries the license text
for the Model Context Protocol TypeScript SDK definitions vendored inside it.