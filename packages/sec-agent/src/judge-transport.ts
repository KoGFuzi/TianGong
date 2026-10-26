import type { Models } from "@OnePanda-TgSec/tg-ai";
import type { ModelRef } from "@OnePanda-TgSec/tg-gibraltar";
import type { TgSecJudgeTransport } from "@OnePanda-TgSec/tg-sec-guard";

/**
 * The judge transport over the house `Models`: one `completeSimple` request per judgement, the
 * same one-shot shape gibraltar's compaction summarizer uses (`runtime.models.completeSimple(model,
 * { messages }, options)`). The raw reply text goes back to the two-axis judge, which owns the
 * protocol parse; this transport interprets nothing.
 *
 * A provider-level error stops being this transport's problem the moment it is a rejection: the
 * judge maps every transport throw to an ask, so a failed judgement escalates to a human instead
 * of releasing the call.
 */
export function createModelJudgeTransport(options: {
	models: Models;
	model: ModelRef;
	/** Read on every judgement, so a shell that switches models mid-session judges with the new one. */
	resolveModel?: () => ModelRef;
	/** Optional per-request token cap for the judge reply; the protocol answer is one short JSON object. */
	maxTokens?: number;
}): TgSecJudgeTransport {
	const { models } = options;
	return {
		async complete(input) {
			const ref = options.resolveModel?.() ?? options.model;
			const model = models.getModel(ref.provider, ref.modelId);
			if (model === undefined) {
				throw new Error(`the judge model ${ref.provider}/${ref.modelId} is not registered with this Models`);
			}
			const message = await models.completeSimple(
				model,
				{ messages: [{ role: "user", content: input.prompt, timestamp: Date.now() }] },
				options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
			);
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(
					`the judge request ended with ${message.stopReason}: ${message.errorMessage ?? "no error message"}`,
				);
			}
			const texts = message.content.filter((block) => block.type === "text").map((block) => block.text);
			return texts.join("");
		},
	};
}
