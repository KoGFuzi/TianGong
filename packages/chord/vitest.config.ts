import { defineConfig } from "vitest/config";
import base from "../../vitest.base.ts";

export default defineConfig({
	...base,
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
	resolve: { ...base.resolve, conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});