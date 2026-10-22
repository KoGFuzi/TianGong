import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base for the TianGong workspace.
 *
 * Every workspace package resolves its siblings straight to `src/` instead of `dist/`,
 * so tests never need a prior build. Specifiers that changed under the TianGong house
 * standard are mapped by their TianGong names; the two vendored packages keep their
 * upstream specifiers (`@earendil-works/pi-codemode`, `@earendil-works/pi-mcp`) and are
 * mapped here under those same names.
 */
export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordOutput: fileURLToPath(new URL("./packages/chord/src/output.ts", import.meta.url)),
	chordNode: fileURLToPath(new URL("./packages/chord/src/node.ts", import.meta.url)),
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiConfigPaths: fileURLToPath(new URL("./packages/ai/src/config-paths.ts", import.meta.url)),
	aiModels: fileURLToPath(new URL("./packages/ai/src/models.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiApi: fileURLToPath(new URL("./packages/ai/src/api", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	aiUtils: fileURLToPath(new URL("./packages/ai/src/utils", import.meta.url)),
	gibraltarIndex: fileURLToPath(new URL("./packages/gibraltar/src/index.ts", import.meta.url)),
	gibraltarTesting: fileURLToPath(new URL("./packages/gibraltar/src/testing/index.ts", import.meta.url)),
	gibraltarRoot: fileURLToPath(new URL("./packages/gibraltar/src", import.meta.url)),
	envIndex: fileURLToPath(new URL("./packages/env/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
	tuiRoot: fileURLToPath(new URL("./packages/tui/src", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	codemodeDeclarations: fileURLToPath(new URL("./packages/codemode/src/declarations.ts", import.meta.url)),
	codemodeSource: fileURLToPath(new URL("./packages/codemode/src/source.ts", import.meta.url)),
	codemodeWorker: fileURLToPath(new URL("./packages/codemode/src/runtime/worker.ts", import.meta.url)),
	codemodePortable: fileURLToPath(new URL("./packages/codemode/src/portable.ts", import.meta.url)),
	codemodeCloudflare: fileURLToPath(new URL("./packages/codemode/src/cloudflare.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
	mcpOAuth: fileURLToPath(new URL("./packages/mcp/src/oauth/index.ts", import.meta.url)),
	mcpTesting: fileURLToPath(new URL("./packages/mcp/src/testing/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@OnePanda-TgSec\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@OnePanda-TgSec\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@OnePanda-TgSec\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@OnePanda-TgSec\/chord\/output$/, replacement: workspaceSourcePaths.chordOutput },
			{ find: /^@OnePanda-TgSec\/chord\/node$/, replacement: workspaceSourcePaths.chordNode },
			{ find: /^@OnePanda-TgSec\/tg-telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@OnePanda-TgSec\/tg-telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@OnePanda-TgSec\/tg-ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@OnePanda-TgSec\/tg-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@OnePanda-TgSec\/tg-ai\/config-paths$/, replacement: workspaceSourcePaths.aiConfigPaths },
			{ find: /^@OnePanda-TgSec\/tg-ai\/models$/, replacement: workspaceSourcePaths.aiModels },
			{ find: /^@OnePanda-TgSec\/tg-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@OnePanda-TgSec\/tg-ai\/utils\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiUtils}/$1.ts`,
			},
			{
				find: /^@OnePanda-TgSec\/tg-ai\/api\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiApi}/$1.ts`,
			},
			{
				find: /^@OnePanda-TgSec\/tg-ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@OnePanda-TgSec\/tg-gibraltar$/, replacement: workspaceSourcePaths.gibraltarIndex },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/testing$/, replacement: workspaceSourcePaths.gibraltarTesting },
			{
				find: /^@OnePanda-TgSec\/tg-gibraltar\/(.+)$/,
				replacement: `${workspaceSourcePaths.gibraltarRoot}/$1.ts`,
			},
			{ find: /^@OnePanda-TgSec\/tg-env$/, replacement: workspaceSourcePaths.envIndex },
			{ find: /^@OnePanda-TgSec\/tg-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{
				find: /^@OnePanda-TgSec\/tg-tui\/(.+)$/,
				replacement: `${workspaceSourcePaths.tuiRoot}/$1.ts`,
			},
			{ find: /^@earendil-works\/pi-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{
				find: /^@earendil-works\/pi-codemode\/declarations$/,
				replacement: workspaceSourcePaths.codemodeDeclarations,
			},
			{ find: /^@earendil-works\/pi-codemode\/source$/, replacement: workspaceSourcePaths.codemodeSource },
			{ find: /^@earendil-works\/pi-codemode\/worker$/, replacement: workspaceSourcePaths.codemodeWorker },
			{ find: /^@earendil-works\/pi-codemode\/portable$/, replacement: workspaceSourcePaths.codemodePortable },
			{ find: /^@earendil-works\/pi-codemode\/cloudflare$/, replacement: workspaceSourcePaths.codemodeCloudflare },
			{ find: /^@earendil-works\/pi-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
			{ find: /^@earendil-works\/pi-mcp\/oauth$/, replacement: workspaceSourcePaths.mcpOAuth },
			{ find: /^@earendil-works\/pi-mcp\/testing$/, replacement: workspaceSourcePaths.mcpTesting },
		],
	},
});
