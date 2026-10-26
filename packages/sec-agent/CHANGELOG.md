# Changelog

## [Unreleased]

### Changed

- Windows compatibility, without touching the POSIX durability contract: the evidence blob
  writer skips the **directory** fsync on `win32` (Windows refuses to open a directory for fsync
  with EPERM); the blob file's own fsync and the staging→rename sequence are unchanged. Probe 1's
  forbidden read targets the volume's ACL-protected `System Volume Information` **directory** on
  `win32` — a file inside it reports `ENOENT` there, while opening the directory raises the OS
  refusal — and `probeRestrictedEnv` accepts that refusal as `EPERM` alongside `EACCES`. Evidence
  GC derives a blob's name with `basename()`; the previous `lastIndexOf("/")` was a no-op on
  Windows paths and reaped every blob, including those a bound snapshot still referenced. Test
  support closes tracked evidence stores before sweeping temp directories (Windows refuses to
  unlink a SQLite file while its handle is open), retries the sweep, and skips POSIX mode
  assertions on `win32`.
- `tgsec` no longer requires an authenticated provider at startup. When neither `--model`,
  `TG_SEC_MODEL`, nor an authenticated provider yields a model, the shell opens with `no model`,
  refuses to send a message (printing the `/connect` hint), and reconciles the stored root
  conversation's model on restart so a stale choice cannot run silently. `/model` with no argument
  now opens the model picker instead of printing a list.
- The `judge-auto` judge reads its model ref at judgement time, so a model switched inside the
  shell also becomes the judge model.

### Added

- `tg-sec login [provider]` and `tg-sec list` now own the OAuth credential bootstrap that used to be
  published as the `tg-ai` bin. They resolve the same `builtinProviders()` OAuth providers and write
  the same `auth.json` through `FileCredentialStore`; the smoke turn's flags are unchanged.
- New house package `@OnePanda-TgSec/tg-sec-agent`, built gibraltar-native per
  `docs/sec-agent-design.md` 批3: campaign bootstrap over `openNodeSqliteStorage` with one
  project per campaign, `harness.root` + `resume()` at startup, the `tg.sec.action-tree`
  document family for enumerable and attributable forked child conversations, the
  foreground `task` delegation tool with a static child capability set, sec-guard
  `beforeTool` wiring with ask channels and a tg-ai judge transport, hardened event
  observation (per-listener isolation and snapshot-fold handling), lane system-prompt
  sections, and a minimal `tg-sec` smoke CLI.
- Fail-closed attestation runs inside the core extension's first real `beforeTool`, not in
  `openSecAgent`: the guard's own probe set needs a genuine `HookApi` (a real `taskId`, `memo` and
  session-document read have no honest value at construction time), so it fires the first time
  gibraltar hands one over, and a failed probe blocks that tool call. `openSecAgent` itself never
  attests. See `docs/sec-agent-design.md` 批3 落地勘误 item 4.
- The `@OnePanda-TgSec/tg-sec-agent` name and `packages/sec-agent` directory are reused from the
  adopted-and-removed `pi-coding-agent` package (removed 2026-10-22, snapshot in
  `scripts/legacy/sec-agent`); this is a gibraltar-native rewrite, not that package's module layout.
  Its true dependency edge set is `chord`, `tg-ai`, `tg-gibraltar`, `tg-sec-guard`, `tg-telemetry`
  plus the vendored `@earendil-works/pi-codemode` sandbox — it does not depend on `tg-env`, asserted
  mechanically in `test/boundary.test.ts`.
- Content-addressed evidence store (`src/evidence/`), per `docs/sec-agent-design.md` 批4: `openTgSecEvidenceStore`
  persists a campaign's forensic evidence to its **own SQLite index** at `projects/<safe>/evidence/evidence.sqlite`
  with bodies in `blobs/<hash[0:2]>/<hash>.bin` — all separate from `session.sqlite`, so transcript and evidence
  have independent lifetimes, backups, and GC. `record` writes request and response as two independent blobs
  (staging → hash-while-writing → length gate → optional hash gate → fsync → rename → parent-dir fsync) and inserts
  a snapshot whose id is verified on write and again on read-back; `bind`/`list`/`edit` maintain per-subject
  `evidence_version` optimistic locking (`null` version appends unconditionally, a stale version raises
  `TgSecEvidenceConflictError`, an existing binding's role/note are never overwritten); `collect` runs the
  mark-then-grace GC (24h, timing off file mtime) over both the index and the blob/staging trees; `readBody`
  verifies before opening. The write path replaces ARTEX's PostgreSQL advisory lock + `SELECT FOR UPDATE` with
  gibraltar's `NodeSqliteDatabase.transaction()` — `BEGIN IMMEDIATE` plus the connection busy-timeout plus the
  in-process serial queue — so no new dependency is added.
- The evidence layer stores **no JSON**. ARTEX hashes a canonical-JSON preimage to get deterministic snapshot
  bytes; the id preimage here is instead a fixed-order, length-delimited byte encoding (`src/evidence/hashing.ts`):
  a domain tag, a `uint32` byte-length prefix on every variable-length string, and fixed big-endian widths for the
  numeric and 32-byte-hash fields, with the id and creation time excluded by construction. The length prefixes make
  the concatenation unambiguous, so field content cannot forge a boundary between two fields, and field order is
  part of the id. Snapshot metadata is columnar in SQLite and bodies are raw filesystem blobs — neither is JSON.
  No Redis backend is provisioned this batch.
- Batch-4 audit span emission: the `task` delegation tool opens one `tg.span.sec.fork` per delegation
  (`lane`/`outcome`/`depth`, never the intent text) and the evidence store opens one `tg.span.sec.evidence` per
  operation, both through `createTypedSpanStarter` against the closed `TG_SPAN_SCHEMA` vocabulary. A
  `TelemetryContext` now threads from the host through `createSecCoreExtension` into the task tool; when absent it
  is the no-op context, so existing behavior is unchanged. `depth` is 1 this batch (the batch-3 foreground path is
  a single hop and `ToolExecutionApi` exposes no session depth). Scope-registry-change spans are deferred to 批5 —
  the scope registry is build-once read-only with no mutation call site, so no seam is built for a consumer that
  does not exist yet.
- Sec forensic tool surface (`src/tools/`), the first coherent slice of `docs/sec-agent-design.md` 批5: three tools
  bundled as one host-installable `sec-tools` extension (`createSecToolsExtension`) alongside `sec-core`. All three
  are `deferred`, so none is offered to the model until `tool_search` names it, yet each is nested-`executeTool`
  reachable and every one passes `sec-core`'s `beforeTool` the moment it enters the registry — no extra wiring.
  `http_request` puts bytes on the wire only through the injected `RequestExecutor` seam (`nodeRequestExecutor` uses
  `node:http`/`node:https` and **deliberately does not follow redirects**, so a `3xx` that would bounce out of scope
  stays the caller's decision, never a silent transport hop); its `{url}` host is scope-enforced for free because the
  guard's `extractConnectionTargets` reads the whole `arguments` tree and `url` is a declared-target key — **no
  sec-guard change was needed**. The captured exchange lands as two content-addressed blobs plus a snapshot, optionally
  bound to a `findingId`; the bodies never reach the transcript, only the snapshot id and byte counts.
  `evidence_capture` freezes caller-held bytes (a bash pipeline, a file, a manual PoC output) into a snapshot and binds
  them under the store's optimistic lock; `traffic_query` lists a finding's snapshots with their metadata or reads one
  body back to the calling program (base64, never smeared into the transcript). `src/evidence/store.ts` gains a
  read-only `getSnapshot(id)` accessor, emitting the existing `tg.span.sec.evidence` `read` op — batch 5-A introduces
  **no new span name**.
- Findings subject contract: evidence binds by `findingId`, a string subject key — the first real consumer of batch 4's
  generalized `subjectId`. The findings/report tables and their versioning are batch 6; this batch establishes only the
  contract that **subject = findingId**.
- Lane tool surface: `sections.ts` gains a per-lane `tools` prompt section (the deferred surface plus forensic
  discipline, with redteam/ctf/src variants) and `secLaneToolFilter(lane)` as the lane→surface contract. Every lane
  surfaces the full forensic triad in this batch — the gate is the tools' `deferred` flag, not the list — and a host
  narrows a lane through `configure`'s `modelTools.remove`/`tools`. `secLaneSections` now returns
  `{ preamble, lane, tools, rubric }`.
- The MCP bridge is **deferred**: no `@earendil-works/pi-mcp` dependency edge is added, because that edge would violate
  `test/boundary.test.ts` and the AGENTS vendored-leaf rule; the bridge and its boundary change-order land together in a
  later batch.
- `tgsec` and `src/tui/`: the interactive shell over the same campaign runtime. An alt-screen transcript consumes the
  `watchSecEvents` stream (snapshot rebuild, streamed assistant text, tool cards with bounded output previews), a status
  bar tracks project/lane/mode/model/tokens, and the editor drives slash commands (`/help`, `/model`, `/mode`, `/scope`,
  `/clear`, `/compact`, `/usage`, `/quit`). Guard asks are queued and shown above the editor; `y`/`n`/`a` settle the
  oldest, ctrl+c denies the queue, and shutdown denies everything still pending, so a disappearing operator never
  leaves a call allowed. `--faux` runs a local echo provider whose `run <command>` messages call the real `bash` tool
  through the guard, so the shell and the ask path work without credentials or egress. Model resolution is `--model`,
  then `TG_SEC_MODEL`, then the remembered `<data>/tui-model.json`, then the first authenticated model; `/model`
  validates and persists the choice. The scope file is `--scope` or the per-project
  `<data>/projects/<project>/scope.json`; a missing file leaves the registry empty and every connection target is a
  forced ask. This adds the `tg-tui` house edge (`tg-sec-agent` renders through it; tui does not depend on sec-agent),
  and `test/boundary.test.ts` now asserts six house dependencies.
- Tests for the shell's two safety-relevant seams: `test/tui-model.test.ts` covers spec parsing, preference
  round-trip/corruption, and the resolution order (including fail-fast on an explicit unavailable spec);
  `test/tui-ask.test.ts` covers FIFO settlement, deny-all, and close denying both pending and future asks.
- `tgsec /connect`: an in-shell provider login for every provider whose OAuth or API-key method supports
  interactive login. It renders auth URLs, device codes and prompts in a dialog, masks secret input,
  answers the provider's select prompts through the fuzzy picker, cancels with Esc/ctrl+c, refreshes the
  provider catalog after a successful login, and auto-selects the provider's first chat model when the
  shell still has none. The stable device id lives at `<data>/device-id`.
- `tgsec /models` (and `/model` with no argument): a fuzzy-searchable model picker with the current
  model marked; `/models <query>` prefills the search.
- The `Input` component in `tg-tui` gained `secret: true`, rendering one `*` per character while
  `getValue()` still returns the real text; the login dialog uses it for API keys and codes.

### Changed

- `secDeclaredTools(lane)` now includes `http_request`, `evidence_capture` and `traffic_query`. Attestation probe 4 is
  a strict set equality (registered tools == declared tools, so a missing **or** an extra name fails closed); a campaign
  that registers the forensic surface must declare it, and `guard-wiring.test.ts` and the `tg-sec` smoke CLI install the
  `sec-tools` extension to keep the two sets aligned.
