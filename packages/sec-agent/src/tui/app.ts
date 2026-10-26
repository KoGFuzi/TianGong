import type { Context } from "@OnePanda-TgSec/chord";
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import type {
	AssistantMessage,
	AuthInteraction,
	FauxProviderHandle,
	FauxResponseFactory,
	ToolResultMessage,
	UserMessage,
} from "@OnePanda-TgSec/tg-ai";
import { contentText, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import type {
	AgentEvent,
	EntryRecord,
	JsonObject,
	MessageChange,
	ModelRef,
	SessionDocToken,
	SnapshotEvent,
	Tx,
	UsageState,
} from "@OnePanda-TgSec/tg-gibraltar";
import {
	isTgSecMode,
	loadTgSecScopeRegistry,
	readTgSecMode,
	type TgSecPermissionMode,
	type TgSecSessionPort,
} from "@OnePanda-TgSec/tg-sec-guard";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import {
	Editor,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	ProcessTerminal,
	ScrollView,
	Text,
	TuiAltScreen,
	type TuiInputListenerResult,
	VStack,
} from "@OnePanda-TgSec/tg-tui";
import { join } from "node:path";
import type { SecAgent, SecAgentLane } from "../bootstrap.ts";
import { openSecAgent } from "../bootstrap.ts";
import { fauxDatabasePath, safeProjectSegment, tgSecDataDir } from "../config.ts";
import { createSecCoreExtension } from "../core-extension.ts";
import { evidenceDir } from "../evidence/config.ts";
import type { TgSecEvidenceStore } from "../evidence/store.ts";
import { openTgSecEvidenceStore } from "../evidence/store.ts";
import { buildSecGuard, type SecGuardWiring, secAttestForbiddenRead, secDeclaredTools } from "../guard-wiring.ts";
import { type SecObservation, watchSecEvents } from "../observation.ts";
import type { TaskChildPolicy } from "../task-tool.ts";
import { createSecToolsExtension } from "../tools/extension.ts";
import { nodeRequestExecutor } from "../tools/transport.ts";
import { createTgSecAskController, type TgSecAskController } from "./ask.ts";
import { buildConnectOptions, type ConnectOption, connectOptionLabel, LoginDialog } from "./connect.ts";
import {
	createTgSecModels,
	FAUX_PROVIDER_ID,
	findAvailableModel,
	formatModelRef,
	isFauxModelRef,
	isUnconfiguredModel,
	parseModelSpec,
	readOrCreateDeviceId,
	resetFauxContext,
	tryResolveTgSecModel,
	UNCONFIGURED_MODEL,
	writeTgSecModelConfig,
} from "./model.ts";
import { Picker } from "./picker.ts";
import { AskBar, StatusBar } from "./status.ts";
import { tgSecEditorTheme, tgSecStyle } from "./theme.ts";
import {
	assistantMessageBlocks,
	assistantPartialText,
	formatUsage,
	ToolCard,
	TranscriptView,
	toolResultText,
	userMessageText,
} from "./transcript.ts";

/** The lanes a campaign can run; mirrors `SecAgentLane` for CLI parsing without importing a value. */
const LANES: readonly SecAgentLane[] = ["redteam", "ctf", "src"];

const HELP = [
	"commands:",
	"  /help                 show this help",
	"  /connect              sign in to a provider (OAuth or API key)",
	"  /models [query]       pick an authenticated model",
	"  /model                pick an authenticated model",
	"  /model <provider/id>  switch model and remember it",
	"  /mode                 show the guard mode",
	"  /mode <name>          switch guard mode (strict|judge-auto|auto|yolo)",
	"  /scope                show the scope config path",
	"  /clear                start a new context (keeps the transcript on screen)",
	"  /compact [text]       compact the conversation context",
	"  /usage                show token and cost totals",
	"  /quit, /exit          leave",
	"keys: y allow once, n deny, a always (this tool) while a guard ask is pending; ctrl+c aborts a run or quits when idle",
].join("\n");

export type TgSecTuiOptions = {
	readonly project: string;
	readonly lane: SecAgentLane;
	/** CLI override; absent means the persisted `tg.sec.mode` (default `auto`). */
	readonly mode?: TgSecPermissionMode;
	/** `provider/modelId`; absent means `TG_SEC_MODEL`, the remembered choice, then the first available. */
	readonly model?: string;
	/** Local echo model so the shell can be exercised without credentials or egress. */
	readonly faux?: boolean;
	readonly db?: string;
	readonly evidence?: string;
	/** Scope config file; absent means `<dataDir>/projects/<project>/scope.json`. */
	readonly scope?: string;
	readonly cwd: string;
};

/** The session port the shell hands the guard before the harness exists; attached once it does. */
function createDeferredSessionPort(): TgSecSessionPort & { attach(session: TgSecSessionPort): void } {
	let port: TgSecSessionPort | undefined;
	return {
		attach: (session) => {
			port = session;
		},
		snapshot: async <T extends JsonObject>(token: SessionDocToken<T>, context: Context) => {
			if (port === undefined) return undefined;
			return port.snapshot(token, context);
		},
		commit: async <T>(change: (tx: Tx) => T | Promise<T>, context: Context) => {
			if (port === undefined) throw new Error("tgsec: the session is not open yet");
			return port.commit(change, context);
		},
	};
}

/**
 * Script the local faux provider with one self-reappending echo factory: every turn answers from
 * the last user message, and `run <command>` exercises the real `bash` tool through the guard.
 * Appending the factory back keeps the demo alive for as many turns as the operator types; the
 * external smoke stops when it stops typing.
 */
function scriptFauxEcho(faux: FauxProviderHandle): void {
	let nextToolId = 0;
	const echo: FauxResponseFactory = (context) => {
		faux.appendResponses([echo]);
		const messages = context.messages;
		let lastUserIndex = -1;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			if (messages[index]?.role === "user") {
				lastUserIndex = index;
				break;
			}
		}
		const lastUser = lastUserIndex === -1 ? undefined : messages[lastUserIndex];
		const text = lastUser === undefined ? "" : contentText(lastUser.content).trim();
		const command = text.startsWith("run ") ? text.slice(4).trim() : "";
		// A tool result after the last user message means the command already ran; answering the
		// same call again would loop until the operator aborts.
		const answered = messages.slice(lastUserIndex + 1).some((message) => message.role === "toolResult");
		if (command !== "" && !answered) {
			nextToolId += 1;
			return fauxAssistantMessage(
				[
					fauxText("Running the local command with bash."),
					fauxToolCall("bash", { command }, { id: `faux-tool-${nextToolId}` }),
				],
				{ stopReason: "toolUse" },
			);
		}
		if (command !== "") {
			return fauxAssistantMessage(
				`faux command finished: ${command}\n\nThe bash tool ran through the guard; the result is above. The local faux provider has nothing more to add.`,
			);
		}
		return fauxAssistantMessage(
			`faux echo: ${text}\n\nThis is the local faux provider: no model is behind it and nothing leaves the machine. Run "tgsec login <provider>" and restart without --faux for a real conversation. Prefix a message with "run " to exercise the bash tool.`,
		);
	};
	faux.setResponses([echo]);
}

type TgSecTuiDeps = {
	readonly options: TgSecTuiOptions;
	readonly context: Context;
	readonly models: ReturnType<typeof createTgSecModels>;
	readonly modelRef: ModelRef;
	readonly modelName: string;
	/** False when the shell opened without a usable provider; the sentinel ref is carried until one is picked. */
	readonly modelSelected: boolean;
	/** The live judge model, kept in step with `/model` so `judge-auto` follows a switch. */
	readonly judgeRef: { ref: ModelRef };
	readonly store: TgSecEvidenceStore;
	readonly agent: SecAgent;
	readonly wiring: SecGuardWiring;
	readonly asks: TgSecAskController;
	readonly mode: TgSecPermissionMode;
	readonly scopePath: string;
	readonly faux: boolean;
	/** True when startup found faux test turns and started a clean context for the real model. */
	readonly fauxReset: boolean;
};

/** Best-effort cleanup: shutdown continues through a failing stage so the terminal is always restored. */
async function ignoreFailure(task: () => Promise<unknown>): Promise<void> {
	try {
		await task();
	} catch {
		// A shutdown stage that fails must not strand the alt screen; the next stage still runs.
	}
}

/**
 * The interactive tgsec shell: one campaign conversation on a real terminal, a transcript driven by
 * the agent event stream, the guard's asks as a modal prompt above the editor, and slash commands
 * for the session controls the runtime already exposes. All construction is the same production
 * path the smoke CLI uses; this class adds the screen, not a second runtime.
 */
export class TgSecTuiApp {
	private readonly options: TgSecTuiOptions;
	private readonly context: Context;
	private readonly models: ReturnType<typeof createTgSecModels>;
	private readonly store: TgSecEvidenceStore;
	private readonly agent: SecAgent;
	private readonly wiring: SecGuardWiring;
	private readonly asks: TgSecAskController;
	private readonly scopePath: string;
	private readonly faux: boolean;
	private readonly fauxReset: boolean;
	private readonly judgeRef: { ref: ModelRef };

	private readonly terminal = new ProcessTerminal();
	private readonly tui = new TuiAltScreen(this.terminal, true);
	private readonly transcript = new TranscriptView();
	private readonly scroll = new ScrollView(this.transcript, { follow: "end", primary: true, scrollbar: "auto" });
	private readonly status: StatusBar;
	private readonly askBar = new AskBar();
	private readonly editor: Editor;

	private modelRef: ModelRef;
	private modelName: string;
	private modelSelected: boolean;
	private mode: TgSecPermissionMode;
	private busy = false;
	private usage: UsageState | undefined;
	private stream: { component: Text; message: AssistantMessage } | undefined;
	private readonly toolCards = new Map<string, ToolCard>();
	private observation: SecObservation | undefined;
	private inputDispose: (() => void) | undefined;
	private closing: Promise<void> | undefined;
	private readonly exited: Promise<void>;
	private exitResolve: () => void = () => {};
	private readonly onSignal = (): void => {
		void this.shutdown("signal");
	};

	constructor(deps: TgSecTuiDeps) {
		this.options = deps.options;
		this.context = deps.context;
		this.models = deps.models;
		this.store = deps.store;
		this.agent = deps.agent;
		this.wiring = deps.wiring;
		this.asks = deps.asks;
		this.scopePath = deps.scopePath;
		this.faux = deps.faux;
		this.fauxReset = deps.fauxReset;
		this.judgeRef = deps.judgeRef;
		this.modelRef = deps.modelRef;
		this.modelName = deps.modelName;
		this.modelSelected = deps.modelSelected;
		this.mode = deps.mode;
		this.exited = new Promise<void>((resolve) => {
			this.exitResolve = resolve;
		});
		this.status = new StatusBar({
			project: deps.options.project,
			lane: deps.options.lane,
			mode: deps.mode,
			model: this.modelLabel(),
			busy: false,
		});
		this.editor = new Editor(this.tui, tgSecEditorTheme, { paddingX: 1 });
	}

	/** Start the screen and event stream, then resolve when the operator leaves. */
	async run(): Promise<void> {
		try {
			this.layout();
			this.installInput();
			process.once("SIGINT", this.onSignal);
			process.once("SIGTERM", this.onSignal);

			const observation = await watchSecEvents({
				harness: this.agent.harness,
				conversationId: this.agent.root.id,
				context: this.context,
				onError: (error) => this.reportError(error),
			});
			this.observation = observation;
			this.rebuild(observation.snapshot);
			this.welcome();
			observation.on((events) => {
				try {
					this.handleEvents(events);
				} catch (error) {
					this.reportError(error);
				}
			});

			this.tui.start();
			observation.start();
			this.tui.setFocus(this.editor);
			this.tui.requestRender();
			await this.exited;
		} catch (error) {
			await this.shutdown("error");
			throw error;
		}
	}

	private layout(): void {
		const dock = new VStack(
			[
				{ component: this.status, basis: 1, minSize: 1, maxSize: 1, shrink: 0 },
				{ component: this.askBar, basis: "auto", minSize: 0 },
				{ component: this.editor, basis: "auto", minSize: 3 },
			],
			{ gap: 0 },
		);
		this.tui.setLayoutRoot(
			new VStack(
				[
					{ component: this.scroll, basis: 0, grow: 1, minSize: 1 },
					{ component: dock, basis: "auto", minSize: 4 },
				],
				{ gap: 0 },
			),
		);
	}

	private installInput(): void {
		this.editor.onSubmit = (text: string) => {
			this.editor.addToHistory(text);
			void this.handleSubmit(text);
		};
		this.inputDispose = this.tui.addInputListener((data) => this.handleInput(data));
		this.asks.onChange(() => this.refreshAskBar());
	}

	private handleInput(data: string): TuiInputListenerResult {
		if (isKeyRelease(data)) return undefined;
		// An overlay owns the keyboard: it must see escape, ctrl+c and enter before the ask/quit paths.
		if (this.tui.hasOverlay()) return undefined;
		const pending = this.asks.pending();
		if (pending !== undefined) {
			if (matchesKey(data, "ctrl+c")) {
				const denied = this.asks.denyAll();
				this.note(`denied ${denied} pending guard ask(s)`, "warn");
				this.refreshAskBar();
				return { consume: true };
			}
			const token = data.toLowerCase();
			if (token === "y") this.answerAsk("allow");
			else if (token === "n") this.answerAsk("deny");
			else if (token === "a") this.answerAsk("always");
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			this.interrupt();
			return { consume: true };
		}
		return undefined;
	}

	private answerAsk(reply: "allow" | "deny" | "always"): void {
		const pending = this.asks.pending();
		if (pending === undefined) return;
		this.asks.answer(reply);
		const label = reply === "allow" ? "allowed once" : reply === "always" ? "always allowed" : "denied";
		this.note(`guard ask ${pending.request.toolName}: ${label}`, reply === "deny" ? "warn" : "dim");
		this.refreshAskBar();
	}

	private interrupt(): void {
		if (!this.busy) {
			void this.shutdown("ctrl+c");
			return;
		}
		this.note("aborting the running turn", "warn");
		void this.agent.root.abort(this.context).catch((error: unknown) => this.reportError(error));
	}

	private refreshAskBar(): void {
		const pending = this.asks.pending();
		this.askBar.setPrompt(
			pending === undefined
				? undefined
				: {
						toolName: pending.request.toolName,
						reason: pending.decision.reason,
						forced: pending.decision.forced,
						queued: this.asks.queued,
					},
		);
		this.tui.requestRender();
	}

	private modelLabel(): string {
		return this.modelSelected ? formatModelRef(this.modelRef) : "no model";
	}

	private refreshStatus(): void {
		this.status.setState({
			mode: this.mode,
			model: this.modelLabel(),
			busy: this.busy,
			usage: this.usage,
		});
		this.tui.requestRender();
	}

	private note(text: string, tone: "dim" | "warn" | "error" | "success" | "plain" = "plain"): void {
		const paint =
			tone === "warn"
				? tgSecStyle.yellow
				: tone === "error"
					? tgSecStyle.red
					: tone === "success"
						? tgSecStyle.green
						: tone === "dim"
							? tgSecStyle.dim
							: (value: string) => value;
		this.transcript.append(new Text(paint(text), 1, 0));
		this.tui.requestRender();
	}

	private reportError(error: unknown): void {
		this.note(error instanceof Error ? error.message : String(error), "error");
	}

	private welcome(): void {
		const model = this.modelSelected ? `${formatModelRef(this.modelRef)} (${this.modelName})` : "no model";
		const lines = [
			tgSecStyle.bold(tgSecStyle.cyan("TianGong sec-agent TUI")),
			`project=${this.options.project}  lane=${this.options.lane}  mode=${this.mode}  model=${model}`,
			`scope: ${this.scopePath}`,
			"only hosts registered in the scope file are reachable; a missing file makes every connection target a forced ask",
		];
		if (!this.modelSelected) {
			lines.push("no model yet: /connect signs in to a provider, then /models picks one");
		}
		if (this.fauxReset) {
			lines.push(
				"the saved conversation contained local faux test turns; started a fresh context (the transcript above is history, not model context) so a real model does not continue them",
			);
		}
		if (this.faux) {
			lines.push(
				'faux mode: local echo model, no credentials and no egress; prefix a message with "run " to call bash',
			);
		}
		lines.push("/help for commands; ctrl+c aborts a run or quits when idle");
		this.transcript.append(new Text(lines.join("\n"), 1, 0));
	}

	private async handleSubmit(text: string): Promise<void> {
		const trimmed = text.trim();
		if (trimmed === "") return;
		if (trimmed.startsWith("/")) {
			try {
				await this.handleSlash(trimmed);
			} catch (error) {
				this.reportError(error);
			}
			return;
		}
		if (!this.modelSelected) {
			this.noteNoModel();
			return;
		}
		this.busy = true;
		this.refreshStatus();
		try {
			await this.agent.root.submit({ type: "input", content: text, whenBusy: "followUp" }, this.context);
		} catch (error) {
			this.busy = false;
			this.refreshStatus();
			this.reportError(error);
		}
	}

	private async handleSlash(input: string): Promise<void> {
		const body = input.slice(1);
		const boundary = body.search(/\s/u);
		const command = (boundary === -1 ? body : body.slice(0, boundary)).toLowerCase();
		const rest = boundary === -1 ? "" : body.slice(boundary + 1).trim();
		switch (command) {
			case "help":
				this.note(HELP, "dim");
				return;
			case "quit":
			case "exit":
			case "q":
				await this.shutdown("slash");
				return;
			case "mode":
				await this.switchMode(rest);
				return;
			case "connect":
				await this.connectProvider();
				return;
			case "model":
				await this.switchModel(rest);
				return;
			case "models":
				await this.openModelPicker(rest);
				return;
			case "scope":
				this.note(
					`scope config: ${this.scopePath}\nentry shape: [{"kind":"exact-host","pattern":"example.com","effect":"allow","enabled":true}]`,
					"dim",
				);
				return;
			case "clear":
				await this.agent.root.reset(undefined, this.context);
				this.note("context reset requested", "dim");
				return;
			case "compact": {
				if (!this.modelSelected) {
					this.noteNoModel();
					return;
				}
				await this.agent.root.compact(rest === "" ? undefined : rest, this.context);
				this.note("compaction requested", "dim");
				return;
			}
			case "usage":
				this.note(formatUsage(this.usage ?? (await this.agent.harness.usage(this.context))), "dim");
				return;
			default:
				this.note(`unknown command /${command}; /help lists the commands`, "warn");
		}
	}

	private async switchMode(spec: string): Promise<void> {
		if (spec === "") {
			this.note(`mode: ${this.mode} (strict, judge-auto, auto, yolo)`, "dim");
			return;
		}
		if (!isTgSecMode(spec)) {
			this.note(`unknown mode ${JSON.stringify(spec)}; use strict, judge-auto, auto, or yolo`, "error");
			return;
		}
		await this.wiring.guard.switchMode(spec, "tgsec", this.context);
		this.mode = spec;
		this.refreshStatus();
		this.note(`mode switched to ${spec}`, "success");
	}

	private noteNoModel(): void {
		this.note("no model selected: /connect signs in to a provider, then /models picks one", "warn");
	}

	private refuseWhileBusy(command: string): boolean {
		if (!this.busy) return false;
		this.note(
			`${command} is unavailable while a turn is running; wait for it to finish or abort with ctrl+c`,
			"warn",
		);
		return true;
	}

	/** The one place a model becomes the session model: root conversation, judge, status and preference. */
	private async applyModel(ref: ModelRef, name: string, note: string): Promise<void> {
		const fauxReset = await resetFauxContext(this.agent.root, ref, this.context);
		await this.agent.root.configure({ model: ref }, this.context);
		this.judgeRef.ref = ref;
		this.modelRef = ref;
		this.modelName = name;
		this.modelSelected = true;
		await writeTgSecModelConfig(ref);
		this.refreshStatus();
		this.note(fauxReset ? `${note}; faux test turns removed from the context` : note, "success");
	}

	private async choosePickedModel(ref: ModelRef, name: string): Promise<void> {
		try {
			await this.applyModel(ref, name, `model switched to ${formatModelRef(ref)} (${name}) and remembered`);
		} catch (error) {
			this.reportError(error);
		}
	}

	private async switchModel(spec: string): Promise<void> {
		if (spec === "") {
			await this.openModelPicker("");
			return;
		}
		const ref = parseModelSpec(spec);
		if (ref === undefined) {
			this.note(`model spec ${JSON.stringify(spec)} must be provider/modelId`, "error");
			return;
		}
		const model = await findAvailableModel(this.models, ref);
		if (model === undefined) {
			this.note(
				`model ${formatModelRef(ref)} is not available: provider ${JSON.stringify(ref.provider)} is not authenticated or does not offer it`,
				"error",
			);
			return;
		}
		await this.choosePickedModel(ref, model.name);
	}

	private async openModelPicker(query: string): Promise<void> {
		if (this.refuseWhileBusy("/models")) return;
		const available = await this.models.getAvailable();
		if (available.length === 0) {
			this.note("no authenticated models: use /connect to sign in to a provider, or start with --faux", "warn");
			return;
		}
		const current = this.modelSelected ? formatModelRef(this.modelRef) : undefined;
		let handle: OverlayHandle | undefined;
		const picker = new Picker({
			title: `models (${available.length})`,
			items: available,
			query,
			getText: (model) => `${model.provider}/${model.id}`,
			getDescription: (model) => {
				const label = `${model.provider}/${model.id}`;
				return label === current ? `${model.name} (current)` : model.name;
			},
			onSelect: (model) => {
				handle?.hide();
				handle = undefined;
				void this.choosePickedModel({ provider: model.provider, modelId: model.id }, model.name);
			},
			onCancel: () => {
				handle?.hide();
				handle = undefined;
			},
		});
		handle = this.tui.showOverlay(picker, { anchor: "center", width: "80%", maxHeight: "60%" });
	}

	private async connectProvider(): Promise<void> {
		if (this.refuseWhileBusy("/connect")) return;
		const options = await buildConnectOptions(this.models);
		if (options.length === 0) {
			this.note(
				"no provider in this build offers interactive login; set its environment variable or use --faux",
				"warn",
			);
			return;
		}
		let handle: OverlayHandle | undefined;
		const picker = new Picker<ConnectOption>({
			title: "connect a provider",
			items: options,
			getText: connectOptionLabel,
			getDescription: (option) => `${option.authType} - ${option.status}`,
			onSelect: (option) => {
				handle?.hide();
				handle = undefined;
				void this.runLogin(option);
			},
			onCancel: () => {
				handle?.hide();
				handle = undefined;
			},
		});
		handle = this.tui.showOverlay(picker, { anchor: "center", width: "80%", maxHeight: "60%" });
	}

	private async runLogin(option: ConnectOption): Promise<void> {
		const controller = new AbortController();
		let dialogHandle: OverlayHandle | undefined;
		let selectHandle: OverlayHandle | undefined;
		const dialog = new LoginDialog({
			title: `connect ${option.providerName}`,
			onCancel: () => controller.abort(new Error("login cancelled")),
			requestRender: () => this.tui.requestRender(),
		});
		dialogHandle = this.tui.showOverlay(dialog, { anchor: "center", width: "80%", maxHeight: "70%" });
		const interaction: AuthInteraction = {
			signal: controller.signal,
			prompt: (prompt) => {
				if (prompt.type !== "select") return dialog.ask(prompt);
				return new Promise<string>((resolve, reject) => {
					const picker = new Picker({
						title: prompt.message,
						items: prompt.options,
						getText: (entry) => entry.label,
						getDescription: (entry) => entry.description,
						onSelect: (entry) => {
							selectHandle?.hide();
							selectHandle = undefined;
							resolve(entry.id);
						},
						onCancel: () => {
							selectHandle?.hide();
							selectHandle = undefined;
							const reason = new Error("selection cancelled");
							reject(reason);
							controller.abort(reason);
						},
					});
					selectHandle = this.tui.showOverlay(picker, { anchor: "center", width: "60%", maxHeight: "50%" });
					const cancel = () => {
						selectHandle?.hide();
						selectHandle = undefined;
						reject(prompt.signal?.reason ?? new Error("prompt cancelled"));
					};
					if (prompt.signal?.aborted === true) cancel();
					else prompt.signal?.addEventListener("abort", cancel, { once: true });
				});
			},
			notify: (event) => dialog.notify(event),
		};
		try {
			const deviceId = await readOrCreateDeviceId();
			await this.models.login(option.providerId, option.authType, interaction, {
				getDeviceId: () => deviceId,
				agentName: "TianGong",
			});
			dialog.finish();
			dialogHandle?.hide();
			dialogHandle = undefined;
			this.note(`connected ${option.providerName} (${option.authType})`, "success");
			await this.afterConnect(option);
		} catch (error) {
			dialog.cancelPending(error);
			dialog.finish();
			dialogHandle?.hide();
			dialogHandle = undefined;
			selectHandle?.hide();
			selectHandle = undefined;
			if (controller.signal.aborted) this.note("login cancelled", "dim");
			else this.reportError(error);
		}
	}

	/** Refresh the catalog after a login and pick a first model when the shell still has none. */
	private async afterConnect(option: ConnectOption): Promise<void> {
		const refreshed = await this.models
			.refresh({
				providers: [option.providerId],
				allowNetwork: true,
				force: true,
				signal: AbortSignal.timeout(15_000),
			})
			.catch((error: unknown) => {
				this.note(
					`provider refresh failed: ${error instanceof Error ? error.message : String(error)}; using the last known catalog`,
					"dim",
				);
				return undefined;
			});
		if (refreshed !== undefined && refreshed.errors.size > 0) {
			this.note(`provider refresh reported ${refreshed.errors.size} error(s); using the last known catalog`, "dim");
		}
		if (this.modelSelected && !isFauxModelRef(this.modelRef)) return;
		const fromProvider = await this.models.getAvailable(option.providerId);
		const first =
			fromProvider[0] ?? (await this.models.getAvailable()).find((model) => model.provider !== FAUX_PROVIDER_ID);
		if (first === undefined) {
			this.note("connected, but no chat model is available yet; use /models once the catalog refreshes", "warn");
			return;
		}
		const ref = { provider: first.provider, modelId: first.id };
		await this.choosePickedModel(ref, first.name);
	}

	private handleEvents(events: readonly AgentEvent[]): void {
		for (const event of events) this.handleEvent(event);
		this.refreshStatus();
	}

	private handleEvent(event: AgentEvent): void {
		switch (event.type) {
			case "snapshot":
				this.rebuild(event);
				return;
			case "run_start":
				this.busy = true;
				return;
			case "run_end":
				this.busy = false;
				return;
			case "message_start":
				if (event.message.role === "assistant") this.beginStream(event.message);
				return;
			case "message_update":
				this.applyStreamChanges(event.changes);
				return;
			case "message_end":
				this.renderEntry(event.entry);
				return;
			case "tool_execution_start":
				this.ensureToolCard(event.toolCallId, event.toolName, event.args);
				return;
			case "tool_execution_update": {
				if (event.output !== undefined) this.toolCards.get(event.toolCallId)?.applyOutput(event.output);
				return;
			}
			case "tool_execution_end": {
				const message = event.entry?.model?.[0];
				if (message?.role === "toolResult") this.attachToolResult(message);
				const card = this.toolCards.get(event.toolCallId);
				if (card !== undefined)
					card.finish(event.entry === undefined || message?.role !== "toolResult" || message.isError);
				return;
			}
			case "entry_appended":
				this.renderEntry(event.entry);
				return;
			case "auto_retry_start": {
				const seconds = Math.max(0, Math.round((event.at - Date.now()) / 1000));
				this.note(`provider retry ${event.attempt} in ~${seconds}s: ${event.errorMessage}`, "warn");
				return;
			}
			case "auto_retry_end":
				this.note(`provider retry ${event.attempt} ended`, "dim");
				return;
			case "deferred_poll":
				this.note("provider is deferred; the harness will poll again", "dim");
				return;
			case "task_failed":
				this.note(`task ${event.kind} failed: ${event.message}`, "error");
				return;
			case "compaction_start":
				this.note(`compaction started (${event.reason}${event.blocking ? ", blocking" : ""})`, "dim");
				return;
			case "compaction_end":
				this.note(
					event.error === undefined
						? `compaction finished (${event.reason})`
						: `compaction failed (${event.reason}): ${event.error}`,
					event.error === undefined ? "dim" : "error",
				);
				return;
			case "usage_changed":
				this.usage = event.usage;
				return;
			case "agent_changed": {
				const model = event.agent.model;
				if (model === undefined || isUnconfiguredModel(model)) {
					this.modelSelected = false;
					this.modelRef = UNCONFIGURED_MODEL;
					this.judgeRef.ref = UNCONFIGURED_MODEL;
					return;
				}
				this.modelRef = model;
				this.modelSelected = true;
				this.judgeRef.ref = model;
				const registered = this.models.getModel(model.provider, model.modelId);
				if (registered !== undefined) this.modelName = registered.name;
				return;
			}
			case "submission":
			case "inbox_update":
			case "turn_start":
			case "turn_end":
				return;
		}
	}

	private rebuild(snapshot: SnapshotEvent): void {
		this.transcript.clear();
		this.toolCards.clear();
		this.stream = undefined;
		for (const entry of snapshot.entries) this.renderEntry(entry);
		for (const slot of snapshot.tools) {
			const card = this.ensureToolCard(slot.callId, slot.name, {});
			if (slot.output !== undefined) card.setOutput(slot.output);
			if (slot.status === "done" && card.getStatus() === "running") card.finish(false);
		}
		if (snapshot.generation?.message !== undefined) this.beginStream(snapshot.generation.message);
		this.busy = snapshot.run !== undefined;
		this.usage = snapshot.usage;
	}

	private renderEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if (entry.kind === "tg.reset") {
			this.note("context reset", "dim");
			if (message?.role === "user") this.addUser(message);
			return;
		}
		if (entry.kind === "tg.compaction") {
			this.note("compaction summary added to the context", "dim");
			return;
		}
		if (entry.kind === "tg.system") return;
		if (message === undefined) {
			this.note(`[${entry.kind}]`, "dim");
			return;
		}
		if (message.role === "user") {
			this.addUser(message);
			return;
		}
		if (message.role === "assistant") {
			this.addAssistant(message);
			return;
		}
		if (message.role === "toolResult") {
			this.attachToolResult(message);
			return;
		}
		this.note(`[${message.role}]`, "dim");
	}

	private addUser(message: UserMessage): void {
		const text = contentText(message.content).trim();
		const images = Array.isArray(message.content)
			? message.content.filter((block) => block.type === "image").length
			: 0;
		if (text === "" && images === 0) return;
		const body = images === 0 ? text : `${text}${text === "" ? "" : "\n"}[${images} image(s) attached]`;
		this.transcript.append(userMessageText(body));
	}

	private addAssistant(message: AssistantMessage): void {
		const blocks = assistantMessageBlocks(message);
		if (this.stream !== undefined) {
			this.transcript.replace(this.stream.component, ...blocks);
			this.stream = undefined;
		} else if (blocks.length > 0) {
			for (const block of blocks) this.transcript.append(block);
		}
		for (const block of message.content) {
			if (block.type === "toolCall") this.ensureToolCard(block.id, block.name, block.arguments);
		}
		if (blocks.length === 0 && !message.content.some((block) => block.type === "toolCall")) {
			this.note("(empty assistant message)", "dim");
		}
	}

	private beginStream(message: AssistantMessage): void {
		if (this.stream !== undefined) this.transcript.removeBlock(this.stream.component);
		const component = new Text("", 1, 0);
		const snapshot: AssistantMessage = { ...message, content: [...message.content] };
		component.setText(assistantPartialText(snapshot));
		this.stream = { component, message: snapshot };
		this.transcript.append(component);
	}

	private applyStreamChanges(changes: readonly MessageChange[]): void {
		const stream = this.stream;
		if (stream === undefined) return;
		let content = [...stream.message.content];
		for (const change of changes) {
			switch (change.type) {
				case "text_start":
				case "thinking_start":
				case "toolcall_start":
				case "block":
					content[change.contentIndex] = change.block;
					break;
				case "text_delta": {
					const block = content[change.contentIndex];
					if (block?.type === "text") content[change.contentIndex] = { ...block, text: block.text + change.delta };
					break;
				}
				case "thinking_delta": {
					const block = content[change.contentIndex];
					if (block?.type === "thinking") {
						content[change.contentIndex] = { ...block, thinking: block.thinking + change.delta };
					}
					break;
				}
				case "toolcall_delta":
					break;
				case "message":
					content = [...change.message.content];
					stream.message = { ...change.message, content };
					stream.component.setText(assistantPartialText(stream.message));
					return;
			}
		}
		stream.message = { ...stream.message, content };
		stream.component.setText(assistantPartialText(stream.message));
	}

	private attachToolResult(message: ToolResultMessage): void {
		const card = this.ensureToolCard(message.toolCallId, message.toolName, {});
		const text = toolResultText(message.content);
		card.setOutput(text);
		card.finish(message.isError);
	}

	private ensureToolCard(callId: string, name: string, args: Record<string, unknown>): ToolCard {
		const existing = this.toolCards.get(callId);
		if (existing !== undefined) {
			existing.setArgs(args);
			return existing;
		}
		const card = new ToolCard(callId, name, args);
		this.toolCards.set(callId, card);
		this.transcript.append(card);
		return card;
	}

	/** Leave the screen only after the run is withdrawn; every stage is best-effort. */
	private shutdown(_reason: string): Promise<void> {
		this.closing ??= this.doShutdown();
		return this.closing;
	}

	private async doShutdown(): Promise<void> {
		this.asks.close();
		this.inputDispose?.();
		this.inputDispose = undefined;
		process.off("SIGINT", this.onSignal);
		process.off("SIGTERM", this.onSignal);
		await ignoreFailure(() => this.agent.root.abort(this.context));
		if (this.observation !== undefined) await ignoreFailure(() => this.observation!.stop());
		await ignoreFailure(() => this.agent.close(this.context));
		await ignoreFailure(() => this.store.close());
		await ignoreFailure(async () => this.tui.stop());
		this.exitResolve();
	}
}

/**
 * Build the interactive campaign the same way the smoke CLI does: real SQLite, the guard with a
 * live session port, the forensic tool surface, and the event stream. The returned app owns the
 * terminal; the caller runs it and awaits the operator's exit.
 */
export async function openTgSecTui(options: TgSecTuiOptions): Promise<TgSecTuiApp> {
	const context = BACKGROUND_CONTEXT;
	const telemetry = new InMemoryTelemetryContext();
	const models = createTgSecModels();
	if (options.faux === true) {
		const faux = fauxProvider();
		models.setProvider(faux.provider);
		scriptFauxEcho(faux);
	}
	const resolved = await tryResolveTgSecModel(models, {
		...(options.faux === true
			? { explicit: "faux/faux-1" }
			: options.model === undefined
				? {}
				: { explicit: options.model }),
	});
	const modelRef = resolved?.ref ?? UNCONFIGURED_MODEL;
	const modelName = resolved?.model.name ?? "no model";
	const judgeRef: { ref: ModelRef } = { ref: modelRef };
	const dataDir = tgSecDataDir();
	const databasePath = options.db ?? (options.faux === true ? fauxDatabasePath(options.project, dataDir) : undefined);
	const store = await openTgSecEvidenceStore({ dir: options.evidence ?? evidenceDir(options.project), telemetry });
	const scopePath = options.scope ?? join(dataDir, "projects", safeProjectSegment(options.project), "scope.json");
	const asks = createTgSecAskController();
	const session = createDeferredSessionPort();
	let registeredTools: readonly string[] = [];
	let agent: SecAgent | undefined;
	try {
		const scopeRegistry = await loadTgSecScopeRegistry(scopePath);
		const wiring = await buildSecGuard({
			session,
			lane: options.lane,
			context,
			...(options.mode === undefined ? {} : { mode: options.mode }),
			scopeRegistry,
			judgeModel: { models, model: modelRef, resolveModel: () => judgeRef.ref },
			askChannel: asks.ask,
			telemetry,
			attestParts: {
				forbiddenRead: secAttestForbiddenRead(join(dataDir, "attest")),
				registeredTools: () => registeredTools,
				declaredTools: secDeclaredTools(options.lane),
			},
		});
		const policies: Record<SecAgentLane, TaskChildPolicy> = {
			redteam: { extensions: ["sec-core"] },
			ctf: { extensions: ["sec-core"] },
			src: { extensions: ["sec-core"] },
		};
		const core = createSecCoreExtension({ lane: options.lane, wiring, policies, telemetry });
		const secTools = createSecToolsExtension({ store, executor: nodeRequestExecutor() });
		agent = await openSecAgent({
			context,
			project: options.project,
			lane: options.lane,
			models,
			model: modelRef,
			cwd: options.cwd,
			...(databasePath === undefined ? {} : { path: databasePath }),
			extensions: [core, secTools],
		});
		session.attach(agent.harness);
		// `root()` only applies its agent on creation, so a restart must reconcile the stored model
		// with what this run resolved (or with "nothing chosen yet").
		const stored = (await agent.root.agent(context)).model;
		if (resolved !== undefined) {
			if (
				stored === undefined ||
				stored.provider !== resolved.ref.provider ||
				stored.modelId !== resolved.ref.modelId
			) {
				await agent.root.configure({ model: resolved.ref }, context);
			}
		} else if (stored !== undefined && !isUnconfiguredModel(stored)) {
			await agent.root.configure({ model: null }, context);
		}
		const fauxReset = await resetFauxContext(agent.root, resolved?.ref, context);
		registeredTools = agent.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		const persisted = await readTgSecMode(agent.harness, context);
		if (options.mode !== undefined && persisted !== options.mode) {
			await wiring.guard.switchMode(options.mode, "tgsec", context);
		}
		return new TgSecTuiApp({
			options,
			context,
			models,
			modelRef,
			modelName,
			modelSelected: resolved !== undefined,
			judgeRef,
			store,
			agent,
			wiring,
			asks,
			mode: options.mode ?? persisted,
			scopePath,
			faux: options.faux === true,
			fauxReset,
		});
	} catch (error) {
		asks.close();
		const opened = agent;
		if (opened !== undefined) await ignoreFailure(() => opened.close(context));
		await ignoreFailure(() => store.close());
		throw error;
	}
}

/** The lane values the CLI accepts. */
export function isSecTuiLane(value: string): value is SecAgentLane {
	return (LANES as readonly string[]).includes(value);
}
