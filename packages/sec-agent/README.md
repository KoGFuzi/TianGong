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

A minimal smoke CLI (`tg-sec`) opens a campaign, runs one turn through the guard, and prints the
event stream.

Design and batch acceptance live in `docs/sec-agent-design.md`; the permission model lives in
`docs/sec-guard-design.md`.
