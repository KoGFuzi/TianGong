# TianGong Development Rules

TianGong (天工) is an all-in-Bun monorepo under the `@OnePanda-TgSec` scope. This file is the
house standard: if a rule here and the code disagree, the code is wrong.

## The one-line model

Bun is the runtime, the package manager, the script runner, and the orchestration layer.
`tsc` is used only to emit `.d.ts` and JavaScript for publication; nothing else in the toolchain
needs Node. Vitest and `node:test` remain the test runners of record, because that is what the
suites already are.

```bash
bun install          # workspace install, hoisted node_modules, exact versions
bun run check        # house standard + formatting + types + relative imports
bun run build        # builds all 8 packages in dependency order
bun run test         # runs every package suite in dependency order
bun run clean        # removes dist/ and generated model data
```

`bun test` is **not** the runner. It is Bun's built-in runner and would bypass every per-package
Vitest/`node:test` config. Always go through `bun run test`.

Never hand-run `tsc`, `biome`, or `vitest` from a package root when a root script covers it.

## House standard

### Naming

| Concern | Value |
| --- | --- |
| Scope | `@OnePanda-TgSec` |
| Packages | `@OnePanda-TgSec/tg-ai`, `tg-agent-core`, `tg-gibraltar`, `tg-telemetry`, `tg-tui`, and `chord` |
| Root repo name | `tiangong` |
| Upstream repo | `https://github.com/KoGFuzi/TianGong` |
| Author field | `KoGFuzi` |
| License | MIT |
| Version line | one version shared by the root and all house packages (`scripts/version.ts`) |

Every identifier under a house package carries the `tg` identity. There is one spelling, not a set
of aliases:

| Kind of identifier | Form | Example |
| --- | --- | --- |
| Package name | `@OnePanda-TgSec/tg-*` | `@OnePanda-TgSec/tg-ai` |
| Persisted kind string | `tg.*` | `tg.user`, `tg.generation` |
| Telemetry span name | `tg.span.*` | `tg.span.provider.request` |
| Exported type | `Tg*` | `TgMessagesOptions` |
| Environment variable | `TG_*` | `TG_CACHE_RETENTION` |
| API id | `tg-*` | `tg-messages` |
| Product reference in prose | `TianGong` | `TianGong does not warm such caches` |
| User-Agent product token | `tg` | `tg (linux 6.1; x64)` |
| Config directory | `TianGong` under XDG | `~/.local/share/TianGong` (data), `~/.config/TianGong` (settings) |

`bun run check:house-standard` rejects anything else in house code. Four exemptions exist, each
recorded in that script with a reason:

1. **Radius**, a third-party gateway: `radius.pi.dev`, the `pi-gateway` OAuth client id, and the
   `x-pi-gateway-upstream-provider` header. Not ours to rename.
2. **`packages/tui/native/`**, the C/Objective-C addon, keeps `PI_NAPI_*` and `PI_CLIPBOARD_*`.
   `packages/tui/test/fixtures/*.c` compiles against `native/napi.h` and must use the same macros.
   Neither is reachable from TypeScript.
3. **`packages/tui/src/latex.ts`**, where bare `pi`, `alpha`, `sum` are LaTeX names, not identifiers.
4. **Upstream project references**: `earendil-works/pi` URLs and the phrase `pi agent`, plus
   `pi-mono` in released changelog history.

Markdown is not subject to the identifier rule. Prose has to be able to name what a rename replaced:
a changelog entry records the old identifier, and `docs/provenance.md` names upstream packages.
Code is enforced mechanically; documentation history is trusted.

`@OnePanda-TgSec/chord` has no `tg-` prefix. That is deliberate: the prefix marks packages we own end
to end, and `chord` was adopted whole. Renaming it later is a breaking change, so the exception is
recorded here instead of left to memory.

### Persisted identifiers are not compatibility shims

`tg.user`, `tg.assistant`, `tg.generation` and friends are strings written into transcripts, document
tables, and SQLite migrations. They were renamed from `pi.*` in one step with no alias and no
migration shim, because this workspace has no storage to be compatible with. If storage written by an
upstream release ever has to be read, rewrite the kind strings in place before opening it; do not add
a fallback reader.

### Vendored packages

`@earendil-works/pi-codemode` and `@earendil-works/pi-mcp` are migrated verbatim from the
[pi agent](https://github.com/earendil-works/pi) project and are **frozen**: manifest, source,
and public names stay as upstream published them. Do not reformat them, do not rename their
specifiers, do not fix their issues in place. House packages import them by their upstream names.
`packages/mcp/test/fixtures/*` and `packages/mcp/LICENSES/` additionally carry upstream license
text and must not be edited.

The full statement, including what each package does and why it was adopted, lives in
[`docs/provenance.md`](docs/provenance.md). `bun run check:house-standard` enforces the freeze
mechanically: vendored version, author, repository, and description are asserted on every run.

### Style

Tabs, width 3, line width 120, double quotes. Biome owns this; do not hand-format.

- Only erasable TypeScript syntax in anything the root `tsconfig.json` covers (`packages/*/src`,
  `packages/*/test`, `scripts`): no `enum`, `namespace`, parameter properties, `import =`,
  `export =`. Explicit fields with constructor assignments instead.
- `verbatimModuleSyntax` is on: `import type` for type-only imports.
- Every relative import carries its extension (`./foo.ts`). Node and Bun ESM both require it.
- No inline or dynamic imports. Top-level `import` only.
- No `any` unless there is no honest alternative; check the dependency's real types first.
- No emoji, no filler, in code, commits, issues, or review comments.

## Code quality

- Read a file in full before editing it. Search snippets are for locating code, not judging it.
- Never downgrade or delete code to silence a type error from a stale dependency. Upgrade the
  dependency.
- Never edit generated code by hand. `packages/ai/src/models.generated.ts` comes from
  `packages/ai/scripts/generate-models.ts`; `packages/ai/src/providers/data/` comes from
  `bun run generate:models`. Both are covered by `.gitignore` or by an ignore rule in `biome.json`.
- Ask before removing behaviour that looks intentional.
- No backward-compatibility shims unless asked for.

## Test-writing rules

**A test is a claim about an interface. If you did not read the interface, the claim is fiction.**
Every assertion in a test file must be justified by the real signature or the real returned value. This
rule exists because it was broken, and the breakage produced a test suite that "passed" while asserting
fields that did not exist.

### The violation, as a worked example

Writing `packages/gibraltar/test/sqlite-health.test.ts`, the test was written first and the
implementation was consulted afterwards. Four separate inventions came out of that, each caught only
because the test then failed:

| Invented | Reality, from `node:sqlite` |
| --- | --- |
| `PRAGMA integrity_check` returns `{ integrity }` | returns `{ integrity_check }` — the key is the pragma's own name |
| `PRAGMA busy_timeout` returns `{ busy_timeout }` | returns `{ timeout }` |
| `PRAGMA journal_mode` returns `"wal"` for a fresh file | returns `"memory"` for `:memory:`; `"wal"` only after the pragma is set on a file |
| `SqliteStorage.open(db)` has no `project` parameter | it takes one, and it is what makes isolation work |

A fifth invention, `health()` and `checkpoint()` methods that did not exist anywhere, was caught at
runtime with `storage.checkpoint is not a function`. A sixth, a `{ get(name) }` shape that no caller
actually produced, hid a real bug for three runs.

### The rules

1. **Probe before you assert.** If a test asserts on a value you have not seen, run the smallest
   possible probe first and print the result. `bun -e` with the real module is enough; it takes seconds
   and it is the only source of truth about `node:sqlite`, a third-party SDK, or a pragma's field names.
2. **Never write a test whose expectations you inferred from the name of the thing.** A method named
   `busyTimeoutMs` does not guarantee a pragma key of the same shape.
3. **Read the real signature in the source, not a summary of it.** A signature summary omits optional
   parameters and overload order, and those are exactly where the inventions came from.
4. **A test that fails is information, not an obstacle.** Do not fix the test to match an invented
   expectation by weakening the assertion. First ask whether the implementation or the expectation is
   wrong. Above, the implementation was wrong twice (`Bearer` scheme matching was case-sensitive, so
   RFC 7235 was violated) and the test was wrong four times. Decide each case on its own evidence.
5. **Do not invent an API to make a test writeable.** If a test needs an accessor that does not exist,
   add the accessor deliberately, with a doc comment, and note it in the changelog. Do not reach for
   `as never`, `as any`, or a `catch(() => {})` to silence the gap.
6. **Delete instrumentation before you commit.** `console.log` probes added to diagnose a failing test
   are scaffolding, not deliverables. Note that `vitest` here runs with `silent: "passed-only"`, so a
   probe's output is invisible in a passing run: instrumenting to observe, then trusting the same
   instrumentation afterwards, is how the invention survives.
7. **A green suite is not proof of correctness.** In the example above, the suite reached green twice
   while asserting non-existent fields. Only running the real module against the real runtime settled
   it. Green means the assertions held; it does not mean they were about the right thing.

`bun run check` and a passing `bun run test` are necessary, never sufficient. The rule that replaces
them: **assert only what you have observed.**

## Storage

`@OnePanda-TgSec/tg-gibraltar` persists to **SQLite only** in production. `MemoryStorage` is for tests.

```typescript
import { openDefaultSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";

const storage = await openDefaultSqliteStorage(); // ~/.local/share/TianGong/session.sqlite
```

- `openNodeSqliteStorage(path, { project })` names a file and scopes every row to one project.
- Every row carries `project_id`; every read is filtered by it. One file can hold several projects.
- Rows written before project isolation carry `"default"`, which is also the default value.
- `storage.health()` reads `integrity_check`, the schema version, and the connection pragmas back from
  the connection. `storage.checkpoint()` runs `wal_checkpoint(TRUNCATE)`.
- The append-only JSONL backend was removed. Two production file formats means two migration and
  recovery paths; only one was going to be tuned. Do not reintroduce a second file format without a
  written reason.

## V1 freeze

`v1` is the delivery branch and `v1.0.0` is its tag. The tree is frozen for non-bug-fix work.

**A change may land on `v1` only if it is a bug fix: code that is wrong, is broken, or fails a test.**
Everything else goes to a branch off the tag and is merged into a development branch, not into `v1`.

| Change | On `v1`? |
| --- | --- |
| A test fails, or a runtime error reproduces | Yes |
| A crash, data loss, or an integrity failure | Yes |
| A security defect in the auth path or the storage layer | Yes |
| Documentation that states something the code does not do | Yes |
| A refactor, a rename, a reformat | No |
| A new feature, even a small one | No |
| A new export, a new dependency, a new module | No |
| Tightening a type that currently compiles | No |
| A "while I am here" change | No |

Bug fixes on `v1` follow these rules:

1. **The fix is the smallest change that removes the defect.** No drive-by improvements.
2. **Every fix lands with a regression test** that fails before the fix and passes after it. The test
   justifies the fix; without it there is no way to tell a fix from a behaviour change.
3. **The persisted `tg.*` kind strings and the SQLite schema do not change on `v1`.** Both are written
   to storage. Renaming a kind or adding a migration is a breaking change, not a bug fix.
4. **`packages/codemode`, `packages/mcp`, and `packages/tui/native` do not change on `v1`** for any
   reason. The first two are vendored and frozen; the third is compiled by the platform toolchain.
5. **`packages/ai/src/models.generated.ts` changes only through regeneration**, never by hand.
6. **`docs/ops-manual.md` is updated in the same commit** when the fix changes any behaviour the manual
   describes. A manual that lags the code is worse than no manual.
7. **`bun run check` and `bun run test` must pass before the commit.** No exceptions for urgent fixes;
   that is when the shortcuts bite.

## Type programs

There are two, on purpose:

| Config | Covers | Types |
| --- | --- | --- |
| `tsconfig.json` | `packages/*/src`, `packages/*/test`, `packages/agent/examples`, `vitest.base.ts` | `node` |
| `tsconfig.scripts.json` | `scripts/**` | `node`, `bun` |

Bun's global `fetch` type conflicts with Node's `fetch` type, and the conflict breaks every `fetch`
mock in the test suites. Keeping the two programs separate is what avoids that. `bun run check:types`
runs both.

`packages/*/scripts/**` is in neither. Those are generation and maintenance tools that run under Bun
with type stripping; `tsconfig.base.json` `extends` them, so they still pick up the compiler options,
but they are not type-checked. `packages/ai/scripts/generate-models.ts` has loose internal types
upstream that would need real work to tighten, and it is not on the commit path.

## Boundaries

Dependency edges, verified by `packages/chord/test/boundary.test.ts` and by the root
`tsconfig.json` path map:

```text
              telemetry ──▶ ai ──▶ agent
                   ▲
chord ─────────────────────▶ gibraltar

codemode   mcp                     (vendored, no edges in or out)
```

`chord`, `tui`, `telemetry`, `codemode`, and `mcp` are leaves: they import nothing from this
workspace. That is what keeps `chord` publishable on its own.

Do not call `bun test`. Bun reserves that name for its own runner, which would silently bypass
every per-package Vitest and `node:test` configuration. Use `bun run test`.

## Testing

- `bun run test` runs every suite in dependency order. Name a package to narrow it:
  `bun run test packages/gibraltar`.
- Never run the whole vitest suite straight from a package root when endpoint or auth env vars
  are present: e2e tests activate on them and spend real tokens.
- Run a single suite from the package root:
  `bun run vitest --run test/specific.test.ts`, or for `packages/tui` (`node:test`),
  `bun run test -- test/specific.test.ts`.
- If you add or change a test, run it and iterate until it passes.
- `packages/gibraltar/test/**` must use the faux provider. No real provider APIs or paid tokens.
- Regression tests for a specific issue carry a comment with the issue number.
- Ad-hoc scripts go in a temp file, get run, then get deleted. Do not inline multi-line scripts
  in shell commands.

## Dependencies

- Treat `package.json` and `bun.lock` changes as reviewed code.
- Pin direct dependencies to exact versions. `bunfig.toml` enforces this with `exact = true`.
- Install with `bun install --ignore-scripts`; clean/CI-style installs likewise. Lifecycle scripts
  do not run unless asked.
- Regenerate `bun.lock` with `bun install` after any manifest change.

## Git

Several sessions may share this working directory.

- Stage explicit paths. Never `git add -A`, `git add .`, `git commit -a`.
- Commit only files changed in the current session. Run `git status` and verify before committing.
- Never run `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or
  `git commit --no-verify`.
- Commit message format: `{feat,fix,docs,refactor,chore}[(ai,tui,agent,gibraltar,chord,telemetry,mcp,codemode)]: <message>`.
- Never commit unless asked.

## Changelog

One `packages/*/CHANGELOG.md` per package. New entries go under `## [Unreleased]`, appended to
the existing subsection in this order: `### Breaking Changes`, `### Added`, `### Changed`,
`### Fixed`, `### Removed`. Released version sections are immutable.

Vendored packages are exempt: their changelog history is upstream's.

## Generated documentation note

`docs/provenance.md` records where each package came from. When a package is adopted, replaced,
or renamed, update that file in the same change, then re-run `bun run check:house-standard`.