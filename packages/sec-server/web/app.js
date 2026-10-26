const SVG_NS = "http://www.w3.org/2000/svg";
const NODE_W = 196;
const NODE_H = 66;
const COL_GAP = 268;
const ROW_GAP = 104;
const PAD_X = 150;
const PAD_Y = 110;
const MAX_FEED = 500;
const MAX_FEED_DOM = 300;
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

const dom = {
	svg: document.getElementById("graph"),
	empty: document.getElementById("empty"),
	status: document.getElementById("status"),
	statusText: document.getElementById("status-text"),
	stats: document.getElementById("stats"),
	findings: document.getElementById("panel-findings"),
	intents: document.getElementById("panel-intents"),
	events: document.getElementById("panel-events"),
	countFindings: document.getElementById("count-findings"),
	countIntents: document.getElementById("count-intents"),
	countEvents: document.getElementById("count-events"),
	detail: document.getElementById("detail"),
	detailTitle: document.getElementById("detail-title"),
	detailMeta: document.getElementById("detail-meta"),
	detailJson: document.getElementById("detail-json"),
	input: document.getElementById("steer-input"),
	send: document.getElementById("steer-send"),
	notice: document.getElementById("notice"),
	fit: document.getElementById("fit"),
};

const state = {
	graph: emptyGraph(),
	positions: new Map(),
	selected: undefined,
	tab: "findings",
	feed: [],
	socket: undefined,
	connected: false,
	running: false,
	queued: 0,
	attempts: 0,
	expired: false,
	reconnectTimer: undefined,
	noticeTimer: undefined,
	view: { x: 0, y: 0, scale: 1 },
	drag: undefined,
	fitPending: true,
};

function emptyGraph() {
	return {
		nodes: [],
		edges: [],
		findings: [],
		intents: [],
		frontier: { open: 0, strategies: 0, by_status: {} },
		rce_path: { path: [], paths: [], likelihood: 0, frontier_mode: false },
	};
}

function normalizeGraph(value) {
	if (typeof value !== "object" || value === null) return emptyGraph();
	const pick = (key) => (Array.isArray(value[key]) ? value[key] : []);
	return {
		nodes: pick("nodes"),
		edges: pick("edges"),
		findings: pick("findings"),
		intents: pick("intents"),
		frontier: typeof value.frontier === "object" && value.frontier !== null ? value.frontier : emptyGraph().frontier,
		rce_path:
			typeof value.rce_path === "object" && value.rce_path !== null ? value.rce_path : emptyGraph().rce_path,
	};
}

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className !== undefined) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

function svgElement(tag, attributes = {}) {
	const node = document.createElementNS(SVG_NS, tag);
	for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
	return node;
}

function truncate(text, max) {
	const value = String(text ?? "");
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function clip(text, max) {
	const value = String(text ?? "").trim();
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function badge(text, className) {
	return element("span", `badge ${className ?? ""}`.trim(), text);
}

function timeOf(ts) {
	const date = new Date(Number(ts) || Date.now());
	return date.toLocaleTimeString([], { hour12: false });
}

function upsert(items, item) {
	const index = items.findIndex((candidate) => candidate.id === item.id);
	if (index === -1) items.push(item);
	else items[index] = item;
}

/* ---------------------------------------------------------------- transport */

function connect() {
	if (state.expired) return;
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const base = location.pathname.replace(/\/+$/u, "");
	let socket;
	try {
		socket = new WebSocket(`${protocol}//${location.host}${base}/ws`);
	} catch {
		scheduleReconnect();
		return;
	}
	state.socket = socket;
	socket.addEventListener("open", () => {
		if (state.socket !== socket) return;
		state.connected = true;
		state.attempts = 0;
		renderStatus();
	});
	socket.addEventListener("message", (event) => {
		let frame;
		try {
			frame = JSON.parse(event.data);
		} catch {
			return;
		}
		handleFrame(frame);
	});
	socket.addEventListener("close", () => {
		if (state.socket !== socket) return;
		state.socket = undefined;
		state.connected = false;
		renderStatus();
		scheduleReconnect();
	});
	socket.addEventListener("error", () => {
		try {
			socket.close();
		} catch {
			// The close handler owns the reconnect.
		}
	});
}

function scheduleReconnect() {
	if (state.expired || state.reconnectTimer !== undefined) return;
	const delay = Math.min(10_000, 1_000 * 2 ** Math.min(state.attempts, 4));
	state.attempts += 1;
	state.reconnectTimer = setTimeout(() => {
		state.reconnectTimer = undefined;
		void refreshOverHttp().finally(connect);
	}, delay);
}

async function refreshOverHttp() {
	try {
		const response = await fetch("./api/graph", { headers: { accept: "application/json" } });
		if (response.ok) {
			handleFrame(await response.json());
			return;
		}
		if (response.status === 404) {
			state.expired = true;
			renderStatus();
			notice("session expired: reopen the ticket URL printed by tg-sec serve", "error");
		}
	} catch {
		// The next reconnect attempt retries.
	}
}

function handleFrame(frame) {
	if (typeof frame !== "object" || frame === null) return;
	switch (frame.type) {
		case "snapshot":
			state.graph = normalizeGraph(frame.payload);
			state.running = frame.running === true;
			state.queued = Number(frame.queued) || 0;
			prunePositions();
			renderAll();
			return;
		case "node":
			upsert(state.graph.nodes, frame.payload);
			refreshGraph();
			return;
		case "edge":
			upsert(state.graph.edges, frame.payload);
			refreshGraph();
			return;
		case "finding":
			upsert(state.graph.findings, frame.payload);
			refreshGraph();
			return;
		case "intent":
			upsert(state.graph.intents, frame.payload);
			refreshGraph();
			return;
		case "rce_path":
			state.graph.rce_path = frame.payload;
			refreshGraph();
			return;
		case "status":
			state.running = frame.payload?.running === true;
			state.queued = Number(frame.payload?.queued) || 0;
			renderStatus();
			return;
		case "steer":
			pushFeed({ kind: "steer", ts: frame.ts, text: clip(frame.payload?.content, 2000), level: "info" });
			notice("steer delivered");
			return;
		case "log":
			pushFeed({ kind: "log", ts: frame.ts, text: clip(frame.payload?.message, 2000), level: frame.payload?.level });
			return;
		case "tool":
			pushFeed({
				kind: "tool",
				ts: frame.ts,
				text: `${frame.payload?.name ?? "tool"} ${clip(JSON.stringify(frame.payload?.args ?? {}), 500)}`,
				level: "info",
			});
			return;
		case "tool_result": {
			const payload = frame.payload ?? {};
			const suffix = payload.durationMs === undefined ? "" : ` (${payload.durationMs} ms)`;
			pushFeed({
				kind: "result",
				ts: frame.ts,
				text: `${payload.name ?? "tool"} ${payload.ok === false ? "failed" : "ok"}${suffix}`,
				level: payload.ok === false ? "error" : "info",
			});
			return;
		}
		case "thought":
			pushFeed({ kind: "thought", ts: frame.ts, text: clip(frame.payload?.text, 4000), level: "info" });
			return;
		case "memory":
			pushFeed({ kind: "memory", ts: frame.ts, text: clip(frame.payload?.text, 2000), level: "info" });
			return;
		default:
			return;
	}
}

function pushFeed(entry) {
	state.feed.push(entry);
	if (state.feed.length > MAX_FEED) state.feed.splice(0, state.feed.length - MAX_FEED);
	renderFeed();
}

/* ------------------------------------------------------------------- status */

function renderStatus() {
	let status = "down";
	let text = "reconnecting";
	if (state.expired) text = "session expired";
	else if (state.connected && state.running) {
		status = "running";
		text = state.queued > 0 ? `running · ${state.queued} queued` : "running";
	} else if (state.connected) {
		status = "live";
		text = state.queued > 0 ? `idle · ${state.queued} queued` : "idle";
	}
	dom.status.dataset.state = status;
	dom.statusText.textContent = text;
}

function renderStats() {
	const { nodes, edges, findings, intents, rce_path: rcePath } = state.graph;
	const count = (level) => findings.filter((finding) => finding.severity === level).length;
	const frontier = intents.filter((intent) => intent.status === "open" || intent.status === "active").length;
	const hasShell = nodes.some(
		(node) =>
			node.is_rce === true ||
			node.key?.startsWith("goal:shell") === true ||
			node.key?.startsWith("foothold:shell") === true,
	);
	const entries = [
		["nodes", nodes.length],
		["edges", edges.length],
		["findings", findings.length],
		["high+", count("high") + count("critical")],
		["frontier", frontier],
		["shell", hasShell ? "yes" : "no"],
	];
	if (Array.isArray(rcePath.path) && rcePath.path.length > 0) {
		entries.push(["rce", `${Math.round((Number(rcePath.likelihood) || 0) * 100)}%`]);
	}
	dom.stats.replaceChildren(
		...entries.map(([label, value]) => {
			const span = element("span", undefined, `${label} `);
			span.appendChild(element("b", undefined, String(value)));
			return span;
		}),
	);
}

/* -------------------------------------------------------------------- graph */

function edgeList() {
	const adjacency = new Map();
	for (const edge of state.graph.edges) {
		const from = state.positions.get(edge.from);
		const to = state.positions.get(edge.to);
		if (from === undefined || to === undefined) continue;
		if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
		adjacency.get(edge.from).push(edge.to);
	}
	return adjacency;
}

function ensureLayout() {
	const adjacency = edgeList();
	const byKey = new Map(state.graph.nodes.map((node) => [node.key, node]));
	const depth = new Map();
	const roots = state.graph.nodes.filter((node) => node.type === "target").map((node) => node.key);
	const seeds = roots.length > 0 ? roots : state.graph.nodes.filter((node) => !incoming(node.key)).map((node) => node.key);
	const queue = seeds.map((key) => ({ key, distance: 0 }));
	for (const seed of queue) depth.set(seed.key, 0);
	while (queue.length > 0) {
		const current = queue.shift();
		for (const next of adjacency.get(current.key) ?? []) {
			if (depth.has(next) || !byKey.has(next)) continue;
			depth.set(next, current.distance + 1);
			queue.push({ key: next, distance: current.distance + 1 });
		}
	}
	const columns = new Map();
	const ordered = [...state.graph.nodes].sort(
		(a, b) => (Number(a.created_at) || 0) - (Number(b.created_at) || 0) || String(a.id).localeCompare(String(b.id)),
	);
	for (const node of ordered) {
		const column = depth.get(node.key) ?? 1;
		if (!columns.has(column)) columns.set(column, []);
		columns.get(column).push(node);
	}
	const next = new Map();
	for (const [column, members] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
		members.forEach((node, index) => {
			next.set(node.key, state.positions.get(node.key) ?? { x: PAD_X + column * COL_GAP, y: PAD_Y + index * ROW_GAP });
		});
	}
	state.positions = next;
}

function incoming(key) {
	return state.graph.edges.some((edge) => edge.to === key);
}

function prunePositions() {
	const keys = new Set(state.graph.nodes.map((node) => node.key));
	for (const key of [...state.positions.keys()]) if (!keys.has(key)) state.positions.delete(key);
}

function renderGraph() {
	ensureLayout();
	const defs = svgElement("defs");
	const marker = svgElement("marker", {
		id: "arrow",
		viewBox: "0 0 10 10",
		refX: 8,
		refY: 5,
		markerWidth: 6,
		markerHeight: 6,
		orient: "auto-start-reverse",
	});
	marker.appendChild(svgElement("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#4b5b6a" }));
	defs.appendChild(marker);
	const root = svgElement("g", { class: "viewport" });
	const onPath = new Set();
	const rcePath = state.graph.rce_path ?? {};
	for (const path of Array.isArray(rcePath.paths) ? rcePath.paths : []) {
		for (let index = 0; index < path.length - 1; index += 1) onPath.add(`${path[index]}\u0000${path[index + 1]}`);
	}
	for (const edge of state.graph.edges) {
		const from = state.positions.get(edge.from);
		const to = state.positions.get(edge.to);
		if (from === undefined || to === undefined) continue;
		const highlighted = edge.on_rce_path === true || onPath.has(`${edge.from}\u0000${edge.to}`);
		const classes = ["edge", `relation-${edge.relation}`];
		if (highlighted) classes.push("on-rce-path");
		root.appendChild(
			svgElement("path", {
				class: classes.join(" "),
				d: pathBetween(from, to),
				"marker-end": "url(#arrow)",
				"stroke-width": highlighted ? 2.4 : 0.8 + Math.max(0, Math.min(1, Number(edge.weight) || 0.5)) * 1.4,
			}),
		);
	}
	for (const node of state.graph.nodes) {
		const position = state.positions.get(node.key);
		if (position === undefined) continue;
		const classes = ["node", `kind-${node.type}`];
		if (node.is_rce === true) classes.push("on-rce-path");
		if (state.selected === node.key) classes.push("selected");
		const group = svgElement("g", {
			class: classes.join(" "),
			transform: `translate(${position.x - NODE_W / 2} ${position.y - NODE_H / 2})`,
		});
		group.appendChild(svgElement("rect", { width: NODE_W, height: NODE_H, rx: 8, ry: 8 }));
		const title = svgElement("text", { class: "node-title", x: 12, y: 26 });
		title.textContent = truncate(node.title || node.key, 30);
		group.appendChild(title);
		const sub = svgElement("text", { class: "node-sub", x: 12, y: 44 });
		sub.textContent = truncate(`${node.type} · ${node.status ?? "open"} · risk ${node.risk_score ?? "-"}`, 34);
		group.appendChild(sub);
		const risk = Math.round(Number(node.risk_score) || 0);
		const badgeRect = svgElement("rect", {
			x: NODE_W - 46,
			y: 10,
			width: 34,
			height: 16,
			rx: 8,
			fill: risk >= 70 ? "#e0605d" : risk >= 40 ? "#e0a64a" : "#3b4a5a",
			stroke: "none",
		});
		group.appendChild(badgeRect);
		const badgeText = svgElement("text", { class: "node-badge", x: NODE_W - 29, y: 21 });
		badgeText.textContent = String(risk);
		group.appendChild(badgeText);
		group.addEventListener("click", (event) => {
			event.stopPropagation();
			if (state.drag?.moved === true) return;
			state.selected = node.key;
			renderDetail();
			renderGraph();
		});
		root.appendChild(group);
	}
	dom.svg.replaceChildren(defs, root);
	applyView();
	dom.empty.hidden = state.graph.nodes.length > 0;
	if (state.fitPending && state.graph.nodes.length > 0) {
		state.fitPending = false;
		fitView();
	}
}

function pathBetween(from, to) {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const angle = Math.atan2(dy, dx);
	const startX = from.x + Math.cos(angle) * (NODE_W * 0.48);
	const startY = from.y + Math.sin(angle) * (NODE_H * 0.48);
	const endX = to.x - Math.cos(angle) * (NODE_W * 0.56);
	const endY = to.y - Math.sin(angle) * (NODE_H * 0.56);
	const control = (startX + endX) / 2;
	return `M ${startX.toFixed(1)} ${startY.toFixed(1)} C ${control.toFixed(1)} ${startY.toFixed(1)}, ${control.toFixed(1)} ${endY.toFixed(1)}, ${endX.toFixed(1)} ${endY.toFixed(1)}`;
}

function applyView() {
	const viewport = dom.svg.querySelector(".viewport");
	if (viewport === null) return;
	viewport.setAttribute(
		"transform",
		`translate(${state.view.x.toFixed(2)} ${state.view.y.toFixed(2)}) scale(${state.view.scale.toFixed(3)})`,
	);
}

function fitView() {
	const positions = [...state.positions.values()];
	if (positions.length === 0) return;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const position of positions) {
		minX = Math.min(minX, position.x - NODE_W / 2);
		minY = Math.min(minY, position.y - NODE_H / 2);
		maxX = Math.max(maxX, position.x + NODE_W / 2);
		maxY = Math.max(maxY, position.y + NODE_H / 2);
	}
	const rect = dom.svg.getBoundingClientRect();
	const width = Math.max(1, rect.width);
	const height = Math.max(1, rect.height);
	const scale = Math.max(0.25, Math.min(1.25, 0.86 * Math.min(width / (maxX - minX + 80), height / (maxY - minY + 80))));
	state.view = {
		scale,
		x: width / 2 - ((minX + maxX) / 2) * scale,
		y: height / 2 - ((minY + maxY) / 2) * scale,
	};
	applyView();
}

/* ------------------------------------------------------------------ panels */

function refreshGraph() {
	renderStats();
	renderGraph();
	renderFindings();
	renderIntents();
	renderDetail();
}

function renderAll() {
	renderStatus();
	renderStats();
	renderGraph();
	renderFindings();
	renderIntents();
	renderFeed();
	renderDetail();
}

function renderFindings() {
	const findings = [...state.graph.findings].sort(
		(a, b) =>
			(SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
			(Number(b.created_at) || 0) - (Number(a.created_at) || 0),
	);
	dom.countFindings.textContent = String(findings.length);
	dom.findings.replaceChildren(
		...findings.map((finding) => {
			const item = element("div", "item");
			const head = element("div", "item-head");
			head.append(badge(finding.severity ?? "info", finding.severity), element("span", "item-title", finding.title || finding.id));
			item.appendChild(head);
			item.appendChild(
				element(
					"div",
					"item-meta",
					`${finding.category ?? "general"} · ${finding.verification_status ?? "pending"} · ${timeOf(finding.created_at)}`,
				),
			);
			const body = [clip(finding.description, 1200), clip(finding.evidence, 1600)].filter((part) => part !== "");
			if (body.length > 0) item.appendChild(element("div", "item-body", body.join("\n\n")));
			if (typeof finding.node_key === "string") {
				item.addEventListener("click", () => {
					state.selected = finding.node_key;
					renderDetail();
					renderGraph();
				});
			}
			return item;
		}),
	);
	if (findings.length === 0) dom.findings.appendChild(element("div", "item-meta", "no findings yet"));
}

function renderIntents() {
	const intents = [...state.graph.intents];
	dom.countIntents.textContent = String(intents.length);
	dom.intents.replaceChildren(
		...intents.map((intent) => {
			const item = element("div", "item");
			const head = element("div", "item-head");
			head.append(
				badge(intent.status ?? "open", intent.status),
				element("span", "item-title", intent.description || intent.id),
			);
			item.appendChild(head);
			const probability = Math.round((Number(intent.est_success) || 0) * 100);
			item.appendChild(
				element(
					"div",
					"item-meta",
					`est ${probability}% · from ${(intent.from ?? []).join(", ") || "-"}${intent.strategy_key === undefined ? "" : ` · ${intent.strategy_key}`}`,
				),
			);
			const body = [clip(intent.rationale, 600), clip(intent.result_summary, 800)].filter((part) => part !== "");
			if (body.length > 0) item.appendChild(element("div", "item-body", body.join("\n")));
			return item;
		}),
	);
	if (intents.length === 0) dom.intents.appendChild(element("div", "item-meta", "no intents yet"));
}

function renderFeed() {
	const nearBottom = dom.events.scrollHeight - dom.events.scrollTop - dom.events.clientHeight < 48;
	const visible = state.feed.slice(-MAX_FEED_DOM);
	dom.countEvents.textContent = String(state.feed.length);
	dom.events.replaceChildren(
		...visible.map((entry) => {
			const line = element("div", "feed-line");
			line.dataset.level = entry.level ?? "info";
			line.append(
				element("span", "feed-time", timeOf(entry.ts)),
				element("span", "feed-kind", entry.kind),
				element("span", "feed-text", entry.text),
			);
			return line;
		}),
	);
	if (nearBottom) dom.events.scrollTop = dom.events.scrollHeight;
}

function renderDetail() {
	if (state.selected === undefined) {
		dom.detail.hidden = true;
		return;
	}
	const node = state.graph.nodes.find((candidate) => candidate.key === state.selected);
	if (node === undefined) {
		state.selected = undefined;
		dom.detail.hidden = true;
		return;
	}
	dom.detail.hidden = false;
	dom.detailTitle.textContent = node.title || node.key;
	const tags = Array.isArray(node.tags) ? node.tags.join(" ") : "";
	dom.detailMeta.textContent = `${node.type} · ${node.severity} · risk ${node.risk_score} · ${node.status}${tags === "" ? "" : `\n${tags}`}`;
	dom.detailJson.textContent = JSON.stringify(node.detail ?? {}, null, 2);
}

/* --------------------------------------------------------------- interaction */

function notice(text, tone = "info") {
	dom.notice.textContent = text;
	dom.notice.dataset.tone = tone;
	dom.notice.hidden = false;
	if (state.noticeTimer !== undefined) clearTimeout(state.noticeTimer);
	state.noticeTimer = setTimeout(() => {
		dom.notice.hidden = true;
		state.noticeTimer = undefined;
	}, 4000);
}

async function sendSteer() {
	const content = dom.input.value.trim();
	if (content === "") return;
	dom.send.disabled = true;
	try {
		const response = await fetch("./api/steer", {
			method: "POST",
			headers: { "content-type": "application/json", "x-tg-sec-steer": "1" },
			body: JSON.stringify({ content }),
		});
		if (response.ok) {
			dom.input.value = "";
			return;
		}
		if (response.status === 403) notice("steer refused: the request origin did not match", "error");
		else if (response.status === 404) {
			state.expired = true;
			renderStatus();
			notice("session expired: reopen the ticket URL printed by tg-sec serve", "error");
		} else notice(`steer failed (${response.status})`, "error");
	} catch (error) {
		notice(`steer failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		dom.send.disabled = false;
	}
}

dom.svg.addEventListener("wheel", (event) => {
	event.preventDefault();
	const rect = dom.svg.getBoundingClientRect();
	const px = event.clientX - rect.left;
	const py = event.clientY - rect.top;
	const factor = Math.exp(-event.deltaY * 0.0012);
	const scale = Math.max(0.25, Math.min(2.6, state.view.scale * factor));
	const ratio = scale / state.view.scale;
	state.view = {
		scale,
		x: px - (px - state.view.x) * ratio,
		y: py - (py - state.view.y) * ratio,
	};
	applyView();
});

dom.svg.addEventListener("pointerdown", (event) => {
	if (event.button !== 0) return;
	state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, originX: state.view.x, originY: state.view.y, moved: false };
	dom.svg.setPointerCapture(event.pointerId);
	dom.svg.classList.add("dragging");
});

dom.svg.addEventListener("pointermove", (event) => {
	const drag = state.drag;
	if (drag === undefined || drag.id !== event.pointerId) return;
	const dx = event.clientX - drag.x;
	const dy = event.clientY - drag.y;
	if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
	state.view = { ...state.view, x: drag.originX + dx, y: drag.originY + dy };
	applyView();
});

function endDrag(event) {
	const drag = state.drag;
	if (drag === undefined || drag.id !== event.pointerId) return;
	state.drag = undefined;
	dom.svg.classList.remove("dragging");
	if (!drag.moved && state.selected !== undefined) {
		state.selected = undefined;
		renderDetail();
		renderGraph();
	}
}

dom.svg.addEventListener("pointerup", endDrag);
dom.svg.addEventListener("pointercancel", endDrag);
dom.svg.addEventListener("click", (event) => {
	if (event.target === dom.svg) {
		state.selected = undefined;
		renderDetail();
		renderGraph();
	}
});

dom.fit.addEventListener("click", () => {
	state.fitPending = false;
	fitView();
});

for (const button of document.querySelectorAll("#tabs button")) {
	button.addEventListener("click", () => {
		const tab = button.dataset.tab;
		if (tab === undefined) return;
		state.tab = tab;
		for (const other of document.querySelectorAll("#tabs button")) other.classList.toggle("active", other === button);
		document.getElementById("panel-findings").classList.toggle("active", tab === "findings");
		document.getElementById("panel-intents").classList.toggle("active", tab === "intents");
		document.getElementById("panel-events").classList.toggle("active", tab === "events");
	});
}

document.getElementById("detail-close").addEventListener("click", () => {
	state.selected = undefined;
	renderDetail();
	renderGraph();
});

dom.send.addEventListener("click", () => {
	void sendSteer();
});
dom.input.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.isComposing) {
		event.preventDefault();
		void sendSteer();
	}
});

setInterval(() => {
	if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: "ping" }));
}, 20_000);

renderAll();
connect();
