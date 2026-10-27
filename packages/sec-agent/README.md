# @OnePanda-TgSec/tg-sec-agent

Security agent runtime for 政务红蓝/公安对抗赛 scenarios, built entirely on the tg-gibraltar harness:
the agentic loop, persistence, forks, and the event stream are gibraltar-native. The package adds the
campaign bootstrap (real SQLite storage, one project per campaign, `resume()` at startup), the
`tg.sec.action-tree` document family that makes forked child conversations enumerable and attributable,
the foreground `task` delegation tool, and the wiring that puts every tool call through
tg-sec-guard's `beforeTool` policy chain.

Production persistence is SQLite only; `MemoryStorage` never appears on a production path. Session
state lives under the XDG data directory (`~/.local/share/TianGong/sec-agent`, override with
`TG_SEC_DATA_DIR`).

```ts
import { openSecAgent } from "@OnePanda-TgSec/tg-sec-agent";

const agent = await openSecAgent({ project: "campaign-2026-10", models, askChannel });
```

Provider credential bootstrap is shared: `tg-sec login [provider]` (and `tgsec login [provider]`, or
`/connect` inside the shell) runs the provider's login flow and writes `auth.json` through
`FileCredentialStore`, and `tg-sec list` lists the OAuth-capable providers. The smoke command opens
a campaign, runs one turn through the guard, and prints the event stream; see `tg-sec --help` for
its flags.

`tgsec` is the interactive shell over the same runtime: an alt-screen transcript driven by the
agent event stream, a status bar for the project, lane, guard mode, model and token totals, and an
editor with slash commands (`/help`, `/connect`, `/models`, `/model`, `/mode`, `/scope`, `/clear`,
`/compact`, `/usage`, `/quit`). It opens without any provider configured: the status bar reads
`no model`, sending a message prints the `/connect` hint, and nothing reaches a provider until a
model is picked. `/connect` offers the providers that support interactive login (OAuth or API key)
and runs the provider's flow in place, showing auth URLs, device codes and prompts; secret prompts
are masked. `/models` (and `/model` with no argument) opens a fuzzy-searchable picker of
authenticated models, `/models <query>` prefills the search, and `/model <provider/modelId>`
remains the direct switch. After a successful login the catalog is refreshed and, if the shell
still has no model, the provider's first chat model is selected automatically. Guard asks appear
above the editor and are answered with `y` (once), `n` (deny) or `a` (always); closing the shell
denies whatever is still pending. The model resolves from `--model`, then `TG_SEC_MODEL`, then the
remembered choice in `<data>/tui-model.json`, then the first authenticated model; a choice made
inside the shell is remembered. `tgsec login [provider]` and `tgsec models` share the credential
store with `tg-sec`.

```bash
tgsec --project demo --lane redteam     # real provider conversation
tgsec --faux                            # local echo model, no credentials or egress
```

`--faux` answers from the last user message and treats a message beginning with `run ` as a real
`bash` tool call through the guard, which makes the shell (and the ask prompt under `strict`) usable
without an account. A faux session writes to its own `<data>/faux/projects/<project>/session.sqlite`,
never to the campaign database; choosing a real model over a context that still carries faux turns
starts a clean context, because a real model would otherwise continue the echo persona it finds in
the transcript. Connection targets are scoped by `--scope <file>` or the per-project
`<data>/projects/<project>/scope.json`; a missing file leaves the registry empty, so every target
is a forced ask.

`tgsec --webui` starts the campaign WebUI sidecar on the same runtime (the flagless `tgsec`
opens the interactive shell instead):

```bash
tgsec --webui --project demo --lane redteam
tgsec --webui --faux --project demo
```

It prints a `webui` URL and a single-use `login` URL. The login ticket expires after five minutes;
redeeming it sets an `HttpOnly; SameSite=Strict` cookie scoped to a persisted random entry path
(`<data>/sec-server/sec-server-entry`, mode 0600). The page is a self-written SVG graph of the
campaign with findings, intents and the event feed, and the composer steers the running conversation
over the same event stream the TUI consumes. The server binds `127.0.0.1` by default, validates the
Host and Origin headers, and never sends evidence bodies to the browser.

Design and batch acceptance live in `docs/sec-agent-design.md`; the permission model lives in
`docs/sec-guard-design.md`.
