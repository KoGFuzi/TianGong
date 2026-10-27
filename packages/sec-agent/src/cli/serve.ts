import type { Context } from "@OnePanda-TgSec/chord";
import { BACKGROUND_CONTEXT } from "@OnePanda-TgSec/chord/context";
import {
	contentText,
	type FauxProviderHandle,
	type FauxResponseFactory,
	fauxAssistantMessage,
	fauxProvider,
} from "@OnePanda-TgSec/tg-ai";
import type { ConversationId, JsonObject, ModelRef, SessionDocToken, Tx } from "@OnePanda-TgSec/tg-gibraltar";
import {
	loadTgSecScopeRegistry,
	readTgSecMode,
	type TgSecPermissionMode,
	type TgSecSessionPort,
} from "@OnePanda-TgSec/tg-sec-guard";
import {
	createSecApprovalQueue,
	type SecProjectionEvidenceSubject,
	type SecProjectionFinding,
	type SecProjectionPlan,
	type SecProjectionTerminal,
	type SecServerHandle,
	startSecServer,
} from "@OnePanda-TgSec/tg-sec-server";
import { InMemoryTelemetryContext } from "@OnePanda-TgSec/tg-telemetry";
import { join } from "node:path";
import { createApprovalAskChannel } from "../ask.ts";
import { openSecAgent, type SecAgent, type SecAgentLane } from "../bootstrap.ts";
import { fauxDatabasePath, safeProjectSegment, tgSecDataDir } from "../config.ts";
import { createSecCoreExtension } from "../core-extension.ts";
import { evidenceDir } from "../evidence/config.ts";
import { openTgSecEvidenceStore, type TgSecEvidenceStore } from "../evidence/store.ts";
import { buildSecGuard, secAttestForbiddenRead, secDeclaredTools } from "../guard-wiring.ts";
import { openSecMcpHost, type SecMcpHost } from "../mcp/host.ts";
import { latestPlan } from "../plan.ts";
import { listTerminals } from "../terminal.ts";
import { createSecToolsExtension } from "../tools/extension.ts";
import { nodeRequestExecutor } from "../tools/transport.ts";
import { createTgSecModels, resetFauxContext, tryResolveTgSecModel } from "../tui/model.ts";

/** Everything `tgsec --webui` accepts on the command line. */
export type ServeOptions = {
	readonly project: string;
	readonly lane: SecAgentLane;
	readonly mode?: TgSecPermissionMode;
	readonly model?: string;
	readonly faux?: boolean;
	readonly db?: string;
	readonly evidence?: string;
	readonly scope?: string;
	/** Bind address; loopback unless the operator names another interface. */
	readonly host?: string;
	/** 0 asks the OS for a free port. */
	readonly port?: number;
	/** Display name of the campaign's root target; defaults to the project name. */
	readonly target?: string;
	/** Print this project's history conversation table and exit without opening a model or the WebUI. */
	readonly history?: boolean;
	/** Restore from one history conversation instead of the reserved root. */
	readonly resume?: { readonly source: ConversationId | "latest" };
	readonly cwd: string;
};

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
			if (port === undefined) throw new Error("tgsec --webui: the session is not open yet");
			return port.commit(change, context);
		},
	};
}

/** The offline echo model: one self-reappending reply per turn, no credentials and no egress. */
function scriptFauxEcho(faux: FauxProviderHandle): void {
	const echo: FauxResponseFactory = (context) => {
		faux.appendResponses([echo]);
		const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
		const text = lastUser === undefined ? "" : contentText(lastUser.content).trim();
		return fauxAssistantMessage(
			`faux campaign echo: ${text}\n\nNo model is behind this run and nothing leaves the machine. This exercises the campaign shell, the guard and the WebUI projection offline.`,
		);
	};
	faux.setResponses([echo]);
}

/**
 * `tgsec --webui`: open the campaign runtime and the WebUI sidecar on the same harness. The server
 * projects the action tree and evidence store onto the StrikeAgent graph contract, streams agent
 * events over WebSocket, and accepts steering back into the conversation. Guard escalations travel
 * the other way: the host parks them on the shared approval queue, the browser shows them and
 * answers with `ask_reply`, and the guard's own `always` semantics decide what a grant covers.
 */
export async function runServeCommand(options: ServeOptions): Promise<void> {
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
	if (resolved === undefined) {
		throw new Error('tgsec --webui: no authenticated model; run "tgsec login <provider>" or pass --faux');
	}
	const modelRef: ModelRef = resolved.ref;
	const dataDir = tgSecDataDir();
	const databasePath = options.db ?? (options.faux === true ? fauxDatabasePath(options.project, dataDir) : undefined);
	const store = await openTgSecEvidenceStore({ dir: options.evidence ?? evidenceDir(options.project), telemetry });
	const scopePath = options.scope ?? join(dataDir, "projects", safeProjectSegment(options.project), "scope.json");
	const session = createDeferredSessionPort();
	const approvals = createSecApprovalQueue();
	let registeredTools: readonly string[] = [];
	let agent: SecAgent | undefined;
	let mcp: SecMcpHost | undefined;
	let server: SecServerHandle | undefined;

	const shutdown = async (): Promise<void> => {
		// Fail closed before unwinding: a tool call parked on an operator is denied, so the harness
		// can finish the aborted turn instead of waiting forever on a browser that is going away.
		approvals.close();
		const running = server;
		server = undefined;
		if (running !== undefined) await running.close().catch(() => undefined);
		const opened = agent;
		agent = undefined;
		if (opened !== undefined) await opened.close(context).catch(() => undefined);
		const bridge = mcp;
		mcp = undefined;
		if (bridge !== undefined) await bridge.close().catch(() => undefined);
		await store.close().catch(() => undefined);
	};

	try {
		const scopeRegistry = await loadTgSecScopeRegistry(scopePath);
		const mcpHost = await openSecMcpHost({ cwd: options.cwd });
		mcp = mcpHost;
		for (const error of mcpHost.errors) process.stderr.write(`tg-sec mcp: ${error}\n`);
		const wiring = await buildSecGuard({
			session,
			lane: options.lane,
			context,
			...(options.mode === undefined ? {} : { mode: options.mode }),
			scopeRegistry,
			judgeModel: { models, model: modelRef },
			askChannel: createApprovalAskChannel(approvals),
			telemetry,
			attestParts: {
				forbiddenRead: secAttestForbiddenRead(join(dataDir, "attest")),
				registeredTools: () => registeredTools,
				declaredTools: secDeclaredTools(options.lane, mcpHost.declaredTools),
			},
		});
		const core = createSecCoreExtension({ lane: options.lane, wiring, policies: mcpHost.policies, telemetry });
		const secTools = createSecToolsExtension({
			store,
			executor: nodeRequestExecutor(),
			lane: options.lane,
			project: options.project,
			target: options.target ?? options.project,
			...(mcpHost.flowFetcher === undefined ? {} : { flowFetcher: mcpHost.flowFetcher }),
		});
		agent = await openSecAgent({
			context,
			project: options.project,
			lane: options.lane,
			models,
			model: modelRef,
			cwd: options.cwd,
			...(databasePath === undefined ? {} : { path: databasePath }),
			...(options.resume === undefined ? {} : { resume: options.resume }),
			extensions: [core, secTools, ...mcpHost.extensions],
			onClose: async () => {
				for (const error of await mcpHost.close()) process.stderr.write(`tg-sec mcp: ${error}\n`);
			},
		});
		session.attach(agent.harness);
		const stored = (await agent.root.agent(context)).model;
		if (stored === undefined || stored.provider !== modelRef.provider || stored.modelId !== modelRef.modelId) {
			await agent.root.configure({ model: modelRef }, context);
		}
		await resetFauxContext(agent.root, modelRef, context);
		registeredTools = agent.registry
			.snapshot()
			.tools()
			.map((entry) => entry.tool.name);
		const persisted = await readTgSecMode(agent.harness, context);
		if (options.mode !== undefined && persisted !== options.mode) {
			await wiring.guard.switchMode(options.mode, "tgsec --webui", context);
		}

		const campaign = agent;
		const evidence = store;
		server = await startSecServer({
			host: {
				project: options.project,
				target: options.target ?? options.project,
				harness: campaign.harness,
				conversationId: campaign.root.id,
				context,
				readProjection: async () => ({
					actions: await campaign.actionTree(context),
					evidence: await readEvidenceSubjects(evidence),
					findings: await readFindings(evidence),
					plan: await readPlan(campaign, context),
					terminals: await readTerminals(campaign, context),
				}),
				steer: async (content: string) => {
					await campaign.root.submit(
						{ type: "input", content, whenBusy: "steer", entry: { kind: "sec.steer" } },
						context,
					);
				},
				approvals,
			},
			dataDir: join(dataDir, "sec-server"),
			...(options.host === undefined ? {} : { hostname: options.host }),
			...(options.port === undefined ? {} : { port: options.port }),
			logger: (line: string) => process.stderr.write(`[tg-sec-server] ${line}\n`),
		});
		const ticket = server.issueTicket();
		process.stdout.write(
			[
				`tgsec --webui: project=${options.project} lane=${options.lane} mode=${options.mode ?? persisted} model=${resolved === undefined ? "none" : `${modelRef.provider}/${modelRef.modelId}`}`,
				`  webui  ${server.url}`,
				`  login  ${server.ticketUrl(ticket.ticket)}`,
				"  the login URL is one-time and expires in 5 minutes; it sets the session cookie",
				"  guard asks appear in the WebUI's pending queue (allow / deny / always); ctrl+c stops the server",
				"",
			].join("\n"),
		);
		await waitForSignal();
	} catch (error) {
		await shutdown();
		throw error;
	}
	await shutdown();
}

/** The newest plan revision as the projection's intent source; absent before the first `plan_update`. */
async function readPlan(agent: SecAgent, context: Context): Promise<SecProjectionPlan | undefined> {
	const plan = await latestPlan(agent.storage, context);
	if (plan === undefined) return undefined;
	return {
		revision: plan.revision,
		rationale: plan.rationale,
		createdAt: plan.createdAt,
		steps: plan.steps.map((step) => ({
			stepId: step.stepId,
			title: step.title,
			detail: step.detail,
			status: step.status,
			...(step.ownerRole === "" ? {} : { ownerRole: step.ownerRole }),
			...(step.conversationId === 0 ? {} : { conversationId: step.conversationId }),
		})),
	};
}

/** Every terminal declaration; an unverified one is projected but never changes a finding. */
async function readTerminals(agent: SecAgent, context: Context): Promise<readonly SecProjectionTerminal[]> {
	const terminals = await listTerminals(agent.storage, context);
	return terminals.map((terminal) => ({
		claim: terminal.claim,
		lane: terminal.lane,
		status: terminal.status,
		reason: terminal.reason,
		...(terminal.findingId === "" ? {} : { findingId: terminal.findingId }),
		...(terminal.snapshotId === "" ? {} : { snapshotId: terminal.snapshotId }),
		declaredAt: terminal.declaredAt,
	}));
}

/** One subject per evidence id, metadata only; body bytes never enter the projection. */
async function readEvidenceSubjects(store: TgSecEvidenceStore): Promise<readonly SecProjectionEvidenceSubject[]> {
	const subjects = await store.listSubjects();
	return Promise.all(
		subjects.map(async (subjectId) => {
			const set = await store.list(subjectId);
			const bindings = await Promise.all(
				set.bindings.map(async (binding) => {
					const snapshot = await store.getSnapshot(binding.snapshotId);
					const fields = snapshot?.fields;
					return {
						snapshotId: binding.snapshotId,
						role: binding.role,
						note: binding.note,
						capturedAt: fields?.capturedAt ?? 0,
						method: fields?.method ?? "",
						url: fields?.url ?? "",
						status: fields?.status ?? 0,
					};
				}),
			);
			return { subjectId, version: set.version, bindings };
		}),
	);
}

/** Every registered finding, metadata only; the projection maps its status to the wire vocabulary. */
async function readFindings(store: TgSecEvidenceStore): Promise<readonly SecProjectionFinding[]> {
	return (await store.listFindings()).map((finding) => ({
		findingId: finding.findingId,
		lane: finding.lane,
		title: finding.title,
		severity: finding.severity,
		status: finding.status,
		subjectId: finding.subjectId,
		createdAt: finding.createdAt,
		updatedAt: finding.updatedAt,
		retestSnapshotId: finding.retestSnapshotId,
	}));
}

function waitForSignal(): Promise<void> {
	return new Promise<void>((resolve) => {
		const stop = (): void => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			resolve();
		};
		process.on("SIGINT", stop);
		process.on("SIGTERM", stop);
	});
}
