# @OnePanda-TgSec/tg-sec-guard

TianGong security guard: the four-level permission mode machine, the built-in hard deny, session
grants, and the attestation framework. The guard is a library that adapts to gibraltar's
`ToolHooks.beforeTool`; it owns no UI and asks no questions itself — the host injects the ask
channel, the scope resolver, and the danger evaluator.

## Modes

`strict` puts every tool call in front of a human. `judge-auto` delegates in-scope non-dangerous
calls to an injected judge, which has no deny power: an ask from the judge is an ask to a human.
`auto` allows what the chain does not escalate. `yolo` allows everything the hard deny does not
refuse. The session mode persists in the `tg.sec.mode` document and is hot-swappable through
`switchMode`, which records a `tg.span.sec.mode` audit span.

## Evaluation order

Every request enters the chain; nothing bypasses it. The first layer that produces a decision wins:

1. Built-in hard deny (loopback, local interfaces, `rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs,
   power commands). Refused in every mode, no ask, no grant.
2. Scope resolver: out of scope forces an ask that grants can never answer.
3. Danger evaluator: a hit forces the same kind of ask.
4. Session grants: an `always` grant for the exact `tool:<name>` resource allows.
5. Mode dispatch.

A forced ask is immune to grants and to the mode. Without an ask channel, an ask blocks the call —
the guard fails closed. Construction fails closed too: no scope resolver, no danger evaluator, or
`judge-auto` without a judge all throw at `createTgSecGuard`.

## Attestation

`attest` runs the registered probes in order and throws on the first failure. Batch 0.5a ships
probes 1 (confined execution environment), 4 (registered tools equal the declared track set),
5 (the mode document reads as one of the four modes), and 7 (a forced ask without an ask channel
blocks). Probes 2, 3, and 6 are reserved for the batch that ships the scope resolver and the
danger regex set.

## Usage

```ts
import { createTgSecGuard } from "@OnePanda-TgSec/tg-sec-guard";

const guard = createTgSecGuard({
	mode: "auto",
	scopeResolver: (request) => ({ inScope: true }),
	dangerEvaluator: (request) => ({ hit: false }),
	askChannel: async (request, decision) => humanReply(request, decision),
});

const hooks: ToolHooks = { beforeTool: guard.beforeTool };
```
