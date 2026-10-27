# Changelog

## [Unreleased]

### Changed

- The core extension's prompt sections now follow each conversation's `tg.sec.task-scope` instead
  of the assembly-time lane. The root renders the host lane's map; a forked child renders its stored
  role's map for its stored lane, read through `input.read`, and gibraltar's section diff patches
  only the keys that changed at fork. Children gain a `role` section (redteam execution, binary
  analysis, reporting forensic discipline with the rubric reference) and a role-specific tool
  surface; a `ctf` task's child inherits the hashcat/john dictionary guardrail and an `src` child
  inherits the business-change guardrail.
- `task` now selects a child policy by **role** (`redteam | binary | reporting`, default `redteam`)
  from the closed catalog in `role-policies.ts`, not by lane. `lane` is still accepted and still
  conditions guard/sections and the `tg.span.sec.fork` span, but it no longer chooses a policy.
  Each role fixes its extension list and an allowlisted tool surface in the child's `tg.agent`
  document at fork time; `binary` and `reporting` cannot enable `http_request` even by naming it in
  `modelTools`, and `reporting` is read-only (`read`, `tool_search`, `traffic_query`, `task`).
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
- `plan_update`, `terminal_declare`, and `task` are callable by programs through `executeTool`
  (`callers: ["model", "tools"]`), so orchestration code and code mode can drive delegation and the
  campaign control plane. The delegation depth gate, role policies, and host-side terminal
  validation remain the authority; broadening the caller set does not widen the model's tool surface.

### Fixed

- A `--faux` shell no longer writes its echo turns into the campaign conversation, and choosing an
  authenticated model over a context that still carries faux assistant turns starts a clean
  context. Previously the test turns survived in `projects/<project>/session.sqlite`, so a correctly
  configured real provider continued the faux persona from the transcript and looked as if the
  TUI configuration had not taken effect. Faux runs now use
  `<data>/faux/projects/<project>/session.sqlite`; `/connect` from a faux session also selects the
  provider's first chat model instead of keeping the echo model selected.

### Added

- `tg-sec serve` now routes guard escalations to the WebUI instead of the terminal.
  `createApprovalAskChannel` adapts the guard's ask channel onto the sidecar's shared
  `SecApprovalQueue`; the browser answers `allow`/`deny`/`always`, and sec-guard's own semantics
  (a forced ask accepts one call only, a banked grant covers the exact resource) are unchanged.
  Shutdown closes the queue, so a tool call parked on an operator fails closed while the agent
  unwinds.
- Delegation is a single hop: the fork writes the child's role, lane and depth into the
  conversation-scoped `tg.sec.task-scope` document, and a `task` call from any conversation below
  the root fails closed. The rejection records a `tg.span.sec.fork` span with
  `outcome: "depth-rejected"`, so a nested attempt is auditable rather than silent.
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
- `tg-sec serve`: the batch-6 WebUI sidecar (`@OnePanda-TgSec/tg-sec-server`) hosted on the same
  campaign runtime. It subscribes to `watchEvents`, projects the action tree and evidence subjects
  onto the StrikeAgent-isomorphic graph contract (9 node kinds, 5 relations with `weight` and
  `on_rce_path`, intents/findings/steering/memory/events), serves a self-written SVG UI, and accepts
  steering over HTTP or WebSocket. The one-time ticket URL is printed at startup; the entry path is
  persisted at `<data>/sec-server/sec-server-entry` (0600), tickets expire in five minutes and are
  single-use, and the session cookie is scoped to the entry path. `TgSecEvidenceStore.listSubjects()`
  enumerates finding subjects for the projection without reading blob bodies. The sidecar depends
  only on chord and gibraltar; sec-agent injects the projection and steer functions, so there is no
  reverse import.
- MCP tool bridge (`src/mcp/`): host-configured MCP servers (stdio or Streamable HTTP) are translated
  into gibraltar `defineTool` registrations named `mcp__<server>__<tool>` — `deferred`, callable by
  both the model and programs, and therefore subject to the same `beforeTool` guard chain as every
  other tool; the bridge opens no separate permission surface. Role narrowing happens at assembly
  time: one extension per role (`sec-mcp-<role>`), and `secRolePoliciesWithMcp` composes each role's
  static policy with that extension and its tool names. A malformed config entry or a server that
  fails to connect or list tools is reported in `errors` and never disables the remaining servers.
- `openSecMcpHost` loads `--config` / `TG_SEC_MCP_CONFIG` / `<cwd>/.tiangong/mcp.json`, opens the
  bridge, and returns the extensions, composed policies, `declaredTools`, a flow fetcher and a close
  seam. The `tgsec` shell, `tg-sec serve` and the TUI hang the bridge's cleanup on
  `openSecAgent`'s `onClose`.
- `evidence_capture` accepts a `flowId` in place of caller-held bytes: the bridge's
  `fetch_http_packet_by_id` adapter resolves the flow to request/response bytes, which enter the
  existing content-addressed blob pipeline, and the snapshot records the flow id in metadata and in
  the id preimage. Metadata addition only: rows written before this change stay readable, and their
  ids are byte-identical because an empty flow id leaves the v1 preimage untouched.
- Long-lived MCP resources: a successful call to a server's configured `lifecycle.startTools` is
  recorded, and bridge `close()` calls `stopTool` once per recorded start in reverse order before
  closing every client. Close is idempotent, so a second teardown neither stops twice nor errors.
  `test/sec-mcp-host.test.ts` proves the campaign close seam stops a listener that an aborted
  session had started.
- Faux MCP acceptance coverage over `createInMemoryTransportPair`
  (`test/mcp-stub.ts`, `sec-mcp-bridge.test.ts`, `sec-mcp-guard.test.ts`): registration, role
  split, flow capture, lifecycle cleanup, config faults, name sanitization, and the guard's
  scope/danger/probe-4 behavior on MCP tools. No real yak/mitan instance is connected and no
  provider tokens are spent.
- Findings share the evidence index: `tg_sec_findings` stores the campaign's verdict (`lane`,
  `title`, rubric severity, lifecycle status, subject, retest snapshot) beside the snapshots, and a
  finding write takes the same `tg_sec_evidence_versions` optimistic lock as `bind`/`edit`.
  `finding_update` creates a finding `open` and advances it; `retest-pass`/`retest-fail` require a
  snapshot bound to the subject that differs from the previous retest, so a retest cannot be
  asserted without new evidence.
- `tg.sec.report` is a session-scoped document family. `report_generate` renders the registered
  findings deterministically (severity order, then id) with each finding's snapshot ids, stores the
  revision and body, and returns only metadata to the transcript; the same findings produce the same
  bytes and digest. No evidence body or timestamp enters the body.
- The WebUI projection reads findings: `SecProjectionInput.findings` maps the five lifecycle states
  onto the existing `pending|verified|rejected|excluded` vocabulary and the rubric severity onto the
  node/finding severity, with no wire-contract change. An evidence subject without a finding row
  keeps the previous unrated projection.
- Batch-9 acceptance tests (`test/finding-loop.test.ts`) cover the open → verified → retest-pass
  lifecycle with audit spans, retest-without-fresh-evidence rejection, rubric-external severity
  rejection, deterministic report bytes, and the report document revision.
- Campaign plan as documents: `tg.sec.plan` is an immutable session family keyed by decimal
  revision, and `tg.sec.plan-head` is the session singleton that numbers the next revision in the
  same commit, so every revision stays enumerable and replayable. `plan_update` (deferred) replaces
  the whole ordered step list, normalizes blank step ids and duplicates, and returns the new
  revision and open-step count; `listPlan`/`latestPlan` read the revisions back in ascending order.
  The root prompt gains a `plan` section, and the WebUI projects the newest revision as intents.
- Structured delegation findings: `tg.sec.task-findings` is a conversation-keyed session family.
  `evidence_capture`, `http_request`, and `finding_update` register each finding id they touch, and
  `task` reads the child's list when it settles and adds `findings: string[]` to its structured
  output. The list comes from the document, not the child's summary text, and matches the evidence
  index.
- Lane terminal declarations: `tg.sec.terminal` stores one record per `${lane}:${claim}`. The
  deferred `terminal_declare` tool accepts only the lane's claim (`getshell` for redteam,
  `getflag` for ctf, `high_critical_finding` for src) and lets the host decide: a finding claim
  needs an existing high/critical finding in `verified` or `retest-pass`, `getshell` also needs a
  snapshot bound to that finding, and a CTF flag is checked against the host's `verifyFlag` source.
  A failed check is persisted as `unverified`; no declaration changes a finding's status. The raw
  flag is never stored. The root prompt gains a per-lane `terminal` section.

### Changed

- `secDeclaredTools(lane)` now includes `http_request`, `evidence_capture` and `traffic_query`. Attestation probe 4 is
  a strict set equality (registered tools == declared tools, so a missing **or** an extra name fails closed); a campaign
  that registers the forensic surface must declare it, and `guard-wiring.test.ts` and the `tg-sec` smoke CLI install the
  `sec-tools` extension to keep the two sets aligned.
- `secDeclaredTools(lane, extraTools)` accepts the host's MCP tool names, so probe 4's declared set
  is derived from the same MCP configuration that produced the registrations: adding or removing a
  server moves both sides together instead of turning the probe red for a configuration change.
- `test/boundary.test.ts` now asserts `@earendil-works/pi-mcp` as the second vendored edge at the
  frozen caret range; the MCP bridge is what makes the dependency real rather than declared-only.
- The evidence schema gains a `flow_id` column. An existing `evidence.sqlite` gets it through an
  in-place `ALTER TABLE ... ADD COLUMN flow_id TEXT NOT NULL DEFAULT ''`, so no separate migration
  step is required.
- The forensic surface gains `finding_update` and `report_generate`; `secDeclaredTools`, the lane
  filter and the role policies now name them (`redteam`/`binary` get `finding_update`, `reporting`
  gets `report_generate` alongside its read-only traffic surface).
- The rubric section derives its four names and order from `finding-vocabulary.ts`, the same source
  the evidence store validates against, so prompt text and write validation cannot drift.
