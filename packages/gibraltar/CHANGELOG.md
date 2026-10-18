# Changelog

## [Unreleased]

### Breaking Changes

- `FileSystem` gains three required methods: `openBinaryReader(path, { noFollow? }, context)`, `openDirReader(path,
  context)`, and `watch(targets, onChange, context)`. A custom environment must implement them; `NodeExecutionEnv` does.
- `Shell.exec(command, ...)` accepts `string | readonly string[]`. An array runs `command[0]` directly with the rest as
  its arguments, without a shell, so they reach the program unparsed; a string still runs through the environment's
  shell. An empty array is a `spawn_error`.
- `ShellExecOptions.onOutput` is called with a third argument, `{ stream, skipped? }`. Existing two-argument callbacks
  keep working; a third parameter is now required at the call site the environment makes.
- `ShellExecOptions.window` is honoured by `NodeExecutionEnv`: output outside the retained tail may be omitted and
  reported through `info.skipped`.
- `TaskRuntime.context(conversationId, context, at?)` takes its cutoff as `options?: { at?: EntryId }` instead of a
  bare entry ID. Pass `{ at }`, or nothing for the whole conversation. The shape is the one that lets the next
  cutoff options arrive without another break.

- `ConversationQuery`, `EntryQuery`, `TaskQuery`, and `SubmissionQuery` take an optional `order: "ascending" |
  "descending"`, and a scan's cursor now carries the order it was created with: a scan given a cursor continues in
  that order, whether the query repeats it or omits it, and rejects a different `order` with a `TypeError`.
  Defaults are unchanged — conversations, tasks, and submissions ascending, entries newest first — so every
  existing call site behaves exactly as before, and a cursor written before this change (which carries only
  `after`) continues in its scan's default order. A `Storage` or `Tx` implementation must honour `order`; a
  query value outside the two orders, or a cursor whose `after` is not a safe integer, is a `TypeError`.
- `scanEntries` with `order: "ascending"` reads one conversation's visible history oldest first, walking the
  fork chain's segments from the root conversation forward, each capped at the next fork point, so a cursor
  narrows the lower bound the way a descending scan narrows the upper one. A missing ancestor still ends the
  visible history rather than throwing.
- A tool's `ToolExecutionResult.content` is renamed to `output`: every `execute()` returns the tool's output
  blocks there, consistent with `api.output()`. Custom tools return `{ output: [...] }` where they returned
  `{ content: [...] }`.
- A tool task's input and result carry a `kind`, and the `tg.tool` document version is 2 with a migration that
  treats a version 1 input or result without `kind` as a model-issued call. The input union holds both members:
  model-issued calls and the nested calls `executeTool()` makes.
- `AgentEvent.tool_execution_start` now carries the executing task as `taskId`. For a nested call, its start,
  update, and end events also carry `parentToolCallId` and `parentTaskId`. Channel implementations that match
  tool events field by field see the new members; matching on `type` alone is unaffected.
- A `bash`/`powershell` command that exits nonzero is an error result with an `exit_code` diagnostic that still
  carries the output, where it used to throw; a timeout or an interrupted start still throws.
- Tools resolve per caller: `ToolRegistration.callers` (default both) splits `agent.tools`, what the model is
  offered, from `agent.callable`, what `executeTool()` nested calls resolve among. A nested call of a
  `["model"]`-only tool is now `tool_unavailable`, and a `["tools"]`-only tool is no longer offered to the
  model. Every tool was callable by both before.
- The `read` tool returns a supported image (PNG, JPEG, GIF, WebP) as one image block, where it answered
  `unsupported_image` before. An image beyond the model's limits (`maxWidth`/`maxHeight`/`maxBytes`, defaults
  2000x2000 and 4.5 MiB) is still an error result, without decoding the whole file; a format providers do not
  take inline (BMP) is an error again unless `ReadToolOptions.images` supplies a processor that can convert it.
  A model without image input sees a placeholder, and `read` says so in its diagnostic.

### Added

- Structured tool output. `ToolRegistration.structuredOutputSchema` declares the contract of
  `ToolExecutionResult.structuredOutput`, which nesting tools (`executeTool()` callers) get validated, and the
  model never sees. Without a schema, callers get the result's bounded output as the model sees it: one text
  item as a string, one image as itself, otherwise the content list. A nested call whose `structuredOutput`
  breaks the contract settles as an error result with an `invalid_structured_output` diagnostic; a
  model-issued call only loses the value, and the break is reported to the host. A schema tool's error result
  without a value puts its text in a `tool_error` diagnostic for callers, not in `structuredOutput`.
  `ToolExecutionApi.retainedOutput()` returns the output the model will see, and `bash` and `powershell`
  return `{ output, truncated, fullOutputPath?, exitCode }` as theirs.
- `ToolRegistration.deferred` keeps a tool out of the model's request until `modelTools` names it, in its
  array or its `add`, which `control.addTools` writes; other tools can call a deferred tool any time.
  `Agent.callable` lists what nested calls resolve, `Agent.deferred` what `tool_search` loads, and
  `addTools` extends `modelTools` too.
- The `tool_search` extension, exported as `@OnePanda-TgSec/tg-gibraltar/tool-search`: the model searches
  its deferred tools with BM25 (`rankDocuments()`/`tokenize()` in `src/search.ts`) and loads the matches with
  `control.addTools`, so the next request offers them, per branch and in the baseline after a reset.
- The durable code mode extension, exported as `@OnePanda-TgSec/tg-gibraltar/codemode`:
  `createCodemodeExtension({ sandbox })` installs the `codemode` tool, which runs model-written JavaScript in a
  QuickJS sandbox whose script survives a restart. Scripts call the conversation's callable tools as nested calls
  (`await tools.<name>(args)`), each its own `tg.tool` task keyed `c<VM call id>` and reported in
  `tg.live.nestedTools`. Every delivered result is journaled (`tg.codemode.journal`) before the VM sees it, with
  the start data in `tg.codemode.run`, so a rerun replays the recorded results in order and reconnects the nested
  calls; a replay that diverges (another call, another order, a changed sandbox fingerprint or module version) or
  whose deadline passed ends the call with an error instead. The `codemode` prompt section lists the tools scripts
  can call as TypeScript declarations, grouped by namespace within a token budget (default 3000); deferred tools
  are left out and found with `searchTools()`/`describeTool()`/`describeNamespace()`. Results carry a header, the
  script's text items and console block, `max_output_tokens` truncation with the full text in a spill file, and
  images saved to temp files; a failed call rejects in the script, except a schema tool's error value and a
  `bash` nonzero exit, which resolve. `store()`/`load()` keep JSON values per conversation, forked as of the fork
  entry. `models.*` gives scripts the model catalog plus `models.classify()` and `models.generateImages()`, which
  run as hidden internal tools (`tg.codemode.models.*`), at most four at a time. The tool declares the Lark
  grammar (`CODEMODE_SOURCE_GRAMMAR`) for models that take syntax-constrained sampling, and lists its calls in
  `details.calls`.
- An input may be placed as its own entry: the input submission takes `entry?: InputEntry` (`{ kind, data }`),
  whose kind must be a non-empty string not starting with `tg.`. It is placed with its content as the user
  message, queued items carry it in `tg.inbox`, and a write of only `kind` and `data` from an untyped caller
  is stripped to those fields.
- `tg.live.compactionFailure` keeps the newest compaction failure (`taskId`, `reason`, `error`) until a
  compaction produces a summary; an aborted compaction or one that finds nothing to compact leaves it. Agent
  event snapshots carry `compactionFailure`, and `compaction_end` carries `error` when the compaction failed,
  faulted, or was orphaned.
- `ScanOrder` is exported. `scanTasks({ order: "descending" }, limit, cursor)` pages the newest tasks first;
  `Conversation.entries({ order })` forwards the order to `scanEntries`.
- The Session fails as one unit on the first failed Storage call: `SessionFailed` carries the first error as
  `cause`, every later call and wait rejects with it, running tasks are ended through their close (their
  spinner watches keep the session-close reason rather than their own cancellation), and what cannot be
  attributed becomes an `onReport` entry. Two kinds of Storage errors are exempt: an invalid request
  (`StorageRequestError`) and a read its caller cancelled fail only the call. A read corrupted mid-flight gets
  the guard's `SessionFailed` afterwards; nothing it read is used. A throwing internal commit listener fails
  the Session too, because it would leave memory behind storage.
- `errorMessage(error)` formats a thrown value safely, `StorageRequestError` marks an invalid Storage request,
  and `SessionFailed` marks a failed Session; all are exported. Previously `StorageRejected` marked a
  guaranteed no-effect rejection; every rejection is now unknown-effect and fails the Session with a plain
  `Error`.
- Every Session component reads its writes and reads through one closed-over Storage guard. Host transactions
  read through it as well, so an invalid request during a callback is visible to `#assertHealthy` afterwards.
- A display-only write (no `model`, `head`, or `edits`) is appended and settled `done` at once, busy or not,
  because it changes nothing the model sees; only behind a queued reset does it queue, so it lands after the
  reset and stays visible. `isDisplayOnly(entry)` and `hasQueuedReset(items)` are exported.
- `safeNow(now, report)` wraps the host clock: a throw is reported once (also if the handler rereads the
  clock) and the fallback `Date.now` is used, so a broken clock never fails a commit.- `Conversation.context(context, { at })` reads the context as of a visible entry: the same view `fork(at)` would
  start with, without creating a conversation. An entry not visible from the conversation throws.
- A task record carries `startedAt` (wall-clock milliseconds of the first change to `running`) and `endedAt` (the
  change to `terminal`). `startedAt` survives waits, recovery, and close and reopen, so the span between them includes
  the time the task was not running. Both are optional: a record written by an earlier version lacks them. Pass
  `HarnessOptions.now` to stamp them from a test clock; the default is `Date.now`. `createSession(storage, { now })`
  exposes the same clock to a Session opened directly.

- `openBinaryReader` returns a `BinaryReader`: positional reads of one opened regular file, its `info()`, and
  `scanLines({ startLine, endLine? })`, which locates a line range in one pass and reports the file's line count and
  the decoded byte sizes of the selection. The reader keeps reading the opened file after its path is replaced.
- `openDirReader` returns a `DirReader` that pages one directory's entries, so a very large directory is read without
  holding every entry at once. An entry that disappears between enumeration and its metadata is skipped.
- `watch(targets, onChange, context)` reports changes to files and directories: `paths` for what may have changed
  (a directory covers its subtree), `overflow` when coverage was uncertain, `error` when the watcher stopped. The
  returned `FileWatcher.mode` says whether it is `native` or `polling`. `NodeExecutionEnv` polls on Windows and on
  file systems that do not report remote changes; `watch: { mode, pollIntervalMs, maxDirectories }` in its
  constructor overrides that. Symbolic links are not followed below a recursive target, and `exclude: { hidden,
  names }` keeps entries out of both watching and reporting.
- `createPowerShellTool({ commandPrefix?, prepare?, programs? })` runs a PowerShell command as one argv entry, trying
  `pwsh` then `powershell` and skipping a program that cannot start. It is not part of `CodingTools`; add it
  explicitly. `createBashTool` and it now share one execution path, and both forward the retained output window to
  the environment and report what it skipped.
- `LineScanner`, `StreamDecoder`, `rangeDecoder`, and `startsWithBom` are exported from `./env` for environment
  implementations that stream or scan files the same way `NodeExecutionEnv` does.
- `registerEnvConformance(runner, name, withEnv, options?)` and `createEnvConformance(options)` run the
  environment-independent cases against any `ExecutionEnv`.
- `HarnessSettings.contextRetentionMs` (`Settings.contextRetentionMs`, default `600_000`): how long an idle
  conversation keeps its last context read in memory, so its next run reads only newer entries. A busy
  conversation always keeps it; `0` drops it as soon as the conversation is idle. The range is derived and never
  persisted, and a host whose `settings()` throws keeps nothing rather than failing the commit listener, the
  reconciliation, or the expiry timer that maintains it.

- `tg.provider`, a built-in conversation-scoped document holding the provider-facing `sessionId` of a
  conversation. The creation hook seeds it with a UUIDv7 before the first request, so every request of one
  conversation carries the same identity and providers that key prompt caches on it reuse the cache. A fork
  starts with a fresh identity instead of copying its parent's. A conversation that predates the document gets
  one migration commit before its next request.
- `ToolExecutionApi.models` and `HookApi.models` expose the `HarnessOptions.models` catalog, its credentials, and
  its request transforms, by reference, to tools and hooks. A tool that needs to list or resolve a model no longer
  has to close over its own copy.
- The `tg.tool-result` message records `durationMs`: the execution time of that attempt, measured with the
  monotonic `performance.now()` clock around `execute()`. A call that throws carries the time it spent, and
  a call that never reached `execute()` (invalid arguments, a blocked `beforeTool`, a tool the request did
  not offer) has no value. A rerun after recovery measures only itself.
- `projectUsage(storage, context)` sums every conversation's `tg.usage` ledger in the storage's
  project and returns `{ conversations, usage }`. The fold happens at read time on purpose: the
  per-conversation ledger stays the only write path, so no second ledger can drift from it. A storage
  instance is one project's view (`scanConversations` filters on its `project_id`), so the project is
  not a parameter. `conversations` counts only conversations that recorded spend, because
  `createConversation` materializes an empty ledger.
- `Storage.deleteConversation(id, context)` removes a conversation's rows in one transaction: its
  conversation record, entries, tasks, submissions, and conversation- and task-scoped document
  incarnations with their revisions. It returns a `ConversationDeletion` summary and appends the same
  event to the durable deletion audit. The reserved root conversation is rejected; IDs are never
  reclaimed, so recreating a deleted ID is rejected by `commit`. Callers own liveness: no live task may
  still write the conversation, and no Session may hold its documents loaded.
- `Storage.exportConversation(id, context)` serializes a conversation's own rows as JSONL lines read
  from one consistent snapshot: a header carrying the conversation record, then entry, task,
  submission, and document lines in ascending ID order. The payload covers exactly what
  `deleteConversation` removes, so export-before-delete loses nothing.
- `Storage.backup(path, context)` writes a consistent snapshot of the whole database file with SQLite
  `VACUUM INTO`, including committed WAL content and every project in the file. The target must not
  exist and parent directories are not created. `MemoryStorage` has no file backend and rejects with an
  unsupported-capability error, which keeps the package root free of Node imports.
- A tool makes a nested call with
  `api.executeTool(name, arguments?, context, options?: { key?, progress? })`. The call runs as its own tool
  task, a child of the calling task, with its own call ID (`<parentCallId>/<key>`, default-keyed by call order).
  Its hooks see the calling call as `parent`; its usage is recorded under the calling tool in the owner's
  `tg.usage` ledger; the caller gets the result as `NestedToolExecutionResult`, not the transcript: the result
  lives in a `tg.tool.nested-call` document of the calling task, which retires with it. A result key returns the
  already-made call (`MADE_NESTED_CALLS = "tg.tool.madeNestedCalls"` thrown otherwise); a key reused with
  another tool or other arguments is rejected. A caller returning leaves the nested calls it left running
  abort-marked, children before parents, with their details kept; a replay-safe caller reattaches to the calls
  its earlier invocation made.
- `NestedCallDoc` and `NestedCallState` are exported: the task-scoped document family (kind
  `tg.tool.nested-call`) a nested call's result is written into and its caller reads. `NestedToolSlot` and
  `NestedToolSummary` type the `tg.live.nestedTools` slots the live document lists, and `ToolHookCall` is the
  call tool hooks see, with `parent` for a nested call.
- `TaskOptions.abandonOnRestart` marks a task its creator awaits only in memory: when scheduling starts in a
  later Harness, such a live task, and the ordinary owned work below it, is abort-marked with reason `restart`
  before any of it runs again, and a task whose definition is not installed yet waits for it instead of
  becoming `orphaned`. A persisted record carries `abandonOnRestart` (immutable) and `abortReason` when the
  mark came from the abandonment rather than an abort request.
- `TaskRuntime.abortOwned(id, context)` aborts a task this task owns and resolves once it is terminal, and
  `TaskRuntime.ownedTasks(context)` lists the live tasks this task owns directly, in ID order, including an
  earlier invocation's.
- Image preparation. `src/tools/image.ts` gains `imageDimensions(bytes, mimeType)`, which reads a PNG, JPEG,
  GIF, or WebP header (animated apNG and VP8/VP8L/VP8X included) instead of decoding it, and
  `src/tools/image-processor.ts` exports `ImageLimits`, `DEFAULT_IMAGE_LIMITS` (2000x2000, 4.5 MiB), the
  `ImageProcessor` type, `PreparedImage`, `INLINE_IMAGE_TYPES`, and `toBase64`, which encodes standard base64
  in 8 KiB chunks so a 3 MiB image fits a small heap.
- `@OnePanda-TgSec/tg-gibraltar/images` and `@OnePanda-TgSec/tg-gibraltar/images/node`, a
  [Photon](https://github.com/silvia-odwyer/photon) (WebAssembly) image processor. `createPhotonImages(wasm)`
  takes a compiled module, as a worker host passes it; `createNodePhotonImages({ worker?, idleMs? })` runs it
  in a Node worker thread, exits after 30 seconds idle, and starts a new worker on the next image. The module
  is not loaded - and no worker is started - unless it is imported; `Image` decoding, EXIF orientation
  (`exifOrientation` in `src/images/exif.ts`), bytes and dimensions travel over the worker boundary as data.
- `createCodingTools(options)` and `createReadTool({ images })` pass an `ImageProcessor` to `read`, which
  then orients, resizes, and converts the images it finds so the model can take them, and names `bmp` in its
  description only when a processor can convert it.
- `FileSystem.listFiles(path, options?, context?)` returns a bounded, gitignore-aware depth-listed tree:
  `ListFilesOptions` takes `exclude`, `ignore` (additional pattern files), `maxEntries`, `maxBytes`,
  `maxDepth`, and `timeoutMs`, and `FileListing` reports `entries` (`FileListEntry`: `path`, `size?`),
  `ignoredBy`, `truncated`, and `aborted`. `listFiles` is optional on `FileSystem`; only environments that
  implement it need to answer conformance's `listFiles` option. `NodeExecutionEnv` implements it from the
  environment's directory walker with `gitignore` matching: `.git` is never listed, a deeper
  pattern file wins over a shallower one, a later rule in one file wins over an earlier one, a pattern with a
  `/` besides its trailing one is anchored, and the default global excludes file is `$XDG_CONFIG_HOME/git/ignore`.

### Changed

- A task's context reads are incremental: the view a task's first read derived is extended by the entries that
  arrived since, instead of rescanning the transcript. Entries at or below a read's tail are immutable, so the
  extension derives only what the new entries contribute; a new edit, a new head marker, or an earlier cutoff
  derives the range again. A read returns the same view as before, with its own arrays, and the kept range is
  frozen, so a provider or caller cannot rewrite what the next read extends. Over a 21-entry conversation a
  generation turn scans the transcript once and later turns scan only their own new entries, until
  `settings.contextRetentionMs` passes.
- `HarnessSettings.progress` makes the progress cadence configurable: `partialIntervalMs` (default 100 ms) is the
  pause between commits of the answer being generated, `outputIntervalMs` (default 100 ms) the pause between
  commits of running tool output. Each field falls back to its default on its own, so an explicitly `undefined`
  interval keeps the default. A commit also buys a pause proportional to what it wrote, at 100 KiB/s.
- `ToolExecutionApi.outputWindow` tells a tool the tail its output keeps and the pace its progress commits, for
  `ShellExecOptions.window`; it is `undefined` for a tool that keeps the head of its output, because head retention
  cannot accept skipped output. `ToolExecutionApi.output(chunk, skipped?)` counts output the environment omitted
  before the chunk, measured on the decoded text. `ShellOutputWindow`, `ShellOutputSkip`, and `ShellOutputInfo`
  describe both sides of that contract.
- SQLite schema version 3 adds `durable_metadata.deleted_conversations`, an append-only JSON array
  holding one audit event per `deleteConversation` (`{v, conversationId, projectId, deletedAt,
  counts}`). The migration is a single `ALTER TABLE` on `durable_metadata`; no data table changes.
  `health()` reports `schemaVersion: 3`, and a version-2 file upgrades in place when opened. The column
  never joins the commit path: `commit`'s metadata read keeps listing `next_id` and `next_seq`.
- Rebranded from `@earendil-works/pi-durable` to `@OnePanda-TgSec/tg-gibraltar`. The package was
  adopted from the [pi agent](https://github.com/earendil-works/pi) project; only the naming layer
  changed. No module was added, removed, or restructured, and the public API is unchanged.
- Cross-package imports now use `@OnePanda-TgSec/chord` and `@OnePanda-TgSec/tg-ai`.
- `repository.directory` corrected from `packages/durable` to `packages/gibraltar`.

### Changed: persisted identifiers

Entry kinds (`pi.user`, `pi.assistant`, `pi.system`, `pi.reset`, `pi.tool-result`, `pi.compaction`),
document kinds (`pi.agent`, `pi.live`, `pi.inbox`, `pi.usage`), and task kinds (`pi.generation`,
`pi.tool`) are now their `tg.*` equivalents.

These are persisted strings written into transcripts, document tables, and SQLite migrations. This is
a rename with no alias and no migration shim, because there is no existing storage to stay compatible
with. Storage written by an upstream `@earendil-works/pi-durable` release must have its kind strings
rewritten in place before it can be opened.

### Fixed

- A byte-order mark is dropped only where it is one. Node's streaming decoder with BOM handling drops any U+FEFF that
  follows a chunk boundary, so shell output and the text line reader could lose a character from the middle of a
  stream. Both now decode with BOM handling off and drop a leading mark themselves; the retained output tail behaves
  the same way, so a U+FEFF can no longer sit at the window's start.
- The tail an environment keeps no longer depends on progress commit timing. A progress snapshot used to replace the
  stored output with the already-bounded window, so the first line of a later window drifted with commit timing
  instead of with the output. Snapshots now keep the shortest suffix longer than the window by a byte or a line.
- `flushFile` on a directory reports `is_directory` on Windows, which opens a directory for writing where POSIX
  refuses.
- The `read` tool reads only the bounded range it shows: one `scanLines` pass locates the lines, then the selection and
  its first line are read. Its output is unchanged, including truncation diagnostics. A file that grew while it was
  read — an active log — no longer fails on the changed size; one that shrank or was rewritten in place is read again
  once, and a second change is reported instead of read as garbage.
- Design-document links in the README now point at the in-repo `docs/` files instead of upstream
  GitHub URLs.
  A run's input is committed before generation renders the system prompt, so a transcript, or the range
  after a compaction or reset, started with user messages followed by the system baseline. Providers
  treat only a leading system message as the initial prompt and tool set, so a later tool change
  rewrote the request's tool list and invalidated the whole prompt cache. User messages keep their
  relative order, and a system message that is not preceded only by user messages stays in place.
- Fork-history reads treat a missing ancestor conversation as the end of visible history instead of
  faulting. The ancestor walks asserted the parent row existed; deleting a fork parent would have made
  `scanEntries`, the two-argument `entry()`, and `findLatestHeadMarker` throw `TypeError` once the
  parent's rows were gone.
- Design-document links in the README now point at the in-repo `docs/` files instead of upstream
  GitHub URLs.
- A wait that closes a cycle through waits and held owners is rejected by `runtime.commit()`, naming the
  cycle, instead of leaving every task on it waiting forever; waiting on itself or on an owner chain were
  the only cycles caught. A background task may now wait on the owner of its conversation, which is no
  cycle (upstream pi #10411; tests and approach from #10533).
- The scheduler no longer visits every live task on each pass: abort cascades start only from tasks with
  cancellation intent, owned live work and idle scopes are walks down an in-memory ownership index, and
  reservation, finalization, and failFast checks keep their own candidate sets. A chain of 500 owned
  tasks that took 12 s to settle takes 50 ms, 20,000 take 1.5 s; a tool making 8000 parallel nested calls
  finishes in 2.7 s instead of 18.8 s, with one document per nested call instead of one growing index
  (`bun run bench:scheduler-fanout`).
- The scheduler's ownership indexes are bounded by live work: it keeps a conversation's owner and an
  ended task's ownership only while live work is below them, instead of every conversation and subagent
  chain it ever saw. Work that later appears in an old conversation loads its chain from storage again.
  After 10,000 ended subagent calls under a live parent it kept 10,000 ended tasks and 10,001 conversation
  edges; now none of either beyond the parent's conversation (`bun run bench:scheduler-memory`). A queued
  input no longer makes the scheduler scan every queued submission when nothing is being cancelled.
- The Session's document cache is bounded by use: a loaded document that no watch or document state
  observes leaves memory once it was not read or written for `documentRetentionMs` (new in
  `HarnessSettings` and `createSession()` options; default ten minutes, `0` drops it right after use) and
  loads from Storage again on its next access. It held every conversation and session document ever
  touched, built-in and third-party, for the life of the process: 5,000 conversations kept 26,000
  documents and about 3.8 KB each; with retention 0 they keep none (`bun run bench:document-cache`).

## [1.0.1] - 2026-10-03

## [1.0.0] - 2026-10-01

### Added

- Initial release of `@OnePanda-TgSec/tg-gibraltar`, a durable agent harness, adopted from
  `@earendil-works/pi-durable`. See the [README](README.md) and the
  [design document](docs/spec.md).