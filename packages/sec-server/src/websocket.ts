import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_SOCKET_BUFFER = 4 * 1024 * 1024;

const OPCODE_CONTINUATION = 0x0;
const OPCODE_TEXT = 0x1;
const OPCODE_BINARY = 0x2;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

/** One accepted WebSocket connection; text messages in, JSON text messages out. */
export interface SecWebSocket {
	readonly closed: boolean;
	/** Serialize and send one JSON frame. */
	send(frame: unknown): void;
	/** Send a protocol ping; the browser answers with a pong frame automatically. */
	ping(): void;
	close(code?: number, reason?: string): void;
	onMessage(listener: (text: string) => void): void;
	onClose(listener: () => void): void;
}

/** Refuse an upgrade without leaking anything about the server. */
export function rejectWebSocket(socket: Duplex, status: number, reason: string): void {
	try {
		socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	} finally {
		socket.destroy();
	}
}

/**
 * Finish the RFC 6455 handshake on an HTTP upgrade. Client frames must be masked, data frames are
 * text only, fragments are accumulated up to {@link MAX_MESSAGE_BYTES}, and control frames obey
 * their 125-byte limit. No dependency: the browser side is a plain `WebSocket`.
 */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, head: Buffer): SecWebSocket | undefined {
	if (request.method !== "GET") {
		rejectWebSocket(socket, 405, "Method Not Allowed");
		return undefined;
	}
	const upgrade = String(request.headers.upgrade ?? "").toLowerCase();
	const connection = String(request.headers.connection ?? "").toLowerCase();
	const key = request.headers["sec-websocket-key"];
	const version = request.headers["sec-websocket-version"];
	if (upgrade !== "websocket" || !connection.split(/\s*,\s*/u).includes("upgrade")) {
		rejectWebSocket(socket, 400, "Bad Request");
		return undefined;
	}
	if (version !== "13" || typeof key !== "string" || key.trim() === "") {
		rejectWebSocket(socket, 426, "Upgrade Required");
		return undefined;
	}
	const accept = createHash("sha1").update(`${key.trim()}${WS_GUID}`).digest("base64");
	socket.write(
		"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
			`Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	(socket as Duplex & { setNoDelay?: (noDelay?: boolean) => void }).setNoDelay?.(true);
	return new SecWebSocketConnection(socket, head);
}

class SecWebSocketConnection implements SecWebSocket {
	private readonly socket: Duplex;
	private readonly messageListeners = new Set<(text: string) => void>();
	private readonly closeListeners = new Set<() => void>();
	private pending: Buffer;
	private fragments: Buffer[] = [];
	private fragmentBytes = 0;
	private fragmenting = false;
	private closeSent = false;
	private closeNotified = false;
	private isClosed = false;

	constructor(socket: Duplex, head: Buffer) {
		this.socket = socket;
		this.pending = Buffer.alloc(0);
		socket.on("data", (chunk: Buffer) => this.feed(chunk));
		socket.on("end", () => this.finish());
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
		if (head.length > 0) this.feed(head);
	}

	get closed(): boolean {
		return this.isClosed;
	}

	send(frame: unknown): void {
		if (this.isClosed) return;
		const text = JSON.stringify(frame);
		if (text === undefined) return;
		if (this.socket.writableLength > MAX_SOCKET_BUFFER) {
			this.close(1009, "client too slow");
			return;
		}
		this.writeFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
	}

	ping(): void {
		if (!this.isClosed) this.writeFrame(OPCODE_PING, Buffer.alloc(0));
	}

	close(code = 1000, reason = ""): void {
		if (this.isClosed) return;
		this.isClosed = true;
		const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
		const body = Buffer.alloc(2 + reasonBytes.length);
		body.writeUInt16BE(code, 0);
		reasonBytes.copy(body, 2);
		if (!this.closeSent) {
			this.closeSent = true;
			this.writeFrame(OPCODE_CLOSE, body);
		}
		this.notifyClose();
		this.socket.end();
	}

	onMessage(listener: (text: string) => void): void {
		this.messageListeners.add(listener);
	}

	onClose(listener: () => void): void {
		this.closeListeners.add(listener);
	}

	private feed(chunk: Buffer): void {
		if (this.isClosed) return;
		this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		try {
			this.drain();
		} catch {
			this.close(1002, "protocol error");
		}
	}

	private drain(): void {
		for (;;) {
			if (this.pending.length < 2) return;
			const first = this.pending[0]!;
			const second = this.pending[1]!;
			const fin = (first & 0x80) !== 0;
			const reserved = (first & 0x70) !== 0;
			const opcode = first & 0x0f;
			const masked = (second & 0x80) !== 0;
			let length = second & 0x7f;
			let offset = 2;
			if (reserved) {
				this.close(1002, "reserved bits");
				return;
			}
			if (!masked) {
				this.close(1002, "unmasked client frame");
				return;
			}
			if (length === 126) {
				if (this.pending.length < offset + 2) return;
				length = this.pending.readUInt16BE(offset);
				offset += 2;
			} else if (length === 127) {
				if (this.pending.length < offset + 8) return;
				const high = this.pending.readUInt32BE(offset);
				const low = this.pending.readUInt32BE(offset + 4);
				if (high !== 0 || low > MAX_MESSAGE_BYTES) {
					this.close(1009, "message too large");
					return;
				}
				length = low;
				offset += 8;
			}
			if (length > MAX_MESSAGE_BYTES) {
				this.close(1009, "message too large");
				return;
			}
			const control = (opcode & 0x08) !== 0;
			if (control && (!fin || length > 125)) {
				this.close(1002, "bad control frame");
				return;
			}
			if (this.pending.length < offset + 4 + length) return;
			const mask = this.pending.subarray(offset, offset + 4);
			offset += 4;
			const payload = Buffer.from(this.pending.subarray(offset, offset + length));
			for (let index = 0; index < payload.length; index += 1) {
				payload[index] = payload[index]! ^ mask[index % 4]!;
			}
			this.pending = this.pending.subarray(offset + length);
			this.handleFrame(fin, opcode, payload);
			if (this.isClosed) return;
		}
	}

	private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
		switch (opcode) {
			case OPCODE_TEXT:
				if (this.fragmenting) {
					this.close(1002, "interleaved data frame");
					return;
				}
				this.deliver(fin, payload);
				return;
			case OPCODE_CONTINUATION:
				if (!this.fragmenting) {
					this.close(1002, "unexpected continuation");
					return;
				}
				this.fragments.push(payload);
				this.fragmentBytes += payload.length;
				if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
					this.close(1009, "message too large");
					return;
				}
				if (fin) {
					const complete = Buffer.concat(this.fragments);
					this.fragments = [];
					this.fragmentBytes = 0;
					this.fragmenting = false;
					this.deliver(true, complete);
				}
				return;
			case OPCODE_BINARY:
				this.close(1003, "text frames only");
				return;
			case OPCODE_CLOSE: {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
				this.close(code);
				return;
			}
			case OPCODE_PING:
				this.writeFrame(OPCODE_PONG, payload);
				return;
			case OPCODE_PONG:
				return;
			default:
				this.close(1002, "unknown opcode");
		}
	}

	private deliver(fin: boolean, payload: Buffer): void {
		if (!fin) {
			this.fragmenting = true;
			this.fragments = [payload];
			this.fragmentBytes = payload.length;
			return;
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		} catch {
			this.close(1007, "invalid utf-8");
			return;
		}
		for (const listener of [...this.messageListeners]) {
			try {
				listener(text);
			} catch {
				// One consumer's failure must not tear down the connection.
			}
		}
	}

	private writeFrame(opcode: number, payload: Buffer): void {
		const length = payload.length;
		let header: Buffer;
		if (length < 126) {
			header = Buffer.from([0x80 | opcode, length]);
		} else if (length < 65536) {
			header = Buffer.alloc(4);
			header[0] = 0x80 | opcode;
			header[1] = 126;
			header.writeUInt16BE(length, 2);
		} else {
			header = Buffer.alloc(10);
			header[0] = 0x80 | opcode;
			header[1] = 127;
			header.writeUInt32BE(0, 2);
			header.writeUInt32BE(length, 6);
		}
		this.socket.write(Buffer.concat([header, payload]));
	}

	private finish(): void {
		if (!this.isClosed) this.isClosed = true;
		this.notifyClose();
	}

	private notifyClose(): void {
		if (this.closeNotified) return;
		this.closeNotified = true;
		for (const listener of [...this.closeListeners]) {
			try {
				listener();
			} catch {
				// Close listeners are cleanup only.
			}
		}
	}
}
