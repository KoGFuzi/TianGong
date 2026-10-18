import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const gibraltarSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const gibraltarSrcTesting = fileURLToPath(new URL("./src/testing/index.ts", import.meta.url));
const gibraltarSrcImages = fileURLToPath(new URL("./src/images/index.ts", import.meta.url));
const gibraltarSrcImagesNode = fileURLToPath(new URL("./src/images/node.ts", import.meta.url));
const gibraltarSrcTools = fileURLToPath(new URL("./src/tools/index.ts", import.meta.url));

export default defineConfig({
	test: {
		environment: "node",
		setupFiles: ["./test/setup-document-retention.ts"],
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@OnePanda-TgSec\/tg-gibraltar$/, replacement: gibraltarSrcIndex },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/testing$/, replacement: gibraltarSrcTesting },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/images\/node$/, replacement: gibraltarSrcImagesNode },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/images$/, replacement: gibraltarSrcImages },
			{ find: /^@OnePanda-TgSec\/tg-gibraltar\/tools$/, replacement: gibraltarSrcTools },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});