import type { Api, Model, ProviderId } from "./types.ts";

export type ModelGroups = Record<string, Record<string, object>>;

type ModelId<TGroups extends ModelGroups> = {
	[TApi in keyof TGroups]: keyof TGroups[TApi];
}[keyof TGroups] &
	string;

type ModelApi<TGroups extends ModelGroups, TModelId extends ModelId<TGroups>> = {
	[TApi in keyof TGroups]: TModelId extends keyof TGroups[TApi] ? TApi : never;
}[keyof TGroups] &
	Api;

export type ModelCatalog<TGroups extends ModelGroups, TProvider extends ProviderId> = {
	[TModelId in ModelId<TGroups>]: Model<ModelApi<TGroups, TModelId>> & {
		id: TModelId;
		provider: TProvider;
	};
};

export function flattenModelCatalog<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	_provider: TProvider,
	groups: TGroups,
): ModelCatalog<TGroups, TProvider> {
	return Object.assign({}, ...Object.values(groups)) as ModelCatalog<TGroups, TProvider>;
}

/**
 * Effect v4 / JSON imports: a JSON module is typed as `unknown` unless the
 * project has a JSON schema. Accept `unknown` and trust the catalog typings
 * at the call site so each generated provider file does not have to repeat
 * the cast.
 *
 * Returns a `ModelCatalog<ModelGroups, TProvider>` (a permissive
 * `string`-keyed shape) so callers can still extract concrete `api` literals
 * from the value type at the use site via narrow type assertions.
 */
export function flattenModelCatalogFromUnknown<const TProvider extends ProviderId, const TGroups extends ModelGroups>(
	provider: TProvider,
	raw: unknown,
): ModelCatalog<TGroups, TProvider> {
	return flattenModelCatalog(provider, raw as TGroups);
}

/**
 * Helper that exposes the concrete `api` literal of a model catalog. Used by
 * generated `*.models.ts` to keep `Object.values(FOO_MODELS)` typed as
 * `Model<concrete-api>[]` even when the catalog is parsed from JSON.
 */
export type CatalogModelApi<TCatalog> = TCatalog extends ModelCatalog<infer TGroups, ProviderId>
	? keyof TGroups & Api
	: never;
