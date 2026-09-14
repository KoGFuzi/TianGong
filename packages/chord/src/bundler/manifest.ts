export const PLUGIN_BUNDLE_FORMAT = "chord.plugin-bundle";
export const PLUGIN_BUNDLE_FORMAT_VERSION = 1;
export const PLUGIN_BUNDLE_MANIFEST_FILE = "chord-plugins.json";

export interface PluginBundleEntry {
	/** Content-addressed ESM filename relative to the manifest. */
	readonly file: string;
	/** SHA-256 subresource-integrity value for the JavaScript file. */
	readonly integrity: string;
	/** Imports intentionally left for the loading application to resolve. */
	readonly externalImports: readonly string[];
	/** Source map filename relative to the manifest, when emitted. */
	readonly sourceMap?: string;
}

export interface PluginBundleManifest {
	readonly format: typeof PLUGIN_BUNDLE_FORMAT;
	readonly formatVersion: typeof PLUGIN_BUNDLE_FORMAT_VERSION;
	readonly plugin: PluginBundlePlugin;
	readonly entries: Readonly<Record<string, PluginBundleEntry>>;
}

export interface PluginBundlePlugin {
	readonly id: string;
	readonly version?: string;
}
