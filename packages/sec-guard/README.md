# @OnePanda-TgSec/tg-sec-guard

TianGong security guard: the four-level permission mode machine, the built-in hard deny, session
grants, and the attestation framework. The guard is a library that adapts to gibraltar's
`ToolHooks.beforeTool`; it owns no UI and asks no questions itself — the host injects the ask
channel, the scope resolver, and the danger evaluator.

## Modes

`strict` puts every tool call in front of a human; no intercept rule and no stored grant exempts it.
`judge-auto` delegates in-scope, non-dangerous calls to an injected judge, which has no deny power:
an ask from the judge is an ask to a human. `auto` and `yolo` walk the same chain — both allow what
no forced-ask layer escalates — and differ only in the declared operating posture; the danger set
still drops both to a human, so `yolo` is not unattended. The session mode persists in the
`tg.sec.mode` document and is hot-swappable through `switchMode`, which records a
`tg.span.sec.mode` audit span.

## Evaluation order

Every request enters the chain; nothing bypasses it. The first layer that produces a decision wins:

1. Built-in hard deny (loopback, local interfaces, `rm -rf /`, `mkfs`, `dd of=/dev/…`, fork bombs,
   power commands). Refused in every mode, no ask, no grant — the only terminal deny.
2. Intercept rules table, `deny` and `ask` effects. A rule `deny` is a **forced** ask: a human may
   approve the one call, but no grant and no mode exempts it. A rule `ask` is an ordinary ask.
3. Weak-evidence self-protection: a bare loopback or local-interface mention in command text forces
   an ask (a strong-evidence target is hard-denied in step 1).
4. Scope resolver: out of scope forces an ask that grants can never answer.
5. Danger evaluator: a hit forces the same kind of ask.
6. Mode dispatch: `strict` asks; `judge-auto` takes a matching rule `allow`, else the judge;
   `auto`/`yolo` take a matching rule `allow`, then a stored `always` grant, else allow. Grants are
   internal to the `auto`/`yolo` branch and never exempt `strict` or `judge-auto`.

A forced ask is immune to grants and to the mode. Without an ask channel, an ask blocks the call —
the guard fails closed. Construction fails closed too: no scope resolver, no danger evaluator, or
`judge-auto` without a judge all throw at `createTgSecGuard`.

## Attestation

`attest` runs eleven registered probes in order and throws on the first failure, so the host
refuses to start work on a failed attestation:

1. the confined execution environment refuses a forbidden read with `EACCES`
2. a scope-outside sample never resolves to allow
3. a danger-set hit forces its ask past a standing grant and `yolo`
4. the registered tools equal the declared track set
5. the mode document reads as one of the four modes
6. an unaffiliated (resumed, placement-free) call still enters the chain
7. a forced ask without an ask channel blocks
8. a rule `deny` forces an ask past grants and mode
9. `strict` ignores a matching rule `allow`
10. a judge transport error escalates to an ask
11. a judge that never answers converges to an ask inside its timeout

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
