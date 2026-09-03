import { Context, Effect, Layer } from "effect";
import type { ProviderEnv } from "../types.ts";
import { AbortedError } from "../utils/retry.ts";
import type { AuthContext, AuthResult, Credential, CredentialStore, ProviderAuth } from "./types.ts";
export type ModelsErrorCode = "model_source" | "model_validation" | "provider" | "stream" | "auth" | "oauth";
export interface AuthResolutionOverrides {
    apiKey?: string;
    env?: ProviderEnv;
    /** Require this much remaining OAuth-token validity; defaults to five minutes. */
    minOAuthValidityMs?: number;
    signal?: AbortSignal;
}
export declare class ModelsError extends Error {
    readonly code: ModelsErrorCode;
    constructor(code: ModelsErrorCode, message: string, options?: {
        cause?: unknown;
    });
}
/**
 * Effect Service that encapsulates a provider's credential store and the
 * ambient auth context (env vars, file existence), and resolves provider auth
 * as an Effect that fails with `ModelsError` (or `AbortedError` when the shared
 * signal aborts). Replaces the ad-hoc `resolveProviderAuth(...)` arguments with
 * an Effect Context dependency.
 */
export declare const AuthResolverService: Context.Service<AuthResolverServiceShape, AuthResolverServiceShape>;
export interface AuthResolverServiceShape {
    readonly credentials: CredentialStore;
    resolveProviderAuth(provider: {
        id: string;
        auth: ProviderAuth;
    }, overrides?: AuthResolutionOverrides): Effect.Effect<AuthResult | undefined, ModelsError | AbortedError>;
    readCredential(providerId: string, signal: AbortSignal): Effect.Effect<Credential | undefined, ModelsError>;
}
export interface CreateAuthResolverOptions {
    credentials?: CredentialStore;
    authContext?: AuthContext;
}
/** Build a Layer providing `AuthResolverService` from an optional credential store / auth context. */
export declare function createAuthResolverLayer(options?: CreateAuthResolverOptions): Layer.Layer<AuthResolverServiceShape>;
/**
 * Auth resolution shared by the `Models` and `ImagesModels` collections.
 * A stored credential owns the provider: ambient/env is consulted only when
 * nothing is stored. No silent env fallback after a failed refresh or for a
 * credential type without a matching handler.
 */
export declare function resolveProviderAuth(provider: {
    id: string;
    auth: ProviderAuth;
}, credentials: CredentialStore, authContext: AuthContext, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
