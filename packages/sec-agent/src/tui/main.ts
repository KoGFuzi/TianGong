#!/usr/bin/env bun

import type { ConversationId } from "@OnePanda-TgSec/tg-gibraltar";
import { isTgSecMode, type TgSecPermissionMode } from "@OnePanda-TgSec/tg-sec-guard";
import type { SecAgentLane } from "../bootstrap.ts";
import { runAuthCommand } from "../cli/auth.ts";
import { printHistory } from "../cli/history.ts";
import { runServeCommand, type ServeOptions } from "../cli/serve.ts";
import { isSecTuiLane, openTgSecTui, type TgSecTuiOptions } from "./app.ts";
import { createTgSecModels, formatModelRef } from "./model.ts";

function usage(): string {
	return `usage:
  tgsec [options]              open the interactive campaign shell (default)
  tgsec --webui [options]      open the campaign WebUI sidecar instead
  tgsec login [provider]       sign in to an OAuth provider
  tgsec list                   list OAuth providers
  tgsec models                 list authenticated models

options:
  --project <name>             campaign project (default: main)
  --lane redteam|ctf|src       campaign lane (default: redteam)
  --mode strict|judge-auto|auto|yolo
                               permission mode (default: the persisted tg.sec.mode, else auto)
  --model <provider/modelId>   model to use (default: TG_SEC_MODEL, then the remembered model,
                               then the first authenticated model; with none, the shell opens
                               without a model and waits for /connect and /models)
  --faux                       local echo model: no credentials, no egress, exercises the shell
  --db <file>                  SQLite file (default: per-project XDG path)
  --evidence <dir>             evidence directory (default: per-project XDG path)
  --scope <file>               scope config (default: <data>/projects/<project>/scope.json)

history options:
  --history                    print this project's history conversations and exit
  --session <id>               restore by forking this history conversation; it stays read-only
  --continue                   restore by forking the newest non-archived root conversation

webui options (with --webui):
  --host <address>             bind address (default: 127.0.0.1)
  --port <number>              port (default: 0, the OS picks a free one)
  --target <name>              display name of the campaign target (default: the project)

inside the shell: /help lists the commands; /connect signs in to a provider (OAuth or API key)
and /models picks an authenticated model; a guard ask is answered with y (once), n (deny),
a (always) or ctrl+c (deny all).
`;
}

/** Everything the `tgsec` entry accepts on the command line, before the frontend is chosen. */
type TgSecCliOptions = {
	readonly project: string;
	readonly lane: SecAgentLane;
	readonly mode?: TgSecPermissionMode;
	readonly model?: string;
	readonly faux?: boolean;
	readonly db?: string;
	readonly evidence?: string;
	readonly scope?: string;
	/** Open the campaign WebUI sidecar instead of the interactive shell. */
	readonly webui?: boolean;
	/** Print this project's history conversation table and exit without opening a frontend. */
	readonly history?: boolean;
	/** Restore from one history conversation instead of the reserved root. */
	readonly resume?: { readonly source: ConversationId | "latest" };
	/** WebUI bind address; loopback unless the operator names another interface. */
	readonly host?: string;
	/** WebUI port; 0 asks the OS for a free one. */
	readonly port?: number;
	/** WebUI display name of the campaign's root target; defaults to the project name. */
	readonly target?: string;
	readonly cwd: string;
};

function parseArgs(argv: readonly string[]): TgSecCliOptions | undefined {
	let project = "main";
	let lane: SecAgentLane = "redteam";
	let mode: TgSecPermissionMode | undefined;
	let model: string | undefined;
	let faux = false;
	let webui = false;
	let history = false;
	let db: string | undefined;
	let evidence: string | undefined;
	let scope: string | undefined;
	let session: ConversationId | undefined;
	let cont = false;
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
		if (flag === "--webui") {
			webui = true;
			continue;
		}
		if (flag === "--history") {
			history = true;
			continue;
		}
		if (flag === "--continue") {
			cont = true;
			continue;
		}
		const value = argv[index + 1];
		if (flag === undefined || value === undefined)
			throw new TypeError(`tgsec: ${flag ?? "positional"} needs a value`);
		index += 1;
		switch (flag) {
			case "--project":
				project = value;
				break;
			case "--lane":
				if (!isSecTuiLane(value)) throw new TypeError(`tgsec: unknown lane ${JSON.stringify(value)}`);
				lane = value;
				break;
			case "--mode":
				if (!isTgSecMode(value)) throw new TypeError(`tgsec: unknown mode ${JSON.stringify(value)}`);
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
					throw new TypeError(`tgsec: --port must be an integer in 0..65535, got ${JSON.stringify(value)}`);
				}
				port = parsed;
				break;
			}
			case "--target":
				target = value;
				break;
			case "--session": {
				const parsed = Number(value);
				if (!Number.isSafeInteger(parsed) || parsed < 1) {
					throw new TypeError(`tgsec: --session must be a positive integer, got ${JSON.stringify(value)}`);
				}
				session = parsed as ConversationId;
				break;
			}
			default:
				throw new TypeError(`tgsec: unknown argument ${flag}`);
		}
	}
	if (faux && model !== undefined) throw new TypeError("tgsec: --faux cannot be combined with --model");
	if (history && faux) throw new TypeError("tgsec: --history cannot be combined with --faux");
	if (history && session !== undefined) throw new TypeError("tgsec: --history cannot be combined with --session");
	if (history && cont) throw new TypeError("tgsec: --history cannot be combined with --continue");
	if (session !== undefined && cont) throw new TypeError("tgsec: --session cannot be combined with --continue");
	if (!webui && host !== undefined) throw new TypeError("tgsec: --host needs --webui");
	if (!webui && port !== undefined) throw new TypeError("tgsec: --port needs --webui");
	if (!webui && target !== undefined) throw new TypeError("tgsec: --target needs --webui");
	return {
		project,
		lane,
		...(mode === undefined ? {} : { mode }),
		...(model === undefined ? {} : { model }),
		...(faux ? { faux: true } : {}),
		...(webui ? { webui: true } : {}),
		...(history ? { history: true } : {}),
		...(session === undefined ? {} : { resume: { source: session } }),
		...(cont ? { resume: { source: "latest" as const } } : {}),
		...(db === undefined ? {} : { db }),
		...(evidence === undefined ? {} : { evidence }),
		...(scope === undefined ? {} : { scope }),
		...(host === undefined ? {} : { host }),
		...(port === undefined ? {} : { port }),
		...(target === undefined ? {} : { target }),
		cwd: process.cwd(),
	};
}

/** The parsed command line narrowed to what the interactive shell opens on. */
function tuiOptionsOf(options: TgSecCliOptions): TgSecTuiOptions {
	return {
		project: options.project,
		lane: options.lane,
		...(options.mode === undefined ? {} : { mode: options.mode }),
		...(options.model === undefined ? {} : { model: options.model }),
		...(options.faux === true ? { faux: true } : {}),
		...(options.db === undefined ? {} : { db: options.db }),
		...(options.evidence === undefined ? {} : { evidence: options.evidence }),
		...(options.scope === undefined ? {} : { scope: options.scope }),
		...(options.resume === undefined ? {} : { resume: options.resume }),
		cwd: options.cwd,
	};
}

/** The parsed command line narrowed to what the WebUI sidecar opens on. */
function serveOptionsOf(options: TgSecCliOptions): ServeOptions {
	return {
		...tuiOptionsOf(options),
		...(options.host === undefined ? {} : { host: options.host }),
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.target === undefined ? {} : { target: options.target }),
	};
}

/** `tgsec models`: the authenticated chat models the shell can start on, one per line. */
async function listModels(): Promise<void> {
	const models = createTgSecModels();
	const available = await models.getAvailable();
	if (available.length === 0) {
		process.stdout.write('no authenticated models: run "tgsec login <provider>" or start with --faux\n');
		return;
	}
	for (const model of available) {
		process.stdout.write(`${formatModelRef({ provider: model.provider, modelId: model.id })}\t${model.name}\n`);
	}
}

/**
 * `tgsec`: one entry, two frontends. Flagless it opens the interactive shell on the campaign root;
 * `--webui` opens the same runtime behind the WebUI sidecar instead. `--history` prints the project's
 * conversation table and exits before either frontend, so it needs no terminal and no model. The
 * history flags (`--session`, `--continue`) restore by forking in both frontends; the source
 * conversation stays read-only. The shell opens without a configured provider; `/connect` runs the
 * same credential bootstrap as `tgsec login` from inside the shell, `/models` picks a model, and
 * `--faux` runs the same runtime on a local echo model so the screen and guard wiring can be
 * exercised offline.
 */
async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	if (command === "login" || command === "list") {
		await runAuthCommand(command, argv.slice(1));
		return;
	}
	if (command === "models") {
		await listModels();
		return;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		process.stdout.write(usage());
		return;
	}
	const options = parseArgs(argv);
	if (options === undefined) return;
	if (options.history === true) {
		await printHistory(options.project, options.db);
		return;
	}
	if (options.webui === true) {
		await runServeCommand(serveOptionsOf(options));
		return;
	}
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("tgsec needs an interactive terminal: run it from a terminal, not a pipe or a non-TTY shell");
	}
	const app = await openTgSecTui(tuiOptionsOf(options));
	await app.run();
}

main().catch((error: unknown) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
