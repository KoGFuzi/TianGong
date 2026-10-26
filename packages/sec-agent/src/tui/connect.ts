import type { AuthEvent, AuthPrompt, AuthType, Models, Provider } from "@OnePanda-TgSec/tg-ai";
import { Container, type Focusable, Input, Text } from "@OnePanda-TgSec/tg-tui";
import { tgSecStyle } from "./theme.ts";

/** One interactive login route a provider offers; ambient-only credentials have none. */
export type ProviderLoginMethod = {
	readonly providerId: string;
	readonly providerName: string;
	readonly authType: AuthType;
	/** The provider's name for this method, e.g. "Anthropic API key". */
	readonly methodName: string;
	/** The provider's selector label for OAuth, when it has one. */
	readonly loginLabel?: string;
};

/** A login route plus the provider's current credential state. */
export type ConnectOption = ProviderLoginMethod & {
	readonly status: string;
};

/**
 * The providers that can be configured from inside the shell: those whose OAuth or API-key method
 * implements `login`. A provider that is ambient-only (environment variables, AWS profiles, ADC)
 * has nothing to ask, so it is skipped and OAuth is offered before its API key.
 */
export function providerLoginMethods(providers: readonly Provider[]): ProviderLoginMethod[] {
	const methods: ProviderLoginMethod[] = [];
	for (const provider of providers) {
		const oauth = provider.auth.oauth;
		if (oauth?.login !== undefined) {
			methods.push({
				providerId: provider.id,
				providerName: provider.name,
				authType: "oauth",
				methodName: oauth.name,
				...(oauth.loginLabel === undefined ? {} : { loginLabel: oauth.loginLabel }),
			});
		}
		const apiKey = provider.auth.apiKey;
		if (apiKey?.login !== undefined) {
			methods.push({
				providerId: provider.id,
				providerName: provider.name,
				authType: "api_key",
				methodName: apiKey.name,
			});
		}
	}
	return methods;
}

/** Plain status lines for an auth event; the dialog styles them, tests assert on the text. */
export function formatAuthEventLines(event: AuthEvent): string[] {
	switch (event.type) {
		case "info":
			return [
				event.message,
				...(event.links ?? []).map((link) =>
					link.label === undefined ? `  ${link.url}` : `  ${link.label}: ${link.url}`,
				),
			];
		case "auth_url":
			return [
				`open this URL: ${event.url}`,
				...(event.instructions === undefined ? [] : [`  ${event.instructions}`]),
			];
		case "device_code": {
			const lines = [`enter code ${event.userCode} at ${event.verificationUri}`];
			if (event.expiresInSeconds !== undefined) lines.push(`  the code expires in ${event.expiresInSeconds}s`);
			return lines;
		}
		case "progress":
			return [event.message];
	}
}

/**
 * Resolve a select prompt from typed input: a 1-based number, an exact option id, or a
 * case-insensitive label. `undefined` means the value does not name an option.
 */
export function parseSelectPrompt(
	value: string,
	options: readonly { readonly id: string; readonly label: string }[],
): string | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	if (/^[0-9]+$/u.test(trimmed)) {
		const index = Number(trimmed) - 1;
		return options[index]?.id;
	}
	const byId = options.find((option) => option.id === trimmed);
	if (byId !== undefined) return byId.id;
	const lower = trimmed.toLowerCase();
	return options.find((option) => option.label.toLowerCase() === lower)?.id;
}

/** The picker label for a login route: the provider name plus the method the provider prefers to show. */
export function connectOptionLabel(option: ConnectOption): string {
	return `${option.providerName} - ${option.loginLabel ?? option.methodName}`;
}

/** Every configurable provider route with its live auth state, OAuth first within providers. */
export async function buildConnectOptions(models: Models): Promise<ConnectOption[]> {
	const methods = providerLoginMethods(models.getProviders());
	const options: ConnectOption[] = [];
	for (const method of methods) {
		const check = await models.checkAuth(method.providerId);
		const status =
			check === undefined
				? "not connected"
				: `connected (${check.source ?? (check.type === "oauth" ? "oauth" : "api key")})`;
		options.push({ ...method, status });
	}
	return options.sort((left, right) => {
		const byName = left.providerName.localeCompare(right.providerName);
		if (byName !== 0) return byName;
		if (left.authType === right.authType) return 0;
		return left.authType === "oauth" ? -1 : 1;
	});
}

/** The prompts the login dialog answers directly; `select` is routed to a picker overlay. */
type TextPrompt = Extract<AuthPrompt, { type: "text" | "secret" | "manual_code" }>;

export type LoginDialogOptions = {
	readonly title: string;
	/** Abort the whole login; the app owns the controller and clears the overlay. */
	readonly onCancel: () => void;
	/** Repaint after an auth callback mutates the dialog outside the input loop. */
	readonly requestRender: () => void;
};

type PendingPrompt = {
	readonly resolve: (value: string) => void;
	readonly reject: (error: unknown) => void;
};

const MAX_STATUS_LINES = 12;
const INPUT_INDEX = 3;

/**
 * The auth flow's screen: a rolling status log (auth URLs, device codes, progress), the current
 * prompt, and one input. Secret prompts get a masked input. Escape or ctrl+c cancels the login
 * through `onCancel`; the app aborts the controller and rejects whatever the dialog still holds.
 */
export class LoginDialog extends Container implements Focusable {
	private readonly onCancel: () => void;
	private readonly requestRender: () => void;
	private readonly status = new Text("", 1, 0);
	private readonly promptLine = new Text("", 1, 0);
	private input: Input;
	private inputSecret = false;
	private statusLines: string[] = [];
	private pending: PendingPrompt | undefined;
	private focusState = false;

	constructor(options: LoginDialogOptions) {
		super();
		this.onCancel = options.onCancel;
		this.requestRender = options.requestRender;
		this.input = this.makeInput(false);
		this.addChild(new Text(tgSecStyle.bold(tgSecStyle.cyan(options.title)), 1, 0));
		this.addChild(this.status);
		this.addChild(this.promptLine);
		this.addChild(this.input);
		this.addChild(new Text(tgSecStyle.dim("enter submit  esc cancel"), 1, 0));
	}

	get focused(): boolean {
		return this.focusState;
	}

	set focused(value: boolean) {
		this.focusState = value;
		this.input.focused = value;
	}

	/** Show one text prompt and resolve with what the operator enters. */
	ask(prompt: TextPrompt): Promise<string> {
		this.cancelPending(new Error("superseded by a newer prompt"));
		this.useInput(prompt.type === "secret");
		this.input.setValue("");
		this.promptLine.setText(
			prompt.type === "secret" ? `${prompt.message} ${tgSecStyle.dim("(input hidden)")}` : prompt.message,
		);
		this.requestRender();
		return new Promise<string>((resolve, reject) => {
			this.pending = { resolve, reject };
			const cancel = () => this.cancelPending(prompt.signal?.reason ?? new Error("prompt cancelled"));
			if (prompt.signal?.aborted === true) cancel();
			else prompt.signal?.addEventListener("abort", cancel, { once: true });
		});
	}

	/** Append a formatting line for an auth event, keeping the log to one screen. */
	notify(event: AuthEvent): void {
		for (const line of formatAuthEventLines(event)) this.statusLines.push(line);
		if (this.statusLines.length > MAX_STATUS_LINES) {
			this.statusLines = this.statusLines.slice(-MAX_STATUS_LINES);
		}
		this.status.setText(this.statusLines.join("\n"));
		this.requestRender();
	}

	/** Reject a prompt that is still waiting; the app calls this when a flow ends or is aborted. */
	cancelPending(error: unknown): void {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		this.promptLine.setText("");
		this.requestRender();
		pending.reject(error);
	}

	/** Clear the prompt once the flow has settled. */
	finish(): void {
		this.pending = undefined;
		this.input.setValue("");
		this.promptLine.setText("");
		this.requestRender();
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}

	private useInput(secret: boolean): void {
		if (secret === this.inputSecret) return;
		this.inputSecret = secret;
		this.input = this.makeInput(secret);
		this.children[INPUT_INDEX] = this.input;
		this.invalidate();
		this.requestRender();
	}

	private makeInput(secret: boolean): Input {
		const input = new Input({ prompt: "> ", ...(secret ? { secret } : {}) });
		input.onSubmit = (value) => this.settle(value);
		input.onEscape = () => this.onCancel();
		input.focused = this.focusState;
		return input;
	}

	private settle(value: string): void {
		const pending = this.pending;
		if (pending === undefined) return;
		this.pending = undefined;
		this.promptLine.setText("");
		this.input.setValue("");
		this.requestRender();
		pending.resolve(value);
	}
}
