import { Context, Effect, Layer } from "effect";
import type { ProviderEnv } from "../types.ts";
import { operationSignal, raceWithAbortSignal } from "../utils/abort.ts";
import { formatThrownValue } from "../utils/diagnostics.ts";
import { InMemoryCredentialStore } from "./credential-store.ts";
import { defaultProviderAuthContext } from "./context.ts";
import { AbortedError } from "../utils/retry.ts";
import type {
	ApiKeyAuth,
	ApiKeyCredential,
	AuthContext,
	AuthResult,
	Credential,
	CredentialStore,
	OAuthAuth,
	OAuthCredential,
	ProviderAuth,
} from "./types.ts";

export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";

export interface AuthResolutionOverrides {
	apiKey?: string;
	env?: ProviderEnv;
	/** Require this much remaining OAuth-token validity; defaults to five minutes. */
	minOAuthValidityMs?: number;
	signal?: AbortSignal;
}

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;

	constructor(code: ModelsErrorCode, message: string, options?: { cause?: unknown }) {
		super(withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}

/**
 * Effect Service that encapsulates a provider's credential store and the
 * ambient auth context (env vars, file existence), and resolves provider auth
 * as an Effect that fails with `ModelsError` (or `AbortedError` when the shared
 * signal aborts). Replaces the ad-hoc `resolveProviderAuth(...)` arguments with
 * an Effect Context dependency.
 */
export const AuthResolverService = Context.Service<AuthResolverServiceShape>("AuthResolverService");

export interface AuthResolverServiceShape {
	readonly credentials: CredentialStore;
	resolveProviderAuth(
		provider: { id: string; auth: ProviderAuth },
		overrides?: AuthResolutionOverrides,
	): Effect.Effect<AuthResult | undefined, ModelsError | AbortedError>;
	readCredential(providerId: string, signal: AbortSignal): Effect.Effect<Credential | undefined, ModelsError>;
}

export interface CreateAuthResolverOptions {
	credentials?: CredentialStore;
	authContext?: AuthContext;
}

/** Build a Layer providing `AuthResolverService` from an optional credential store / auth context. */
export function createAuthResolverLayer(options?: CreateAuthResolverOptions): Layer.Layer<AuthResolverServiceShape> {
	return Layer.sync(AuthResolverService, () => {
		const credentials = options?.credentials ?? new InMemoryCredentialStore();
		const authContext = options?.authContext ?? defaultProviderAuthContext();
		return {
			credentials,
			resolveProviderAuth(provider, overrides) {
				return resolveProviderAuthEffect(provider, credentials, authContext, overrides);
			},
			readCredential(providerId, signal) {
				return readCredentialEffect(credentials, providerId, signal);
			},
		};
	});
}

/**
 * Auth resolution shared by the `Models` and `ImagesModels` collections.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export function resolveProviderAuth(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore,
	authContext: AuthContext,
	overrides?: AuthResolutionOverrides,
): Promise<AuthResult | undefined> {
	const signal = operationSignal(overrides?.signal);
	return Effect.runPromise(
		raceWithAbortSignal(
			resolveProviderAuthEffect(provider, credentials, authContext, overrides),
			signal,
		),
	);
}

/**
 * Effect-based version of resolveProviderAuth.
 */
function resolveProviderAuthEffect(
	provider: { id: string; auth: ProviderAuth },
	credentials: CredentialStore | undefined,
	authContext: AuthContext | undefined,
	overrides?: AuthResolutionOverrides,
): Effect.Effect<AuthResult | undefined, ModelsError | AbortedError> {
	return Effect.gen(function* () {
		const signal = operationSignal(overrides?.signal);
		const requestAuthContext = overrides?.env && authContext
			? overlayEnvAuthContext(authContext, overrides.env)
			: authContext;
		if (!requestAuthContext) {
			return undefined;
		}

		if (overrides?.apiKey !== undefined && provider.auth.apiKey) {
			return yield* resolveApiKeyEffect(
				requestAuthContext,
				provider.auth.apiKey,
				provider.id,
				{
					type: "api_key",
					key: overrides.apiKey,
					env: overrides.env,
				},
				signal,
			);
		}

		if (credentials) {
			const stored = yield* readCredentialEffect(credentials, provider.id, signal);
			if (stored) {
				if (stored.type === "oauth" && provider.auth.oauth) {
					return yield* resolveStoredOAuthEffect(
						credentials,
						provider.id,
						provider.auth.oauth,
						stored,
						signal,
						overrides?.minOAuthValidityMs,
					);
				}
				if (stored.type === "api_key" && provider.auth.apiKey) {
					const credential = overrides?.env
						? { ...stored, env: { ...stored.env, ...overrides.env } }
						: stored;
					return yield* resolveApiKeyEffect(
						requestAuthContext,
						provider.auth.apiKey,
						provider.id,
						credential,
						signal,
					);
				}
				return undefined;
			}
		}

		// Ambient (env vars, AWS profiles, ADC files).
		if (provider.auth.apiKey) {
			return yield* resolveApiKeyEffect(
				requestAuthContext,
				provider.auth.apiKey,
				provider.id,
				undefined,
				signal,
			);
		}
		return undefined;
	});
}

function overlayEnvAuthContext(base: AuthContext, env: ProviderEnv): AuthContext {
	return {
		env: async (name) => env[name] || (await base.env(name)),
		fileExists: (path) => base.fileExists(path),
	};
}

const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_REFRESH_TIMEOUT_MS = 15_000;

/**
 * OAuth resolution with double-checked locking: tokens with less than five
 * minutes remaining lock, re-check expiry under the lock, refresh once
 * globally, and persist the rotated credential before release.
 */
function resolveStoredOAuthEffect(
	credentials: CredentialStore,
	providerId: string,
	oauth: OAuthAuth,
	stored: OAuthCredential,
	signal: AbortSignal,
	minOAuthValidityMs?: number,
): Effect.Effect<AuthResult | undefined, ModelsError> {
	return Effect.tryPromise({
		try: async () => {
			const minimumValidityMs = Math.max(DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, minOAuthValidityMs ?? 0);
			const expiresSoon = (credential: OAuthCredential) => Date.now() + minimumValidityMs >= credential.expires;
			let credential = stored;

			if (expiresSoon(credential)) {
				// Optimistic check said expired; the authoritative check runs under the lock.
				let post: Credential | undefined;
				try {
					post = await credentials.modify(
						providerId,
						async (current) => {
							if (current?.type !== "oauth") return undefined; // logged out meanwhile
							if (!expiresSoon(current)) return undefined; // another process/request refreshed
							try {
								const refreshSignal = AbortSignal.any([
									signal,
									AbortSignal.timeout(DEFAULT_OAUTH_REFRESH_TIMEOUT_MS),
								]);
								return await oauth.refresh(current, refreshSignal);
							} catch (error) {
								throw new ModelsError("oauth", `OAuth refresh failed for ${providerId}`, { cause: error });
							}
						},
						{ signal },
					);
				} catch (error) {
					if (error instanceof ModelsError) throw error;
					throw new ModelsError("auth", `Credential store modify failed for ${providerId}`, { cause: error });
				}
				if (post?.type !== "oauth") return undefined; // logged out meanwhile
				credential = post;
				// The normal five-minute window triggers a refresh but does not impose a
				// provider contract. Explicit callers (such as bearer-token export) do
				// require the requested minimum after the refresh.
				if (minOAuthValidityMs !== undefined && expiresSoon(credential)) {
					throw new ModelsError("oauth", `OAuth refresh returned a token that expires too soon for ${providerId}`);
				}
			}

			try {
				return { auth: await oauth.toAuth(credential), source: "OAuth" };
			} catch (error) {
				throw new ModelsError("oauth", `OAuth auth derivation failed for ${providerId}`, { cause: error });
			}
		},
		catch: (error) => {
			if (error instanceof ModelsError) return error;
			if (error instanceof AbortedError) {
				return new ModelsError("oauth", `OAuth refresh aborted for ${providerId}`, { cause: error });
			}
			return new ModelsError("auth", `OAuth resolution failed for ${providerId}`, { cause: error });
		},
	});
}

function resolveApiKeyEffect(
	authContext: AuthContext,
	apiKey: ApiKeyAuth,
	providerId: string,
	credential: ApiKeyCredential | undefined,
	signal: AbortSignal,
): Effect.Effect<AuthResult | undefined, ModelsError> {
	return Effect.tryPromise({
		try: async () => apiKey.resolve({ ctx: authContext, credential, signal }),
		catch: (error) => {
			if (error instanceof ModelsError) return error;
			if (error instanceof AbortedError) {
				return new ModelsError("auth", `API key auth aborted for provider ${providerId}`, { cause: error });
			}
			return new ModelsError("auth", `API key auth failed for provider ${providerId}`, { cause: error });
		},
	});
}

function readCredentialEffect(
	credentials: CredentialStore,
	providerId: string,
	signal: AbortSignal,
): Effect.Effect<Credential | undefined, ModelsError> {
	return Effect.tryPromise({
		try: () => credentials.read(providerId, { signal }),
		catch: (error) => {
			if (error instanceof ModelsError) return error;
			if (error instanceof AbortedError) {
				return new ModelsError("auth", `Credential store read aborted for ${providerId}`, { cause: error });
			}
			return new ModelsError("auth", `Credential store read failed for ${providerId}`, { cause: error });
		},
	});
}
