import { extractConnectionTargets } from "./command-text.ts";
import type { TgSecRequest, TgSecScopeResolver } from "./types.ts";

/**
 * The registered set of hosts a campaign may talk to. This batch needs the minimal shape only —
 * a containment decision on one extracted host string. The registry matching engine (exact/fuzzy/
 * CIDR kinds, deny-over-allow precedence, persistence and loading) is batch 1c and implements this
 * same interface; nothing about it is stubbed here.
 */
export interface TgSecScopeRegistry {
	contains(host: string): boolean;
}

/**
 * The minimal in-memory registry: an exact set of hostnames and IP literals, case-insensitive.
 * Enough for this batch's resolver and tests; it deliberately has no suffix or wildcard matching.
 */
export function createInMemoryScopeRegistry(hosts: readonly string[]): TgSecScopeRegistry {
	const registered = new Set(hosts.map((host) => host.toLowerCase()));
	return {
		contains: (host: string): boolean => registered.has(host.toLowerCase()),
	};
}

/**
 * Build the scope verdict for one request from the shared connection-target extraction: every
 * candidate must be in the registry, and one outside fails the request.
 *
 * A request with no connection targets is in scope. That is deliberate, not an oversight: local
 * file operations and non-network tools have no host to check, and treating "no target" as
 * out-of-scope would force an ask on every read/write/edit call and hollow out the guard's
 * usable surface.
 */
export function createTgSecScopeResolver(registry: TgSecScopeRegistry): TgSecScopeResolver {
	return (request: TgSecRequest) => {
		for (const host of extractConnectionTargets(request)) {
			if (!registry.contains(host)) {
				return { inScope: false, reason: `the connection target "${host}" is not in the registered scope` };
			}
		}
		return { inScope: true };
	};
}
