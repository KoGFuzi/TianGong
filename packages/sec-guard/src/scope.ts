import { extractConnectionTargets } from "./command-text.ts";
import type { TgSecScopeRegistry } from "./scope-registry.ts";
import type { TgSecRequest, TgSecScopeResolver } from "./types.ts";

/**
 * Build the scope verdict for one request from the shared connection-target extraction: every
 * candidate must be permitted by the registry, and one refused fails the request.
 *
 * The registry answers with a verdict, not a bare boolean, so the reason a human reads distinguishes
 * the two refusals: **denied** (a deny entry matched — the over-boundary veto of 定调 2, which outranks
 * any allow entry for the same host) versus **unlisted** (no allow entry covers the host; with the
 * allow set empty that is every host, because scope registration is the only source of permission).
 *
 * **Both evidence tiers are compared** — a weak candidate is weaker proof that the string is a
 * target, not a licence to skip the registry check, so the scope gate is not relaxed by the tiering.
 * The tier rides along in the reason so a human reading the ask can weigh it.
 *
 * A request with no connection targets is in scope. That is deliberate, not an oversight: local
 * file operations and non-network tools have no host to check, and treating "no target" as
 * out-of-scope would force an ask on every read/write/edit call and hollow out the guard's
 * usable surface.
 *
 * The resolver consumes only `extractConnectionTargets` — never the raw command surface, never the
 * argument tree. That single-surface rule is asserted by `test/boundary.test.ts`, not left to
 * convention.
 */
export function createTgSecScopeResolver(registry: TgSecScopeRegistry): TgSecScopeResolver {
	return (request: TgSecRequest) => {
		for (const target of extractConnectionTargets(request)) {
			const verdict = registry.outcome(target.host);
			if (verdict.state === "allowed") continue;
			const named = `the connection target "${target.host}" (${target.evidence} evidence)`;
			if (verdict.state === "denied") {
				return {
					inScope: false,
					reason: `${named} is refused by the scope deny entry "${verdict.rule.pattern}" (${verdict.rule.kind})`,
				};
			}
			return {
				inScope: false,
				reason: `${named} is not in the registered scope: no allow entry covers it`,
			};
		}
		return { inScope: true };
	};
}
