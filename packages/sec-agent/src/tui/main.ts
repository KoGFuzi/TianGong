#!/usr/bin/env bun

import { isTgSecMode, type TgSecPermissionMode } from "@OnePanda-TgSec/tg-sec-guard";
import type { SecAgentLane } from "../bootstrap.ts";
import { runAuthCommand } from "../cli/auth.ts";
import { isSecTuiLane, openTgSecTui, type TgSecTuiOptions } from "./app.ts";
import { createTgSecModels, formatModelRef } from "./model.ts";

function usage(): string {
	return `usage:
  tgsec [options]              open the interactive campaign shell
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

inside the shell: /help lists the commands; /connect signs in to a provider (OAuth or API key)
and /models picks an authenticated model; a guard ask is answered with y (once), n (deny),
a (always) or ctrl+c (deny all).
`;
}

function parseArgs(argv: readonly string[]): TgSecTuiOptions | undefined {
	let project = "main";
	let lane: SecAgentLane = "redteam";
	let mode: TgSecPermissionMode | undefined;
	let model: string | undefined;
	let faux = false;
	let db: string | undefined;
	let evidence: string | undefined;
	let scope: string | undefined;

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
			default:
				throw new TypeError(`tgsec: unknown argument ${flag}`);
		}
	}
	if (faux && model !== undefined) throw new TypeError("tgsec: --faux cannot be combined with --model");
	return {
		project,
		lane,
		...(mode === undefined ? {} : { mode }),
		...(model === undefined ? {} : { model }),
		...(faux ? { faux: true } : {}),
		...(db === undefined ? {} : { db }),
		...(evidence === undefined ? {} : { evidence }),
		...(scope === undefined ? {} : { scope }),
		cwd: process.cwd(),
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
 * `tgsec`: the interactive shell. It opens without a configured provider; `/connect` runs the same
 * credential bootstrap as `tgsec login` from inside the shell, `/models` picks a model, and `--faux`
 * runs the same runtime on a local echo model so the screen and guard wiring can be exercised offline.
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
	if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
		throw new Error("tgsec needs an interactive terminal: run it from a terminal, not a pipe or a non-TTY shell");
	}
	const app = await openTgSecTui(options);
	await app.run();
}

main().catch((error: unknown) => {
	console.error("Error:", error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
