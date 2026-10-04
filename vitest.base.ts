import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Shared Vitest base for the TianGong workspace.
 *
 * Every workspace package resolves its siblings straight to `src/` instead of `dist/`,
 * so tests never need a prior build. Only specifiers that changed under the TianGong
 * house standard are mapped here; `@earendil-works/pi-codemode` and `@earendil-works/pi-mcp`
 * keep their upstream names because they are vendored unmodified.
 */
export const workspaceSourcePaths = {
	chordIndex: fileURLToPath(new URL("./packages/chord/src/index.ts", import.meta.url)),
	chordContext: fileURLToPath(new URL("./packages/chord/src/context/index.ts", import.meta.url)),
	chordDelta: fileURLToPath(new URL("./packages/chord/src/delta/index.ts", import.meta.url)),
	chordBundler: fileURLToPath(new URL("./packages/chord/src/bundler.ts", import.meta.url)),
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
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
	tuiRoot: fileURLToPath(new URL("./packages/tui/src", import.meta.url)),
	codemodeIndex: fileURLToPath(new URL("./packages/codemode/src/index.ts", import.meta.url)),
	mcpIndex: fileURLToPath(new URL("./packages/mcp/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@OnePanda-TgSec\/chord$/, replacement: workspaceSourcePaths.chordIndex },
			{ find: /^@OnePanda-TgSec\/chord\/context$/, replacement: workspaceSourcePaths.chordContext },
			{ find: /^@OnePanda-TgSec\/chord\/delta$/, replacement: workspaceSourcePaths.chordDelta },
			{ find: /^@OnePanda-TgSec\/chord\/bundler$/, replacement: workspaceSourcePaths.chordBundler },
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
			{ find: /^@OnePanda-TgSec\/tg-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@OnePanda-TgSec\/tg-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{
				find: /^@OnePanda-TgSec\/tg-tui\/(.+)$/,
				replacement: `${workspaceSourcePaths.tuiRoot}/$1.ts`,
			},
			{ find: /^@earendil-works\/tg-codemode$/, replacement: workspaceSourcePaths.codemodeIndex },
			{ find: /^@earendil-works\/tg-mcp$/, replacement: workspaceSourcePaths.mcpIndex },
		],
	},
});
