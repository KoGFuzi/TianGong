import { Effect } from "effect";
import type { ApiKeyAuth, OAuthAuth } from "./types.ts";

/**
 * Standard api-key auth: a stored credential key wins, otherwise the first
 * set env var resolves. Includes a `login` that prompts for the key.
 * Providers with non-standard resolution (provider env, ambient files, IAM)
 * write their own `ApiKeyAuth`.
 */
export function envApiKeyAuth(name: string, envVars: readonly string[]): ApiKeyAuth {
	return {
		name,
		login: async (interaction) => {
			interaction.signal.throwIfAborted();
			const key = await interaction.prompt({ type: "secret", message: `Enter ${name}` });
			interaction.signal.throwIfAborted();
			return { type: "api_key", key };
		},
		resolve: async ({ ctx, credential, signal }) => {
			signal.throwIfAborted();
			if (credential?.key) {
				return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
			}
			for (const envVar of envVars) {
				const value = await ctx.env(envVar);
				signal.throwIfAborted();
				if (value) return { auth: { apiKey: value }, source: envVar };
			}
			return undefined;
		},
	};
}

/**
 * Wraps a dynamically imported `OAuthAuth` so provider definitions can
 * advertise OAuth without importing the implementation. The flow loads on
 * first `login`/`refresh`/`toAuth` call; callers keep Node-only flow code out
 * of bundles by loading through a bundler-opaque dynamic import (variable
 * specifier, see the bedrock lazy wrapper).
 *
 * The module is loaded lazily through `Effect.suspend`, so:
 * - A failed load evicts the cached result and the next access retries from
 *   scratch (the previous Promise-memoization poisoned all future calls with a
 *   permanently rejected promise).
 * - Successful loads are cached until an explicit failure resets them.
 */
export function lazyOAuth(input: {
	name: string;
	isSubscription?: boolean;
	loginLabel?: string;
	load: () => Promise<OAuthAuth>;
}): OAuthAuth {
	let cached: OAuthAuth | undefined;
	const loadEffect: Effect.Effect<OAuthAuth, unknown> = Effect.suspend(() =>
		cached !== undefined
			? Effect.succeed(cached)
			: Effect.tryPromise({
					try: async () => {
						const implementation = await input.load();
						cached = implementation;
						return implementation;
					},
					catch: (error) => error,
				}),
	);
	return {
		name: input.name,
		isSubscription: input.isSubscription,
		loginLabel: input.loginLabel,
		login: async (interaction) => (await Effect.runPromise(loadEffect)).login(interaction),
		refresh: async (credential, signal) => (await Effect.runPromise(loadEffect)).refresh(credential, signal),
		toAuth: async (credential) => (await Effect.runPromise(loadEffect)).toAuth(credential),
	};
}
