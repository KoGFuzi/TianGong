import type { Context } from "@OnePanda-TgSec/chord";
import { type AgentEventStream, type ConversationId, type Harness, watchEvents } from "@OnePanda-TgSec/tg-gibraltar";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { SecApprovalQueue, SecPendingApproval } from "./approvals.ts";
import { loadSecWebAssets, type SecWebAsset, type SecWebAssets } from "./assets.ts";
import { SecAuth, type SecIssuedTicket } from "./auth.ts";
import { isSecAskReply, type SecEventFrame, type SecServerFrame, type SecSnapshotFrame } from "./contract.ts";
import type {
	SecProjectionAction,
	SecProjectionEvidenceSubject,
	SecProjectionInput,
	SecProjectionPlan,
	SecProjectionTerminal,
} from "./projection.ts";
import { initialRunState, SecGraphProjector, SecRunProjector, type SecRunState } from "./projector.ts";
import { acceptWebSocket, rejectWebSocket, type SecWebSocket } from "./websocket.ts";

const MAX_STEER_CHARS = 4000;
const MAX_STEER_BODY_BYTES = 8192;
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"];

/** The read side of the campaign the host owns; sec-server never imports sec-agent. */
export type SecServerProjection = {
	readonly actions: readonly SecProjectionAction[];
	readonly evidence: readonly SecProjectionEvidenceSubject[];
	readonly plan?: SecProjectionPlan;
	readonly terminals?: readonly SecProjectionTerminal[];
};

/**
 * What the sidecar needs from the campaign host. The host supplies the harness stream, a projection
 * read over its action tree and evidence store, and the steering entry point; everything else is the
 * server's.
 */
export type SecServerHost = {
	readonly project: string;
	readonly target: string;
	readonly harness: Harness;
	readonly conversationId: ConversationId;
	readonly context: Context;
	readonly readProjection: () => Promise<SecServerProjection>;
	readonly steer: (content: string) => Promise<void>;
	/**
	 * The guard approval queue the host parks asks on. Absent means the sidecar has no approval
	 * surface: `ask_reply` frames are logged and ignored. The queue's `close`/`denyAll` belong to
	 * the host; the server only denies pending asks on shutdown.
	 */
	readonly approvals?: SecApprovalQueue;
};

export type SecServerOptions = {
	readonly host: SecServerHost;
	/** Pre-built gate (tests); otherwise built from `entry` / `dataDir`. */
	readonly auth?: SecAuth;
	readonly entry?: string;
	/** Where the generated entry path is persisted at mode 0600. */
	readonly dataDir?: string;
	/** Loopback by default. A non-loopback bind must name the host exactly in `--host`. */
	readonly hostname?: string;
	readonly port?: number;
	/** Directory holding `index.html`, `app.js`, `style.css`; the packaged `web/` by default. */
	readonly webDir?: string;
	readonly refreshDelayMs?: number;
	readonly heartbeatMs?: number;
	readonly now?: () => number;
	readonly logger?: (line: string) => void;
};

export type SecServerHandle = {
	/** Browser URL of the authenticated shell, ending in `/`. */
	readonly url: string;
	readonly origin: string;
	readonly entry: string;
	readonly hostname: string;
	readonly port: number;
	readonly auth: SecAuth;
	/** Mint a login ticket; it is valid once and expires after the configured TTL. */
	issueTicket(): SecIssuedTicket;
	/** The one URL to hand the operator. */
	ticketUrl(ticket: string): string;
	close(): Promise<void>;
};

class SecHttpError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`HTTP ${status}`);
		this.status = status;
	}
}

/** Start the sidecar, project the initial graph, and open the listener. */
export async function startSecServer(options: SecServerOptions): Promise<SecServerHandle> {
	const auth =
		options.auth ??
		(await SecAuth.create({
			...(options.entry === undefined ? {} : { entry: options.entry }),
			...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
		}));
	const assets = await loadSecWebAssets(options.webDir);
	const runtime = new SecServerRuntime(options, auth, assets);
	return runtime.start();
}

class SecServerRuntime {
	private readonly host: SecServerHost;
	private readonly auth: SecAuth;
	private readonly assets: SecWebAssets;
	private readonly hostname: string;
	private readonly requestedPort: number;
	private readonly refreshDelayMs: number;
	private readonly heartbeatMs: number;
	private readonly now: () => number;
	private readonly logger: (line: string) => void;

	private readonly server: Server;
	private readonly run: SecRunState = initialRunState();
	private readonly graph: SecGraphProjector;
	private readonly runProjector: SecRunProjector;
	private readonly clients = new Set<SecWebSocket>();
	private readonly approvals: SecApprovalQueue | undefined;
	private unsubscribeApprovals: (() => void) | undefined;
	private allowedHosts = new Set<string>();
	private stream: AgentEventStream | undefined;
	private port = 0;
	private refreshTimer: NodeJS.Timeout | undefined;
	private heartbeatTimer: NodeJS.Timeout | undefined;
	private refreshing = false;
	private refreshQueued = false;
	private closed = false;
	private closing: Promise<void> | undefined;

	constructor(options: SecServerOptions, auth: SecAuth, assets: SecWebAssets) {
		this.host = options.host;
		this.approvals = options.host.approvals;
		this.auth = auth;
		this.assets = assets;
		this.hostname = options.hostname ?? "127.0.0.1";
		this.requestedPort = options.port ?? 0;
		this.refreshDelayMs = options.refreshDelayMs ?? 120;
		this.heartbeatMs = options.heartbeatMs ?? 30_000;
		this.now = options.now ?? (() => Date.now());
		this.logger = options.logger ?? (() => {});
		this.graph = new SecGraphProjector(this.run);
		this.runProjector = new SecRunProjector(this.run);
		this.server = createServer((request, response) => {
			void this.handleRequest(request, response).catch((error: unknown) => {
				this.logger(`request failed: ${message(error)}`);
				if (!response.headersSent) this.sendEmpty(response, 500);
				else response.destroy();
			});
		});
		this.server.on("upgrade", (request, socket, head) => {
			this.handleUpgrade(request, socket, head);
		});
	}

	async start(): Promise<SecServerHandle> {
		this.unsubscribeApprovals = this.approvals?.subscribe((pending) => {
			this.broadcast(askFrame(pending, this.now()));
		});
		const stream = await watchEvents(this.host.harness, this.host.conversationId, this.host.context);
		this.stream = stream;
		this.runProjector.adopt(stream.snapshot);
		stream.start(async (events) => {
			try {
				const frames = this.runProjector.apply(events, this.now());
				for (const frame of frames) this.broadcast(frame);
				this.scheduleRefresh();
			} catch (error) {
				this.logger(`event projection failed: ${message(error)}`);
			}
		});
		try {
			await this.refresh(true);
			await this.listen();
		} catch (error) {
			await this.shutdown();
			throw error;
		}
		if (this.heartbeatMs > 0) {
			this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
			this.heartbeatTimer.unref();
		}
		return this.handle();
	}

	private async listen(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				this.server.off("listening", onListening);
				reject(error);
			};
			const onListening = (): void => {
				this.server.off("error", onError);
				resolve();
			};
			this.server.once("error", onError);
			this.server.once("listening", onListening);
			this.server.listen(this.requestedPort, this.hostname);
		});
		const address = this.server.address();
		if (address === null || typeof address === "string") throw new Error("tg-sec-server: the listener has no port");
		this.port = address.port;
		this.buildAllowedHosts();
	}

	private buildAllowedHosts(): void {
		const names = new Set(LOOPBACK_HOSTS);
		names.add(this.hostname);
		this.allowedHosts = new Set(
			[...names].map((name) => `${name.includes(":") ? `[${name}]` : name}:${this.port}`.toLowerCase()),
		);
	}

	private handle(): SecServerHandle {
		const origin = `http://${formatHost(this.hostname)}:${this.port}`;
		const url = `${origin}${this.auth.entryPrefix}/`;
		return {
			url,
			origin,
			entry: this.auth.entry,
			hostname: this.hostname,
			port: this.port,
			auth: this.auth,
			issueTicket: () => this.auth.issueTicket(),
			ticketUrl: (ticket: string) => `${url}login?ticket=${encodeURIComponent(ticket)}`,
			close: () => this.close(),
		};
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (this.closed) {
			this.sendEmpty(response, 503);
			return;
		}
		if (!this.hostAllowed(request)) {
			this.sendEmpty(response, 404);
			return;
		}
		const url = this.requestUrl(request);
		if (url === undefined) {
			this.sendEmpty(response, 400);
			return;
		}
		const pathname = url.pathname;
		if (pathname === this.auth.loginPath) {
			this.handleLogin(request, response, url);
			return;
		}
		if (!this.auth.matchesEntryPath(pathname) || !this.auth.authorize(request.headers.cookie)) {
			this.sendEmpty(response, 404);
			return;
		}
		const path = this.auth.stripEntry(pathname);
		switch (path) {
			case "/":
				if (!this.requireMethod(request, response, "GET")) return;
				this.sendAsset(response, this.assets.index, this.documentHeaders(request));
				return;
			case "/app.js":
				if (!this.requireMethod(request, response, "GET")) return;
				this.sendAsset(response, this.assets.script);
				return;
			case "/style.css":
				if (!this.requireMethod(request, response, "GET")) return;
				this.sendAsset(response, this.assets.style);
				return;
			case "/api/graph":
				if (!this.requireMethod(request, response, "GET")) return;
				this.sendSnapshotJson(response);
				return;
			case "/api/steer":
				if (!this.requireMethod(request, response, "POST")) return;
				await this.handleSteer(request, response);
				return;
			case "/ws":
				this.sendEmpty(response, 426, { Upgrade: "websocket", Connection: "Upgrade" });
				return;
			default:
				this.sendEmpty(response, 404);
		}
	}

	/** A login ticket is redeemed exactly once; the cookie it mints is the only session. */
	private handleLogin(request: IncomingMessage, response: ServerResponse, url: URL): void {
		if (request.method !== "GET") {
			this.requireMethod(request, response, "GET");
			return;
		}
		const ticket = url.searchParams.get("ticket");
		const token = ticket === null ? undefined : this.auth.redeem(ticket);
		if (token === undefined) {
			this.sendEmpty(response, 404);
			return;
		}
		this.sendEmpty(response, 303, {
			"Set-Cookie": this.auth.sessionCookie(token),
			Location: `${this.auth.entryPrefix}/`,
		});
	}

	private async handleSteer(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.originAllowed(request) || request.headers["x-tg-sec-steer"] !== "1") {
			this.sendEmpty(response, 403);
			return;
		}
		const contentType = String(request.headers["content-type"] ?? "")
			.split(";")[0]!
			.trim()
			.toLowerCase();
		if (contentType !== "application/json") {
			this.sendEmpty(response, 415);
			return;
		}
		let body: unknown;
		try {
			body = await readJson(request, MAX_STEER_BODY_BYTES);
		} catch (error) {
			this.sendEmpty(response, error instanceof SecHttpError ? error.status : 400);
			return;
		}
		const content = steerContentOf(body);
		if (content === undefined) {
			this.sendJson(response, 400, { error: "content must be a non-empty string" });
			return;
		}
		try {
			const queued = await this.applySteer(content);
			this.sendJson(response, 202, { ok: true, queued });
		} catch (error) {
			if (error instanceof SecHttpError) this.sendEmpty(response, error.status);
			else throw error;
		}
	}

	private async applySteer(content: string): Promise<boolean> {
		const trimmed = content.trim();
		if (trimmed === "" || trimmed.length > MAX_STEER_CHARS) {
			throw new SecHttpError(400);
		}
		const queued = this.run.running;
		await this.host.steer(trimmed);
		return queued;
	}

	private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		try {
			if (this.closed || !this.hostAllowed(request) || !this.originAllowed(request)) {
				rejectWebSocket(socket, 403, "Forbidden");
				return;
			}
			const url = this.requestUrl(request);
			if (
				url === undefined ||
				url.pathname !== `${this.auth.entryPrefix}/ws` ||
				!this.auth.authorize(request.headers.cookie)
			) {
				rejectWebSocket(socket, 404, "Not Found");
				return;
			}
			if (request.headers["sec-fetch-site"] === "cross-site") {
				rejectWebSocket(socket, 403, "Forbidden");
				return;
			}
			const client = acceptWebSocket(request, socket, head);
			if (client === undefined) return;
			this.registerClient(client);
		} catch (error) {
			this.logger(`upgrade failed: ${message(error)}`);
			rejectWebSocket(socket, 500, "Internal Server Error");
		}
	}

	private registerClient(client: SecWebSocket): void {
		this.clients.add(client);
		client.onClose(() => this.clients.delete(client));
		client.onMessage((text) => {
			void this.handleClientFrame(client, text).catch((error: unknown) => {
				this.logger(`client frame failed: ${message(error)}`);
			});
		});
		this.sendSnapshot(client);
	}

	private async handleClientFrame(client: SecWebSocket, text: string): Promise<void> {
		let frame: unknown;
		try {
			frame = JSON.parse(text);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null) return;
		const record = frame as Record<string, unknown>;
		switch (record.type) {
			case "ping":
				client.send({ type: "pong", ts: this.now() });
				return;
			case "ask_reply":
				this.handleAskReply(client, record);
				return;
			case "refresh":
				await this.refresh();
				this.sendSnapshot(client);
				return;
			case "steer": {
				const content = steerContentOf(record);
				if (content === undefined) {
					client.send(logFrame("warn", "steer ignored: content must be a non-empty string", this.now()));
					return;
				}
				try {
					await this.applySteer(content);
				} catch (error) {
					client.send(logFrame("error", `steer failed: ${message(error)}`, this.now()));
				}
				return;
			}
			default:
				return;
		}
	}

	/**
	 * The snapshot is the client's reset point: the WebUI drops its ask list on it, then receives
	 * every pending ask again. A reconnect or a `refresh` therefore cannot leave a settled ask on
	 * screen and cannot hide one that is still waiting.
	 */
	private sendSnapshot(client: SecWebSocket): void {
		const graph = this.graph.current();
		if (graph === undefined) return;
		const frame: SecSnapshotFrame = {
			type: "snapshot",
			ts: this.now(),
			payload: graph,
			running: this.run.running,
			queued: this.run.queued,
		};
		client.send(frame);
		for (const pending of this.approvals?.pending() ?? []) client.send(askFrame(pending, this.now()));
	}

	/**
	 * Resolve one parked ask. `ask_reply` is accepted only on a connection that already passed the
	 * upgrade gate (Origin, cookie, Host and `Sec-Fetch-Site`); a WebSocket handshake cannot carry
	 * the `x-tg-sec-steer` header, so the connection proof is the same surface steering has.
	 */
	private handleAskReply(client: SecWebSocket, frame: Record<string, unknown>): void {
		const id = frame.id;
		const reply = frame.reply;
		if (typeof id !== "string" || id === "" || !isSecAskReply(reply)) {
			client.send(
				logFrame("warn", "ask_reply ignored: a non-empty id and allow/deny/always are required", this.now()),
			);
			return;
		}
		if (this.approvals === undefined || !this.approvals.reply(id, reply)) {
			client.send(logFrame("warn", `guard ask ${id} is no longer pending`, this.now()));
			return;
		}
		this.broadcast(logFrame("info", `guard ask ${id}: ${reply}`, this.now()));
	}

	private sendSnapshotJson(response: ServerResponse): void {
		const graph = this.graph.current();
		if (graph === undefined) {
			this.sendEmpty(response, 503);
			return;
		}
		const frame: SecSnapshotFrame = {
			type: "snapshot",
			ts: this.now(),
			payload: graph,
			running: this.run.running,
			queued: this.run.queued,
		};
		this.sendJson(response, 200, frame);
	}

	private broadcast(frame: SecServerFrame): void {
		for (const client of [...this.clients]) {
			if (client.closed) {
				this.clients.delete(client);
				continue;
			}
			try {
				client.send(frame);
			} catch (error) {
				this.clients.delete(client);
				this.logger(`client send failed: ${message(error)}`);
				client.close(1011, "send failed");
			}
		}
	}

	private scheduleRefresh(delay = this.refreshDelayMs): void {
		if (this.closed || this.refreshTimer !== undefined) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, delay);
		this.refreshTimer.unref();
	}

	/** Re-read the host's projection and broadcast the frames that changed. */
	private async refresh(rethrow = false): Promise<void> {
		if (this.closed) return;
		if (this.refreshing) {
			this.refreshQueued = true;
			return;
		}
		this.refreshing = true;
		try {
			const source = await this.host.readProjection();
			const input: SecProjectionInput = {
				project: this.host.project,
				target: this.host.target,
				rootConversationId: this.host.conversationId,
				actions: source.actions,
				evidence: source.evidence,
				...(source.plan === undefined ? {} : { plan: source.plan }),
				...(source.terminals === undefined ? {} : { terminals: source.terminals }),
				now: this.now(),
			};
			const frames = this.graph.update(input);
			for (const frame of frames) this.broadcast(frame);
		} catch (error) {
			this.logger(`projection refresh failed: ${message(error)}`);
			if (rethrow) throw error;
		} finally {
			this.refreshing = false;
			if (this.refreshQueued) {
				this.refreshQueued = false;
				this.scheduleRefresh(0);
			}
		}
	}

	private heartbeat(): void {
		for (const client of [...this.clients]) {
			if (client.closed) {
				this.clients.delete(client);
				continue;
			}
			client.ping();
		}
	}

	private hostAllowed(request: IncomingMessage): boolean {
		const host = request.headers.host;
		return host !== undefined && this.allowedHosts.has(host.toLowerCase());
	}

	private originAllowed(request: IncomingMessage): boolean {
		const host = request.headers.host;
		return host !== undefined && request.headers.origin === `http://${host}`;
	}

	private requestUrl(request: IncomingMessage): URL | undefined {
		try {
			return new URL(request.url ?? "/", "http://localhost");
		} catch {
			return undefined;
		}
	}

	private requireMethod(request: IncomingMessage, response: ServerResponse, method: string): boolean {
		if (request.method === method) return true;
		this.sendEmpty(response, 405, { Allow: method });
		return false;
	}

	private documentHeaders(request: IncomingMessage): Record<string, string> {
		const host = request.headers.host ?? "";
		return {
			"Content-Security-Policy":
				`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; ` +
				`connect-src 'self' ws://${host}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
		};
	}

	private sendAsset(response: ServerResponse, asset: SecWebAsset, extra: Record<string, string> = {}): void {
		this.send(response, 200, asset.contentType, asset.body, extra);
	}

	private sendJson(response: ServerResponse, status: number, value: unknown): void {
		const body = Buffer.from(JSON.stringify(value), "utf8");
		this.send(response, status, "application/json; charset=utf-8", body);
	}

	private sendEmpty(response: ServerResponse, status: number, extra: Record<string, string> = {}): void {
		this.send(response, status, undefined, undefined, extra);
	}

	private send(
		response: ServerResponse,
		status: number,
		contentType: string | undefined,
		body: Buffer | undefined,
		extra: Record<string, string> = {},
	): void {
		const headers: Record<string, string | number> = {
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Resource-Policy": "same-origin",
			"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
			...extra,
		};
		if (contentType !== undefined) headers["Content-Type"] = contentType;
		headers["Content-Length"] = body?.length ?? 0;
		response.writeHead(status, headers);
		if (body === undefined) response.end();
		else response.end(body);
	}

	private async close(): Promise<void> {
		if (this.closing !== undefined) return this.closing;
		this.closing = this.shutdown();
		return this.closing;
	}

	private async shutdown(): Promise<void> {
		this.closed = true;
		this.unsubscribeApprovals?.();
		this.unsubscribeApprovals = undefined;
		// A tool call waiting on an operator cannot outlive the surface that would have asked: deny
		// first, then stop the event stream, so the harness can finish the turn it is aborting.
		this.approvals?.denyAll();
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
		this.refreshTimer = undefined;
		this.heartbeatTimer = undefined;
		for (const client of this.clients) client.close(1001, "server stopping");
		this.clients.clear();
		if (this.stream !== undefined) {
			try {
				await this.stream.stop();
			} catch (error) {
				this.logger(`event stream stop failed: ${message(error)}`);
			}
			this.stream = undefined;
		}
		await new Promise<void>((resolve) => {
			this.server.close(() => resolve());
			this.server.closeAllConnections?.();
		});
	}
}

function steerContentOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const content = (value as Record<string, unknown>).content;
	if (typeof content !== "string") return undefined;
	const trimmed = content.trim();
	if (trimmed === "" || trimmed.length > MAX_STEER_CHARS) return undefined;
	return trimmed;
}

function logFrame(level: "info" | "warn" | "error", text: string, now: number): SecServerFrame {
	return { type: "log", ts: now, payload: { level, message: text } };
}

function askFrame(pending: SecPendingApproval, now: number): SecEventFrame {
	return { type: "ask", ts: now, payload: pending };
}

function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const declared = Number(request.headers["content-length"] ?? Number.NaN);
		if (Number.isFinite(declared) && declared > limit) {
			reject(new SecHttpError(413));
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		request.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > limit) {
				reject(new SecHttpError(413));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			if (size === 0) {
				reject(new SecHttpError(400));
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new SecHttpError(400));
			}
		});
		request.on("error", reject);
	});
}

function formatHost(hostname: string): string {
	return hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
