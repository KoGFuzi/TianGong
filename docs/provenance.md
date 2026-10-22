# Package provenance

Every directory under `packages/` either belongs to us or is vendored. This file says which is
which, and for the vendored ones, exactly what was taken and what was deliberately left alone.

The machine-readable version of this statement lives in
[`scripts/lib/packages.ts`](../scripts/lib/packages.ts) (`VENDORED_PACKAGES`). `bun run
check:house-standard` asserts against that record, so the two cannot drift apart silently.

## Summary

| Directory | Package | Origin | Status |
| --- | --- | --- | --- |
| `packages/chord` | `@OnePanda-TgSec/chord` | pi agent, adopted and rebranded | House |
| `packages/tui` | `@OnePanda-TgSec/tg-tui` | pi agent, adopted and rebranded | House |
| `packages/telemetry` | `@OnePanda-TgSec/tg-telemetry` | pi agent, adopted and rebranded | House |
| `packages/ai` | `@OnePanda-TgSec/tg-ai` | pi agent, adopted and rebranded | House |
| `packages/gibraltar` | `@OnePanda-TgSec/tg-gibraltar` | pi agent, adopted and rebranded | House |
| `packages/env` | `@OnePanda-TgSec/tg-env` | pi agent, adopted and rebranded | House |
| `packages/sec-guard` | `@OnePanda-TgSec/tg-sec-guard` | **TianGong-authored**, from `docs/sec-guard-design.md` | House, added 2026-10-22 |
| `packages/agent` | `@OnePanda-TgSec/tg-agent-core` | pi agent, adopted and rebranded | **Removed 2026-10-22** (snapshot in `scripts/legacy/agent-core`) |
| `packages/sec-agent` | `@OnePanda-TgSec/tg-sec-agent` | pi agent, adopted and rebranded | **Removed 2026-10-22** (snapshot in `scripts/legacy/sec-agent`) |
| `packages/codemode` | `@earendil-works/pi-codemode` | **pi agent 1.3.0, migrated verbatim** | **Vendored, frozen** |
| `packages/mcp` | `@earendil-works/pi-mcp` | **pi agent 1.3.0, migrated verbatim** | **Vendored, frozen** |

Upstream project for every row above: **[pi agent](https://github.com/earendil-works/pi)**
(`earendil-works/pi`), MIT licensed, authored upstream as "Earendil Works".

---

## Vendored packages: migrated verbatim from pi agent

### Statement

`packages/codemode` and `packages/mcp` were migrated **as-is** out of the pi agent project. They
were **not** renamed to the `@OnePanda-TgSec` scope, **not** re-authored, **not** reformatted, and
**not** patched. In this repository they keep their upstream package names, upstream authorship,
upstream repository metadata, and upstream version numbers, because:

1. **Publishing continuity.** Both are independently published packages with their own release
   history and changelog. Re-scoping them would fork the identity that existing consumers,
   lockfiles, and audit trails reference.
2. **Upstream maintenance.** Both track a fast-moving protocol surface: MCP in particular follows
   a specification that changes often. Staying byte-compatible with upstream means an upstream
   fix can be pulled in as a straight file replacement instead of a re-derivation.
3. **Reviewability.** A vendored package that is untouched is trivially auditable. Any local edit
   would make "is this still upstream?" a question that needs answering on every future bump.

What *is* ours is the workspace that hosts them: they are built by `bun run build`, tested by
`bun test`, type-checked against the root `tsconfig.json`, and released from this repository.

### Boundary

- House packages import them by their **upstream** specifiers:
  ```ts
  import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
  import { createSandbox } from "@earendil-works/pi-codemode";
  ```
  Those two specifiers are the *only* `@earendil-works/*` names any house package may use.
  `bun run check:house-standard` fails the build on any others.
- Vendored packages never import a house package. They cannot know about us, and a dependency in
  that direction would make the freeze unreviewable.
- House code reaches them by their **upstream** specifiers, resolved through the root `tsconfig.json`
  path map; no package manifest declares them as a dependency.
- The one exception to the byte-for-byte freeze is a locally pinned `shx` devDependency, recorded
  under [Re-syncing a vendored package](#re-syncing-a-vendored-package) below.

### `@earendil-works/pi-codemode` — `packages/codemode`

| Field | Value |
| --- | --- |
| Upstream package | `@earendil-works/pi-codemode` |
| Upstream path | `packages/codemode` in `earendil-works/pi` |
| Upstream version adopted | `1.3.0` |
| Upstream author | Earendil Works |
| Upstream license | MIT |
| Adopted into TianGong | 2026-10-04 |
| Re-synced | 2026-10-10 (from `1.0.1`) |
| Re-synced | 2026-10-17 (from `1.1.0`) |
| Role in this repo | QuickJS/WASI sandbox whose only capability is calling injected tools |

What it provides: a sandboxed JavaScript execution runtime (`quickjs-wasi`) plus the type
declaration generator that lets a model write calls against injected tool signatures. It is
dependency-free from the rest of the workspace, which is why the freeze is cheap.

Files taken, unmodified:

```text
packages/codemode/package.json
packages/codemode/tsconfig.build.json
packages/codemode/vitest.config.ts
packages/codemode/README.md
packages/codemode/CHANGELOG.md
packages/codemode/src/{index,types,source,declarations,identifier,wasm,portable,cloudflare}.ts
packages/codemode/src/cloudflare-modules.d.ts
packages/codemode/src/runtime/{host,protocol,worker,prelude-source,execution,inline,remote,vm}.ts
packages/codemode/test/{declarations,sandbox,source,deterministic,portable,worker-lifetime}.test.ts
packages/codemode/test/fixtures/{raw-worker,worker-process-exit}.ts
packages/codemode/examples/cloudflare/**
```

Notes:

- `src/types.ts` and `src/runtime/worker.ts` self-reference `@earendil-works/pi-codemode/worker`.
  That is upstream's own package name and stays as-is.
- `README.md` and `CHANGELOG.md` are upstream documents and still reference upstream package names.
  They describe the package as published, and they are kept here so the vendored copy is a complete
  mirror rather than a subset. This file is the TianGong-side record of the package's presence.

### `@earendil-works/pi-mcp` — `packages/mcp`

| Field | Value |
| --- | --- |
| Upstream package | `@earendil-works/pi-mcp` |
| Upstream path | `packages/mcp` in `earendil-works/pi` |
| Upstream version adopted | `1.3.0` |
| Upstream author | Earendil Works |
| Upstream license | MIT, plus `LICENSES/modelcontextprotocol-typescript-sdk.txt` for the vendored type definitions |
| Adopted into TianGong | 2026-10-04 |
| Re-synced | 2026-10-10 (from `1.0.1`) |
| Re-synced | 2026-10-17 (from `1.1.0`) |
| Role in this repo | Standalone Model Context Protocol client: transport-neutral core, stdio and Streamable HTTP transports, OAuth subset, in-memory testing transport |

What it provides: an MCP client that depends on neither the official MCP SDK nor any other pi
package. `@earendil-works/pi-mcp/oauth` exposes the MCP OAuth client subset; `@earendil-works/pi-mcp/testing`
exposes the in-memory transport used by conformance tests.

Files taken, unmodified:

```text
packages/mcp/package.json
packages/mcp/tsconfig.build.json
packages/mcp/vitest.config.ts
packages/mcp/CHANGELOG.md
packages/mcp/README.md
packages/mcp/LICENSES/modelcontextprotocol-typescript-sdk.txt
packages/mcp/src/**            (index, client, errors, types, protocol/**, transports/**, oauth/**, testing/**)
packages/mcp/test/**           (including fixtures/stdio-server.mjs and fixtures/stubborn-server.mjs)
```

Notes:

- `packages/mcp/README.md` and `packages/mcp/CHANGELOG.md` are upstream documents and still
  reference upstream package names such as `@earendil-works/pi-ai`. That is intentional: they
  describe the package as published. Where you need the TianGong integration view, read
  [`scripts/legacy/agent-core/examples/mcp-codemode`](../scripts/legacy/agent-core/examples/mcp-codemode)
  (the workspace example, kept as a snapshot after `packages/agent` was removed) and this file.
- `packages/mcp/src/**` must not gain an import of `@OnePanda-TgSec/*`. One file,
  `src/protocol/content.ts`, carries a doc comment naming `@earendil-works/pi-ai`; it was left as
  upstream wrote it.
- `LICENSES/` and `test/fixtures/` carry upstream license and harness text. Never edit.

### Re-syncing a vendored package

The vendored copy is a **complete mirror**, not a subset: every file upstream ships in
`packages/mcp/` and `packages/codemode/` is present here, and every one of them is byte-identical
(verified by git object hash) — with **one recorded local deviation**: the `shx` devDependency in
both `package.json` files is pinned to `0.4.0`, while upstream 1.3.0 ships `0.3.4`. TianGong keeps a
single `shx` version across the workspace and avoids the deprecated `shelljs@0.8.5`/`glob@7` tree
that `0.3.4` resolves to. The pin is version-controlled and re-applied on every re-sync.

1. Take the upstream directory at the target tag.
2. Replace the directory contents wholesale. Do not merge.
3. Re-pin `shx` to `0.4.0` in the two vendored `package.json` files (the deviation above).
4. Update `version` and the record in `VENDORED_PACKAGES` in `scripts/lib/packages.ts`.
5. Note the bump in this file's summary table.
6. Run `bun install --ignore-scripts`, then `bun run check && bun run test`.

If the upstream change needs a local adaptation to work inside TianGong, that adaptation belongs
in the calling house package, not in the vendored directory.

---

## House packages: adopted and rebranded

Eight packages started as pi agent packages and were brought under the TianGong house standard;
six remain in the workspace (`tg-agent-core` and `tg-sec-agent` were removed 2026-10-22, their
snapshots in [`scripts/legacy/`](../scripts/legacy/README.md)). Their
source, layout, and public API shape are upstream's; the **naming layer** is ours.

What "rebranded" means concretely, for every one of them:

- `package.json` `name` moved to `@OnePanda-TgSec/*`, version to the shared `2.0.1` line,
  `author` to `KoGFuzi`, `license` to MIT, `repository` to `github.com/KoGFuzi/TianGong`.
- Every import specifier of a sibling package rewritten to its `@OnePanda-TgSec/*` name.
- `packages/env` additionally renamed the daemon and its binary to `tg-env`, the `PI_ENV_*` environment
  variables to `TG_ENV_*`, and its remote deployment directory from `~/.pi/mobile/tools` to
  `~/.tiangong/mobile/tools`.
- Root `tsconfig.json` path map, `vitest.base.ts` aliases, and per-package `tsconfig.build.json`
  paths updated to match.
- `README.md` and `CHANGELOG.md` written for the TianGong names and install commands.

What "rebranded" does **not** mean: no module was added, removed, renamed, or restructured, and
no public API changed. Module layout is the one thing carried over untouched.

### Name mapping

| Upstream specifier | TianGong specifier |
| --- | --- |
| `@earendil-works/pi-ai` | `@OnePanda-TgSec/tg-ai` |
| `@earendil-works/chord` | `@OnePanda-TgSec/chord` |
| `@earendil-works/pi-durable` | `@OnePanda-TgSec/tg-gibraltar` |
| `@earendil-works/pi-tui` | `@OnePanda-TgSec/tg-tui` |
| `@earendil-works/pi-telemetry` | `@OnePanda-TgSec/tg-telemetry` |
| `@earendil-works/pi-agent-core` | `@OnePanda-TgSec/tg-agent-core` *(removed 2026-10-22)* |
| `@earendil-works/pi-coding-agent` | `@OnePanda-TgSec/tg-sec-agent` *(removed 2026-10-22)* |
| `@earendil-works/pi-client` | *not carried over* |
| `@earendil-works/pi-protocol` | *not carried over* |
| `@earendil-works/pi-server` | *not carried over* |
| `@earendil-works/pi-env` | `@OnePanda-TgSec/tg-env` |
| `@earendil-works/pi-mcp` | *unchanged, vendored* |
| `@earendil-works/pi-codemode` | *unchanged, vendored* |

Two upstream names are worth calling out because they are not mechanical substitutions:

- `pi-durable` became **`tg-gibraltar`**, not `tg-durable`. The durable execution runtime is the
  project's load-bearing piece and carries a product name rather than a description of its
  mechanism. The directory is `packages/gibraltar`; `repository.directory` was corrected to match.
- `chord` kept its bare name. Only house packages we own end to end carry the `tg-` prefix, and
  `chord` was adopted whole.
- `pi-coding-agent` became **`tg-sec-agent`**, matching its then-directory `packages/sec-agent`. Its
  `pi` binary was published as `tg`, and its imports resolved to the sibling house packages
  (`tg-ai`, `tg-agent-core`, `tg-gibraltar`, `tg-tui`), `chord`, and the two vendored ones.
  Both `tg-sec-agent` and `tg-agent-core` were removed from the workspace on 2026-10-22.

### Identifier rename

The `tg` prefix was then carried past package names, through every identifier a house package owns.
This is a rename, not an alias layer: there is one spelling and no fallback reader.

| Upstream identifier | TianGong identifier |
| --- | --- |
| `pi.user`, `pi.assistant`, `pi.system`, `pi.reset`, `pi.tool`, `pi.tool-result`, `pi.compaction` | `tg.*` equivalents |
| `pi.agent`, `pi.live`, `pi.inbox`, `pi.usage` | `tg.*` equivalents |
| `pi.generation` | `tg.generation` |
| `PiMessagesOptions`, `PiMessagesEvent`, `PiMessagesUsage`, `PiMessagesErrorBody`, `PiMessagesStopReason`, `PiMessagesRewriteImpact`, `PiMessagesResponseError` | `TgMessages*` equivalents |
| `PiAnthropic` | `TgAnthropic` |
| `piMessagesApi` | `tgMessagesApi` |
| `getPiUserAgent()` | `getTgUserAgent()` |
| `api/pi-messages.ts`, `api/pi-messages.lazy.ts` | `api/tg-messages.ts`, `api/tg-messages.lazy.ts` |
| `utils/pi-user-agent.ts` | `utils/tg-user-agent.ts` |
| the `pi-messages` API id | `tg-messages` |
| `PI_CACHE_RETENTION`, `PI_OAUTH_CALLBACK_HOST` | `TG_*` equivalents |
| `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_EXPERIMENTAL`, `PI_TELEMETRY`, and the rest of the coding agent's `PI_*` family | `TG_*` equivalents |
| the `.pi` project directory | `.tiangong` |
| `PI_TUI_WRITE_LOG`, `PI_TUI_DEBUG`, `PI_TUI_DEBUG_REDRAW`, `PI_TUI_ESC_TIMEOUT`, `PI_TRUE_COLOR`, `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL` | `TG_*` equivalents |
| `pi (linux ...)` User-Agent product token | `tg (linux ...)` |
| `~/.pi/agent/` | `$XDG_CONFIG_HOME/TianGong/` |
| `~/.pi/agent/auth.json` | `~/.local/share/TianGong/auth.json` |

The persisted `tg.*` kinds are the one entry with storage consequences. They are written into
transcripts, document tables, and SQLite migrations. This workspace had no storage to be compatible
with, so they were renamed in one step. Reading storage written by an upstream release means
rewriting those kind strings in place first.

### Config layout

The config directory was resolved against one root, then against five. `opencode` resolves five XDG
roots — data, cache, config, state, and a temp directory — and keeps `auth.json` under **data**, not
config, because credentials are machine-generated runtime state rather than user-authored settings.
TianGong now does the same:

```text
~/.config/TianGong/          user-authored settings
~/.local/share/TianGong/     auth.json, session.sqlite, snapshots, logs
~/.local/state/TianGong/     locks
~/.cache/TianGong/           disposable cache
os.tmpdir()/TianGong         scratch
```

`packages/ai/src/config-paths.ts` is the single resolver, exported as `./config-paths`. Each root
takes a `$TIANGONG_*_DIR` absolute override on top of `$XDG_*_HOME`, which is what a test or an
embedded process needs to relocate everything at once.

The removed `packages/sec-agent` used the same resolver. Its settings, models, themes, prompts, and
tools lived under the config root; `auth.json`, session files, and the debug log lived under the
data root. Project-local resources lived in `<project>/.tiangong/`. `TG_CODING_AGENT_DIR` was the
package's test-and-embedding override and relocated both roots into one directory.

### Upstream services

`pi-coding-agent` called hosted services that have no TianGong counterpart: a release feed, a remote
model catalog, MCP Client ID Metadata Documents, a managed installer, a share viewer, and install
telemetry. Localization kept the code paths but made them opt-in with `TG_*` variables and removed
install telemetry; the package itself was removed 2026-10-22. With nothing configured, no request
left the machine:

| Variable | Feature |
| --- | --- |
| `TG_VERSION_CHECK_URL` | Release feed for the startup version check |
| `TG_MODEL_CATALOG_URL` | Remote model-catalog overlay |
| `TG_MCP_CLIENT_METADATA_BASE_URL` | Host for MCP Client ID Metadata Documents |
| `TG_INSTALLER_API_BASE` | Managed-install update artifacts |
| `TG_SHARE_VIEWER_URL` | Viewer prefix for `/share`; without it, only the gist URL is printed |

### Session storage

`@earendil-works/pi-durable` shipped two file backends: SQLite and an append-only JSONL directory.
TianGong keeps **SQLite only** and deletes JSONL, with its `/storage/jsonl` export subpaths.

Two production file formats means two migration paths, two recovery paths, and two sets of crash
semantics to reason about, and only one of them was ever going to be tuned. SQLite brings WAL,
atomic multi-table commits, and `integrity_check`; JSONL brought none of those. JSONL storage written
by an upstream release has no reader here — that is a stated consequence of converging before any
deployment, not an oversight.

What was added to make it shippable, in place of the removed backend:

- `openDefaultSqliteStorage()`: `~/.local/share/TianGong/session.sqlite`, no path argument.
- `project` isolation: every row carries `project_id`, every read filters on it. Schema version 2
  assigns pre-isolation rows to `"default"` and rebuilds the secondary indexes with a project prefix.
- `storage.health()` and `storage.checkpoint()` for a health endpoint and manual log reclamation.
- `ApiKeyAuthenticator` and its key helpers in `packages/ai/src/auth/api-key.ts`.
- `PRAGMA foreign_keys = ON` and a startup `PRAGMA wal_checkpoint(PASSIVE)`.

### Names deliberately left as `pi`

Four things are exempt, each enforced by an explicit allow-list entry in
`scripts/check-house-standard.ts`:

1. **Radius**, a third-party gateway: `radius.pi.dev`, the `pi-gateway` OAuth client id, and the
   `x-pi-gateway-upstream-provider` header. Renaming these breaks the integration.
2. **`packages/tui/native/`**: the C and Objective-C addon keeps `PI_NAPI_*` and `PI_CLIPBOARD_*`.
   `packages/tui/test/fixtures/*.c` compiles against `native/napi.h` and must use the same macros.
   Neither is reachable from TypeScript.
3. **`packages/tui/src/latex.ts`**: bare `pi`, `alpha`, `sum` are LaTeX names, not identifiers.
4. **Upstream project references**: `earendil-works/pi` URLs, the phrase `pi agent`, and `pi-mono`
   in released changelog history.

Documentation is exempt as a category, because prose must be able to record what a rename replaced.

### Directory name versus package name

Upstream's `packages/durable` directory holds `@OnePanda-TgSec/tg-gibraltar` here. The directory
name was kept as-is because the module framework was carried over unchanged; only the package
name changed. Upstream's `packages/agent` likewise held `@OnePanda-TgSec/tg-agent-core`, and
upstream's `packages/coding-agent` held `@OnePanda-TgSec/tg-sec-agent` in `packages/sec-agent`;
both directories were removed from this workspace on 2026-10-22.

## Upstream packages deliberately not carried over

The pi agent repository also publishes `pi-protocol`, `pi-client`, `pi-server`, and `pi-evals`. None
of them are part of TianGong. The nine live `packages/` directories in the summary table are the
whole workspace; the two removed packages stay in the table as history. Eight of the nine were
adopted from pi and rebranded; `packages/sec-guard` is the one package authored here, from
`docs/sec-guard-design.md`, with no upstream counterpart.

`packages/ai/test/codex-websocket-cached-probe.ts` references the upstream coding-agent's
`packages/coding-agent/src/core/model-runtime.ts`, which lived at
`packages/sec-agent/src/core/model-runtime.ts` and is preserved in
`scripts/legacy/sec-agent/src/core/model-runtime.ts`. It is a manual probe script, not part of any
suite, and is retained only as a record of upstream behaviour.