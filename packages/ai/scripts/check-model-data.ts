#!/usr/bin/env bun

import { Effect } from "effect";
import { validateGeneratedModelData } from "./model-data.ts";

const packageRoot = import.meta.dir + "/..";

const checkModelData = Effect.try({
	try: () => validateGeneratedModelData(packageRoot),
	catch: (error) => error,
});

try {
	await Effect.runPromise(checkModelData);
	console.log("Generated model data is valid.");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	console.error("\nModel data is missing or stale. Run `bun run hydrate-model-data` from packages/ai.");
	throw error;
}
