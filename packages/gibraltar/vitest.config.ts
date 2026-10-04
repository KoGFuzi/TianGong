import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const gibraltarSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const gibraltarSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@OnePanda-TgSec\/tg-gibraltar$/, replacement: gibraltarSrcIndex },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/testing$/, replacement: gibraltarSrcTesting },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});