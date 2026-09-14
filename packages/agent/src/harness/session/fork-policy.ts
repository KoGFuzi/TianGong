/**
 * Final action for current state at one address:
 * - copy: emit the current value in the destination;
 * - exclude: omit it from the destination;
 * - reconstruct: do not copy the row because lane handling emits a coherent replacement.
 */
export type ForkDisposition = "copy" | "exclude" | "reconstruct";

/** Decide the final fork action for one current scalar or list address. */
export function classifyForkAddress(
	address: { readonly namespace: string; readonly key: string },
	scope: "branch" | "tree",
	isEntryCopied: (entryId: string) => boolean,
): ForkDisposition {
	switch (address.namespace) {
		case "tg.session.name":
			return "copy";
		case "tg.entry.label":
			return isEntryCopied(address.key) ? "copy" : "exclude";
		case "tg.branch.tip":
		case "tg.lane.config":
		case "tg.lane.state":
			return "reconstruct";
		case "tg.result":
			return "exclude";
	}
	if (address.namespace.startsWith("tg.op.") || address.namespace.startsWith("tg.pending.")) return "exclude";
	if (address.namespace === "pi" || address.namespace.startsWith("tg.")) {
		throw new Error(`Unknown reserved fork namespace: ${address.namespace}`);
	}
	return scope === "tree" ? "copy" : "exclude";
}
