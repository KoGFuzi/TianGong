import type { Provider } from "@OnePanda-TgSec/tg-ai";
import { builtinProviders } from "@OnePanda-TgSec/tg-ai/providers/all";
import { describe, expect, it } from "vitest";
import {
	connectOptionLabel,
	formatAuthEventLines,
	parseSelectPrompt,
	providerLoginMethods,
} from "../src/tui/connect.ts";

/** A provider whose credentials come only from the environment: it has no interactive login. */
function ambientProvider(): Provider {
	const source = builtinProviders().find((provider) => provider.id === "deepseek");
	if (source?.auth.apiKey === undefined) throw new Error("the builtin DeepSeek provider changed shape");
	return {
		...source,
		id: "ambient",
		name: "Ambient",
		auth: { apiKey: { name: "Ambient credentials", resolve: source.auth.apiKey.resolve } },
	};
}

describe("providerLoginMethods", () => {
	it("offers OAuth before an API key and skips providers without login", () => {
		const methods = providerLoginMethods([ambientProvider(), ...builtinProviders()]);
		expect(methods.some((method) => method.providerId === "ambient")).toBe(false);

		const anthropic = methods.filter((method) => method.providerId === "anthropic");
		expect(anthropic.map((method) => method.authType)).toEqual(["oauth", "api_key"]);
		expect(anthropic[0]).toMatchObject({
			providerName: "Anthropic",
			methodName: "Anthropic (Claude Pro/Max)",
		});
		expect(anthropic[1]).toMatchObject({ methodName: "Anthropic API key" });
	});

	it("keeps a provider's OAuth selector label when it has one", () => {
		const openai = providerLoginMethods(builtinProviders()).find(
			(method) => method.providerId === "openai" && method.authType === "oauth",
		);
		expect(openai?.loginLabel).toBe("Sign in with ChatGPT");
	});
});

describe("formatAuthEventLines", () => {
	it("spells out a device code and where to enter it", () => {
		expect(
			formatAuthEventLines({
				type: "device_code",
				userCode: "ABCD-1234",
				verificationUri: "https://example.test/device",
				expiresInSeconds: 600,
			}),
		).toEqual(["enter code ABCD-1234 at https://example.test/device", "  the code expires in 600s"]);
	});

	it("renders an auth URL, info links and progress", () => {
		expect(formatAuthEventLines({ type: "auth_url", url: "https://example.test/auth" })).toEqual([
			"open this URL: https://example.test/auth",
		]);
		expect(
			formatAuthEventLines({
				type: "info",
				message: "Choose an account",
				links: [{ url: "https://example.test/help", label: "help" }, { url: "https://example.test/raw" }],
			}),
		).toEqual(["Choose an account", "  help: https://example.test/help", "  https://example.test/raw"]);
		expect(formatAuthEventLines({ type: "progress", message: "Waiting for the browser" })).toEqual([
			"Waiting for the browser",
		]);
	});
});

describe("parseSelectPrompt", () => {
	const options = [
		{ id: "oauth", label: "Sign in" },
		{ id: "api_key", label: "API key" },
	];

	it("accepts a 1-based number, an exact id, or a case-insensitive label", () => {
		expect(parseSelectPrompt("1", options)).toBe("oauth");
		expect(parseSelectPrompt("api_key", options)).toBe("api_key");
		expect(parseSelectPrompt("sign in", options)).toBe("oauth");
		expect(parseSelectPrompt("  API KEY  ", options)).toBe("api_key");
	});

	it("rejects values that name no option", () => {
		expect(parseSelectPrompt("3", options)).toBeUndefined();
		expect(parseSelectPrompt("", options)).toBeUndefined();
		expect(parseSelectPrompt("something else", options)).toBeUndefined();
	});
});

describe("connectOptionLabel", () => {
	it("prefers the OAuth selector label over the auth method name", () => {
		expect(
			connectOptionLabel({
				providerId: "openai",
				providerName: "OpenAI",
				authType: "oauth",
				methodName: "OpenAI (ChatGPT subscription)",
				loginLabel: "Sign in with ChatGPT",
				status: "not connected",
			}),
		).toBe("OpenAI - Sign in with ChatGPT");
	});
});
