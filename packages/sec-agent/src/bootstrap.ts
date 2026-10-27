import type { Context } from "@OnePanda-TgSec/chord";
import type { Models } from "@OnePanda-TgSec/tg-ai";
import {
	type Conversation,
	type ConversationId,
	type ConversationMeta,
	createRegistry,
	type EnvTarget,
	type Extension,
	Harness,
	type HarnessOptions,
	type ModelRef,
	type Registry,
} from "@OnePanda-TgSec/tg-gibraltar";
import { createCodemodeExtension } from "@OnePanda-TgSec/tg-gibraltar/codemode";
import { NodeExecutionEnv } from "@OnePanda-TgSec/tg-gibraltar/env/node";
import type { SqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite";
import { openNodeSqliteStorage } from "@OnePanda-TgSec/tg-gibraltar/storage/sqlite/node";
import { createToolSearchExtension } from "@OnePanda-TgSec/tg-gibraltar/tool-search";
import { createCodingTools } from "@OnePanda-TgSec/tg-gibraltar/tools";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { type ActionTreeQuery, listActionTree, secActionTreeCreateHook, type TgSecActionNode } from "./action-tree.ts";
import { ensureDatabaseDirectory, projectDatabasePath } from "./config.ts";

/** The campaign lanes; each conditions tools, prompt sections and guard policy (`docs/sec-agent-design.md` 赛道预设). */
export type SecAgentLane = "redteam" | "ctf" | "src";

/** Everything one campaign needs; the values that durable day-one construction forbids have no defaults here. */
export type OpenSecAgentOptions = {
	readonly context: Context;
	/** One campaign, one project: every persisted row is tagged and read-filtered by it. */
	readonly project: string;
	readonly lane: SecAgentLane;
	readonly models: Models;
	readonly model: ModelRef;
	readonly cwd: string;
	/** SQLite file; defaults to this project's own file under the XDG data root. */
	readonly path?: string;
	/** Extensions beyond the base set (coding-tools, tool-search, codemode). */
	readonly extensions?: readonly Extension[];
	/**
	 * Restore from one history conversation instead of the reserved root; the source stays read-only.
	 */
	readonly resume?: {
		/** Source conversation; `latest` picks the newest non-archived root of this project. */
		readonly source: ConversationId | "latest";
	};
	/** Tools never execute bare inside the orchestration process; the default resolves a Node env per conversation cwd. */
	readonly env?: NonNullable<HarnessOptions["env"]>;
	/**
	 * Closed after the harness and sandbox, in assembly order's reverse. The MCP bridge hangs its
	 * long-lived-resource cleanup here, so no listener outlives the campaign.
	 */
	readonly onClose?: () => Promise<void> | void;
	readonly onReport?: (error: unknown) => void;
	readonly now?: () => number;
};

/** One live campaign: a durable harness over SQLite with its action tree. */
export type SecAgent = {
	readonly harness: Harness;
	readonly storage: SqliteStorage;
	readonly registry: Registry;
	readonly root: Conversation;
	readonly lane: SecAgentLane;
	/** Extension failures reported by the harness; the sink is never empty. */
	readonly reports: readonly unknown[];
	readonly actionTree: (context: Context, query?: ActionTreeQuery) => Promise<readonly TgSecActionNode[]>;
	readonly close: (context: Context) => Promise<void>;
};

/**
 * Open a campaign on real SQLite storage, resume scheduling, and return the root conversation.
 * This is the production construction the design document requires day one: a real
 * `openNodeSqliteStorage` (never an in-memory storage), `root()` with the agent choices, `resume()`
 * so a restart's running→pending reset actually runs, an `env` resolver, and a non-empty report
 * sink.
 */
export async function openSecAgent(options: OpenSecAgentOptions): Promise<SecAgent> {
	const now = options.now ?? (() => Date.now());
	const path = options.path ?? projectDatabasePath(options.project);
	await ensureDatabaseDirectory(path);
	const storage = await openNodeSqliteStorage(path, { project: options.project });

	const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
	const registry = createRegistry();
	registry.install(createCodingTools());
	registry.install(createToolSearchExtension());
	registry.install(createCodemodeExtension({ sandbox }));
	for (const extension of options.extensions ?? []) registry.install(extension);

	const reported: unknown[] = [];
	const env: NonNullable<HarnessOptions["env"]> =
		options.env ?? ((target: EnvTarget) => new NodeExecutionEnv({ cwd: target.cwd ?? options.cwd }));
	const harness = await Harness.open(
		storage,
		{
			models: options.models,
			registry,
			env,
			conversationCreated: secActionTreeCreateHook(now),
			onReport: (error: unknown) => {
				reported.push(error);
				options.onReport?.(error);
			},
			now,
		},
		options.context,
	);
	const rootMeta = (): ConversationMeta => ({
		title: options.project,
		cwd: options.cwd,
		lane: options.lane,
		createdAt: now(),
		updatedAt: now(),
	});
	// The live conversation of this run: the reserved root, or a fresh fork of one history conversation
	// (`options.resume`). The source stays read-only; every later write lands in the fork.
	const openConversation = async (
		resume: { readonly source: ConversationId | "latest" | undefined },
		freshMeta: () => ConversationMeta,
	): Promise<Conversation> => {
		if (resume.source === undefined) {
			return harness.root(options.context, { agent: { model: options.model, cwd: options.cwd }, meta: freshMeta() });
		}
		const summary =
			resume.source === "latest"
				? (
						await storage.scanConversationSummaries(
							{ roots: true, order: "descending" },
							1,
							undefined,
							options.context,
						)
					).items[0]
				: await storage.conversationSummary(resume.source, options.context);
		if (summary === undefined) {
			if (resume.source === "latest") {
				// First run without history is not an error: open the campaign root as usual.
				process.stderr.write("tg-sec: no history to continue; opening the campaign root conversation\n");
				return harness.root(options.context, {
					agent: { model: options.model, cwd: options.cwd },
					meta: freshMeta(),
				});
			}
			throw new TypeError(`Conversation ${resume.source} is not in ${path}`);
		}
		const source = await harness.conversation(summary.id, options.context);
		if (source === undefined) throw new TypeError(`Conversation ${summary.id} is not in ${path}`);
		const newest = await source.entries({ order: "descending" }, 1, undefined, options.context);
		const forkPoint = newest.items[0];
		if (forkPoint === undefined) {
			throw new TypeError(`Conversation ${summary.id} has no history to restore`);
		}
		if (summary.meta.lane !== options.lane) {
			process.stderr.write(
				`tg-sec: restoring conversation ${summary.id} (lane ${summary.meta.lane}) into a ${options.lane} campaign; guard policy follows ${options.lane}\n`,
			);
		}
		// The fork carries the source's identity forward: its title with a continuation mark, but this
		// run's cwd and lane, and none of the source's archive state.
		const title = `↳ ${summary.meta.title}`;
		return source.fork(
			forkPoint.id,
			{
				ownership: { kind: "ownerless" },
				agent: { model: options.model, cwd: options.cwd },
				meta: {
					title: title.length > 80 ? `${title.slice(0, 80)}…` : title,
					cwd: options.cwd,
					lane: options.lane,
					createdAt: now(),
					updatedAt: now(),
				},
			},
			options.context,
		);
	};
	const root = await openConversation({ source: options.resume?.source }, rootMeta);
	harness.resume();

	return {
		harness,
		storage,
		registry,
		root,
		lane: options.lane,
		get reports() {
			return reported;
		},
		actionTree: (context, query) => listActionTree(harness, context, query),
		close: async (context) => {
			try {
				await harness.close(context);
			} finally {
				try {
					await sandbox.close();
				} finally {
					await options.onClose?.();
				}
			}
		},
	};
}
