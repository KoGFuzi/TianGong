#!/usr/bin/env bun

import type { Context } from "@OnePanda-TgSec/chord";
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@OnePanda-TgSec/tg-ai";
import type { JsonObject, SessionDocToken, Tx } from "@OnePanda-TgSec/tg-gibraltar";
import {
	createTgSecScopeRegistry,
	readTgSecMode,
	type TgSecPermissionMode,
	type TgSecSessionPort,
} from "@OnePanda-TgSec/tg-sec-guard";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { createStdinAskChannel } from "../ask.ts";
import type { SecAgent } from "../bootstrap.ts";
import { openSecAgent, type SecAgentLane } from "../bootstrap.ts";
import { createSecCoreExtension } from "../core-extension.ts";
import { openTgSecEvidenceStore } from "../evidence/store.ts";
import { buildSecGuard, secAttestForbiddenRead, secDeclaredTools } from "../guard-wiring.ts";
import { watchSecEvents } from "../observation.ts";
import type { TaskChildPolicy } from "../task-tool.ts";
import { createSecToolsExtension } from "../tools/extension.ts";
import type { HttpRequest, HttpResponse, RequestExecutor } from "../tools/transport.ts";
import { oauthProviderNames, runAuthCommand } from "./auth.ts";
import { isServeLane, isServeMode, runServeCommand, type ServeOptions } from "./serve.ts";

/** The session port the CLI hands the guard before the harness exists; attached once it does. */
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
			if (port === undefined) throw new Error("tg-sec: the session is not open yet");
			return port.commit(change, context);
		},
	};
}

const LANES: readonly string[] = ["redteam", "ctf", "src"];
const MODES: readonly string[] = ["strict", "judge-auto", "auto", "yolo"];

/** The reserved in-scope host the smoke's scripted `http_request` targets, so it never needs a live human. */
const SMOKE_HOST = "smoke.invalid";

/** A transport that never touches the wire: the smoke proves the tool→store→span path without any egress. */
const smokeExecutor: RequestExecutor = {
	async send(request: HttpRequest): Promise<HttpResponse> {
		return {
			status: 200,
			headers: { "content-type": "text/plain", server: "tg-sec-smoke" },
			body: Buffer.from(`smoke response to ${request.method} ${request.url}`, "utf8"),
			contentType: "text/plain",
		};
	},
};

function isLane(value: string): value is SecAgentLane {
	return LANES.includes(value);
}

function isMode(value: string): value is TgSecPermissionMode {
	return MODES.includes(value);
}

type CliOptions = {
	project: string;
	lane: SecAgentLane;
	mode: TgSecPermissionMode;
	db?: string;
	evidence?: string;
	cwd: string;
	input: string;
};

function usage(): string {
	const providers = oauthProviderNames().join("\n");
	return `usage:
  tg-sec login [provider]   Login to an OAuth provider
  tg-sec list               List OAuth providers
  tg-sec serve [options]    Open the campaign WebUI sidecar
  tg-sec [options]          Run the smoke turn

serve options:
  --project <name>          Campaign project (default: main)
  --lane redteam|ctf|src    Campaign lane (default: redteam)
  --mode strict|judge-auto|auto|yolo
                            Permission mode (default: the persisted tg.sec.mode, else auto)
  --model <provider/model>  Model to run (default: TG_SEC_MODEL, the remembered model,
                            then the first authenticated model)
  --faux                    Local echo model: no credentials, no egress
  --host <address>          Bind address (default: 127.0.0.1)
  --port <number>           Port (default: 0, the OS picks a free one)
  --target <name>           Display name of the campaign target (default: the project)
  --db <file>               SQLite file (default: per-project XDG path)
  --evidence <dir>          Evidence directory (default: per-project XDG path)
  --scope <file>            Scope config (default: <data>/projects/<project>/scope.json)

smoke options:
  --project <name>          Campaign project (default: smoke)
  --lane redteam|ctf|src    Campaign lane (default: redteam)
  --mode strict|judge-auto|auto|yolo
                            Permission mode (default: strict)
  --db <file>               SQLite file (default: per-project XDG path)
  --evidence <dir>          Evidence directory (prints a summary when set)
  --input <text>            Smoke turn input

OAuth providers:
${providers}
`;
}

function parseArgs(argv: readonly string[]): CliOptions {
	let project = "smoke";
	let lane: SecAgentLane = "redteam";
	let mode: TgSecPermissionMode = "strict";
	let db: string | undefined;
	let evidence: string | undefined;
	let input = "打印当前目录，然后报告完成。";
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (flag === "--help") {
			process.stdout.write(usage());
			process.exit(0);
		}
		if (flag === undefined || value === undefined)
			throw new TypeError(`tg-sec: ${flag ?? "positional"} needs a value`);
		index += 1;
		if (flag === "--project") project = value;
		else if (flag === "--db") db = value;
		else if (flag === "--evidence") evidence = value;
		else if (flag === "--input") input = value;
		else if (flag === "--lane" && isLane(value)) lane = value;
		else if (flag === "--mode" && isMode(value)) mode = value;
		else throw new TypeError(`tg-sec: unknown argument ${flag}`);
	}
	return {
		project,
		lane,
		mode,
		...(db === undefined ? {} : { db }),
		...(evidence === undefined ? {} : { evidence }),
		cwd: process.cwd(),
		input,
	};
}

function parseServeArgs(argv: readonly string[]): ServeOptions | undefined {
	let project = "main";
	let lane: SecAgentLane = "redteam";
	let mode: TgSecPermissionMode | undefined;
	let model: string | undefined;
	let faux = false;
	let db: string | undefined;
	let evidence: string | undefined;
	let scope: string | undefined;
	let host: string | undefined;
	let port: number | undefined;
	let target: string | undefined;

	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--help" || flag === "-h") {
			process.stdout.write(usage());
			return undefined;
		}
		if (flag === "--faux") {
			faux = true;
			continue;
		}
		const value = argv[index + 1];
		if (flag === undefined || value === undefined)
			throw new TypeError(`tg-sec serve: ${flag ?? "positional"} needs a value`);
		index += 1;
		switch (flag) {
			case "--project":
				project = value;
				break;
			case "--lane":
				if (!isServeLane(value)) throw new TypeError(`tg-sec serve: unknown lane ${JSON.stringify(value)}`);
				lane = value;
				break;
			case "--mode":
				if (!isServeMode(value)) throw new TypeError(`tg-sec serve: unknown mode ${JSON.stringify(value)}`);
				mode = value;
				break;
			case "--model":
				model = value;
				break;
			case "--db":
				db = value;
				break;
			case "--evidence":
				evidence = value;
				break;
			case "--scope":
				scope = value;
				break;
			case "--host":
				host = value;
				break;
			case "--port": {
				const parsed = Number(value);
				if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
					throw new TypeError(`tg-sec serve: --port must be an integer in 0..65535, got ${JSON.stringify(value)}`);
				}
				port = parsed;
				break;
			}
			case "--target":
				target = value;
				break;
			default:
				throw new TypeError(`tg-sec serve: unknown argument ${flag}`);
		}
	}
	if (faux && model !== undefined) throw new TypeError("tg-sec serve: --faux cannot be combined with --model");
	return {
		project,
		lane,
		...(mode === undefined ? {} : { mode }),
		...(model === undefined ? {} : { model }),
		...(faux ? { faux: true } : {}),
		...(db === undefined ? {} : { db }),
		...(evidence === undefined ? {} : { evidence }),
		...(scope === undefined ? {} : { scope }),
		...(host === undefined ? {} : { host }),
		...(port === undefined ? {} : { port }),
		...(target === undefined ? {} : { target }),
		cwd: process.cwd(),
	};
}

/**
 * Batch-3 smoke entry (`tg-sec`): open the campaign for real — SQLite storage, guard wiring, the
 * core extension — and run one scripted faux turn that calls `bash`, so the first `beforeTool`
 * triggers the full fail-closed attestation and a `strict` mode puts the call in front of the
 * stdin ask channel. Prints the event line stream and the session usage, then closes. This is a
 * smoke of the wiring, not the product shell: the faux script stands in for a provider so the run
 * costs no tokens and reads no keys.
 */
async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (command === "login" || command === "list") {
		await runAuthCommand(command, argv.slice(1));
		return;
	}
	if (command === "serve") {
		const serveOptions = parseServeArgs(argv.slice(1));
		if (serveOptions === undefined) return;
		await runServeCommand(serveOptions);
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(usage());
		return;
	}
	const options = parseArgs(argv);
	const context = BACKGROUND_CONTEXT;
	const print = (line: string) => process.stdout.write(`${line}\n`);
	const telemetry = new InMemoryTelemetryContext();
	const evidenceDir = options.evidence ?? `${options.cwd}/.tg-sec-smoke-evidence`;
	const store = await openTgSecEvidenceStore({ dir: evidenceDir, telemetry });

	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	const model = { provider: "faux", modelId: "faux-1" };
	// One scripted turn: `bash` triggers attestation, `tool_search` surfaces the deferred http tool, then
	// `http_request` captures an in-scope exchange as evidence. No response leaves the machine.
	faux.setResponses([
		fauxAssistantMessage([fauxText("先看一下目录"), fauxToolCall("bash", { command: "pwd" }, { id: "smoke-1" })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage(
			[fauxText("找 http 工具"), fauxToolCall("tool_search", { query: "http request" }, { id: "smoke-2" })],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(
			[
				fauxText("发一个请求并留证"),
				fauxToolCall(
					"http_request",
					{ url: `https://${SMOKE_HOST}/probe`, method: "GET", findingId: "cli-smoke-subject" },
					{ id: "smoke-3" },
				),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("冒烟回合完成。"),
	]);

	const session = createDeferredSessionPort();
	let registeredTools: readonly string[] = [];
	const scopeRegistry = createTgSecScopeRegistry([
		{ kind: "exact-host", pattern: SMOKE_HOST, effect: "allow", enabled: true },
	]);
	const wiring = await buildSecGuard({
		session,
		lane: options.lane,
		context,
		mode: options.mode,
		scopeRegistry,
		judgeModel: { models, model },
		askChannel: createStdinAskChannel(),
		telemetry,
		attestParts: {
			forbiddenRead: secAttestForbiddenRead(`${options.cwd}/.tg-sec-smoke-data`),
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
	const secTools = createSecToolsExtension({ store, executor: smokeExecutor });

	const agent: SecAgent = await openSecAgent({
		context,
		project: options.project,
		lane: options.lane,
		models,
		model,
		cwd: options.cwd,
		...(options.db === undefined ? {} : { path: options.db }),
		extensions: [core, secTools],
	});
	session.attach(agent.harness);
	registeredTools = agent.registry
		.snapshot()
		.tools()
		.map((entry) => entry.tool.name);
	// The guard re-reads `tg.sec.mode` live on every call; persist the CLI mode when it differs so
	// the cached construction mode and the document agree.
	if ((await readTgSecMode(agent.harness, context)) !== options.mode) {
		await wiring.guard.switchMode(options.mode, "tg-sec cli", context);
	}

	print(`tg-sec smoke: project=${options.project} lane=${options.lane} mode=${options.mode}`);
	print(`attestation runs inside the first beforeTool; a failed probe blocks that call (fail-closed)`);

	const observation = await watchSecEvents({ harness: agent.harness, conversationId: agent.root.id, context });
	observation.on((events) => {
		for (const event of events) {
			if (event.type === "message_end") {
				const message = event.entry.model?.[0];
				if (message?.role === "assistant") {
					const text = message.content
						.filter((block) => block.type === "text")
						.map((block) => block.text)
						.join("");
					print(`assistant: ${text}`);
				}
			} else if (event.type === "tool_execution_start") print(`tool start: ${event.toolName}`);
			else if (event.type === "tool_execution_end") print(`tool end: ${event.toolName}`);
			else if (event.type === "run_end") print(`run ended; open state ${JSON.stringify(observation.state())}`);
		}
	});
	observation.start();

	const submission = await agent.root.submit({ type: "input", content: options.input }, context);
	const settled = await submission.wait(context);
	await agent.root.waitForIdle(context);
	print(`submission ${settled.status}`);
	print(`usage: ${JSON.stringify(await agent.harness.usage(context))}`);

	if (options.evidence !== undefined) {
		const set = await store.list("cli-smoke-subject");
		const first = set.bindings[0];
		const captured = first === undefined ? "(none)" : first.snapshotId.slice(0, 12);
		print(
			`evidence smoke: ${set.bindings.length} snapshot(s) on cli-smoke-subject at version ${set.version}; first ${captured}`,
		);
	}

	const spanCounts = new Map<string, number>();
	for (const span of telemetry.getSpans()) spanCounts.set(span.name, (spanCounts.get(span.name) ?? 0) + 1);
	const summary = [...spanCounts].map(([name, count]) => `${name}=${count}`).join(" ");
	print(`spans: ${summary === "" ? "none" : summary}`);

	await observation.stop();
	await agent.close(context);
	await store.close();
}

main().catch((error: unknown) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exit(1);
});
