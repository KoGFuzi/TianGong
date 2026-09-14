import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;
const compatEntryUrl = new URL("../src/compat.ts", import.meta.url).href;
const providersAllUrl = new URL("../src/providers/all.ts", import.meta.url).href;

const SDK_SPECIFIERS = ["@anthropic-ai/sdk", "openai", "@google/genai", "@aws-sdk/client-bedrock-runtime"] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
};

/**
 * Each probe runs in a fresh `bun` subprocess so the module graph is observed
 * from a clean slate (module-cache state cannot leak between probes). SDK
 * loads are observed with a runtime `Bun.plugin` `onLoad` hook: Bun 1.3
 * runtime `onLoad` must return an object (no pass-through), so hooked SDK
 * files are re-served from disk verbatim with the `js` loader; everything
 * else is untouched because the hook filter only matches SDK module paths.
 * The filter covers Bun's install-cache layout (`@scope/pkg@ver@@@1/...`) and
 * plain `node_modules` layouts alike.
 */
function probeScript(action: string): string {
	return `
		const SDK_PATH_MAPPERS = [
			[/@anthropic-ai[/\\\\]sdk/, "@anthropic-ai/sdk"],
			[/[/\\\\]openai[/\\\\]|[/\\\\]openai@/, "openai"],
			[/@google[/\\\\]genai/, "@google/genai"],
			[/@aws-sdk[/\\\\]client-bedrock-runtime/, "@aws-sdk/client-bedrock-runtime"],
		];
		const SDK_PATH_PATTERN = /@anthropic-ai[/\\\\]sdk|[/\\\\]openai[/\\\\]|[/\\\\]openai@|@google[/\\\\]genai|@aws-sdk[/\\\\]client-bedrock-runtime/;
		const loaded = [];
		Bun.plugin({
			name: "sdk-probe",
			setup(build) {
				build.onLoad({ filter: SDK_PATH_PATTERN }, async (args) => {
					for (const [pattern, specifier] of SDK_PATH_MAPPERS) {
						if (pattern.test(args.path)) {
							loaded.push(specifier);
							break;
						}
					}
					return { contents: await Bun.file(args.path).text(), loader: "js" };
				});
			},
		});
		const all = await import(${JSON.stringify(providersAllUrl)});
		const compat = await import(${JSON.stringify(compatEntryUrl)});
		await import(${JSON.stringify(aiEntryUrl)});
		${action}
		console.log("PROBE:" + JSON.stringify({ loadedSpecifiers: [...new Set(loaded)] }));
	`;
}

function runProbeSync(script: string): ProbeResult {
	const result = Bun.spawnSync(["bun", "-e", script], { cwd: packageRoot });
	const stdout = result.stdout.toString();
	const stderr = result.stderr.toString();
	if (result.exitCode !== 0) {
		throw new Error(`Probe failed (exit ${result.exitCode})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`);
	}
	const lastLine = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("PROBE:"))
		.at(-1);
	if (!lastLine) throw new Error(`Probe produced no output\nSTDERR:\n${stderr}`);
	return JSON.parse(lastLine.slice("PROBE:".length)) as ProbeResult;
}

const ANTHROPIC_STREAM_LAZY_API = `
	const model = {
		id: "claude-sonnet-4-6",
		name: "Claude Sonnet 4",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
	const context = { messages: [{ role: "user", content: "hi" }] };
	await compat.anthropicMessagesApi().streamSimple(model, context).result().catch(() => {});
`;

const ANTHROPIC_STREAM_COMPAT = `
	const model = compat.getModel("anthropic", "claude-sonnet-4-6");
	const context = { messages: [{ role: "user", content: "hi" }] };
	await compat.streamSimple(model, context).result().catch(() => {});
`;

describe("lazy provider module loading", () => {
	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbeSync(probeScript("void all; void compat;"));
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("does not load provider SDKs when building all builtin providers", () => {
		const result = runProbeSync(probeScript("all.builtinModels().getModels();"));
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("does not load provider SDKs when importing the compat entrypoint", () => {
		const result = runProbeSync(probeScript(""));
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads only the Anthropic SDK when streaming through the lazy API wrapper", () => {
		const result = runProbeSync(probeScript(ANTHROPIC_STREAM_LAZY_API));
		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbeSync(probeScript(ANTHROPIC_STREAM_COMPAT));
		expect(result.loadedSpecifiers).toEqual(["@anthropic-ai/sdk"]);
	});
});
