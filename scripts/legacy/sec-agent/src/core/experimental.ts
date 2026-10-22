export function areExperimentalFeaturesEnabled(): boolean {
	return process.env.TG_EXPERIMENTAL === "1";
}
