import { Effect } from "effect";
import type { ImagesModel, ProviderImages } from "../types.ts";

export const openrouterImagesApi = (): ProviderImages => ({
	generateImages: (model, context, options) =>
		Effect.runPromise(
			Effect.tryPromise(async () =>
				(await import("./openrouter-images.ts")).generateImages(
					model as ImagesModel<"openrouter-images">,
					context,
					options,
				)
			)
		),
});
