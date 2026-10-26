import { type AuthPrompt, type Provider, tiangongAuthFilePath } from "@OnePanda-TgSec/tg-ai";
import { FileCredentialStore } from "@OnePanda-TgSec/tg-ai/auth/node";
import { builtinProviders } from "@OnePanda-TgSec/tg-ai/providers/all";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

/** `~/.local/share/TianGong/auth.json`, or `$XDG_DATA_HOME/TianGong/auth.json`. */
const AUTH_FILE = tiangongAuthFilePath();

type OAuthProvider = Provider & { auth: { oauth: NonNullable<Provider["auth"]["oauth"]> } };

function oauthProviders(): readonly OAuthProvider[] {
	return builtinProviders().filter((provider): provider is OAuthProvider => provider.auth.oauth !== undefined);
}

/** One provider id/name pair per line, for `tg-sec list` and the help text. */
export function oauthProviderNames(): readonly string[] {
	return oauthProviders().map((provider) => `${provider.id.padEnd(20)} ${provider.name}`);
}

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

async function answerPrompt(rl: ReturnType<typeof createInterface>, authPrompt: AuthPrompt): Promise<string> {
	if (authPrompt.type === "select") {
		console.log(`\n${authPrompt.message}`);
		for (let index = 0; index < authPrompt.options.length; index++) {
			console.log(`  ${index + 1}. ${authPrompt.options[index].label}`);
		}
		const choice = Number.parseInt(await prompt(rl, `Enter number (1-${authPrompt.options.length}): `), 10) - 1;
		const selected = authPrompt.options[choice];
		if (!selected) throw new Error("Invalid selection");
		return selected.id;
	}
	return prompt(rl, `${authPrompt.message}${authPrompt.placeholder ? ` (${authPrompt.placeholder})` : ""}: `);
}

async function login(provider: OAuthProvider): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		// This CLI does not persist an installation ID; apps should reuse one across logins.
		const credential = await provider.auth.oauth.login(
			{
				signal: new AbortController().signal,
				prompt: (authPrompt) => answerPrompt(rl, authPrompt),
				notify: (event) => {
					switch (event.type) {
						case "auth_url":
							console.log(`\nOpen this URL in your browser:\n${event.url}`);
							if (event.instructions) console.log(event.instructions);
							break;
						case "device_code":
							console.log(`\nOpen this URL in your browser:\n${event.verificationUri}`);
							console.log(`Enter code: ${event.userCode}`);
							break;
						case "info":
						case "progress":
							console.log(event.message);
							break;
					}
				},
			},
			{ getDeviceId: randomUUID, agentName: "TianGong" },
		);
		const credentials = new FileCredentialStore();
		// `modify` is the store's only write path, so the login lands through the same
		// cross-process exclusion every later refresh depends on.
		await credentials.modify(provider.id, async () => credential);
		console.log(`\nCredentials saved to ${AUTH_FILE}`);
	} finally {
		rl.close();
	}
}

/** `tg-sec login [provider]` and `tg-sec list`; the OAuth credential bootstrap for provider auth. */
export async function runAuthCommand(command: "login" | "list", args: readonly string[]): Promise<void> {
	const providers = oauthProviders();
	if (command === "list") {
		for (const provider of providers) console.log(`${provider.id.padEnd(20)} ${provider.name}`);
		return;
	}

	let providerId = args[0];
	if (!providerId) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try {
			for (let index = 0; index < providers.length; index++) {
				console.log(`  ${index + 1}. ${providers[index].name}`);
			}
			const index = Number.parseInt(await prompt(rl, `Enter number (1-${providers.length}): `), 10) - 1;
			providerId = providers[index]?.id;
		} finally {
			rl.close();
		}
	}
	const provider = providers.find((entry) => entry.id === providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId ?? ""}`);
	await login(provider);
}
