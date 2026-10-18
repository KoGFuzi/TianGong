// For an import of a `.wasm` file as a Workers compiled module, which a bundler with Wrangler's default `CompiledWasm`
// rule turns a `.wasm` import into. Nothing in the ported sources imports it; it keeps the declaration at hand for a
// Cloudflare-style consumer.
declare module "@silvia-odwyer/photon/photon_rs_bg.wasm" {
	const module: WebAssembly.Module;
	export default module;
}
