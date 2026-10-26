import { randomBytes } from "node:crypto";
import net from "node:net";

/** One decoded WebSocket frame, as either side sent it. */
export type TestWsFrame = {
	readonly opcode: number;
	readonly payload: Buffer;
};

type TextWaiter = {
	readonly resolve: (text: string) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
};

type FrameWaiter = {
	readonly opcode: number;
	readonly resolve: (frame: TestWsFrame) => void;
	readonly timer: NodeJS.Timeout;
};

const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PONG = 0xa;

/**
 * A minimal RFC 6455 client for the tests: masked text frames out, unmasked frames in, ping
 * answered automatically. It deliberately avoids the platform `WebSocket`, whose constructor has
 * no way to attach the session cookie the sidecar authenticates.
 */
export class TestWsClient {
	readonly frames: TestWsFrame[] = [];
	readonly handshake: string;
	readonly key: string;
	private readonly socket: net.Socket;
	private buffer: Buffer = Buffer.alloc(0);
	private texts: string[] = [];
	private textWaiters: TextWaiter[] = [];
	private frameWaiters: FrameWaiter[] = [];
	private closeCode: number | undefined;
	private closeWaiters: ((code: number | undefined) => void)[] = [];
	private isClosed = false;

	private constructor(socket: net.Socket, handshake: string, key: string, head: Buffer) {
		this.socket = socket;
		this.handshake = handshake;
		this.key = key;
		socket.on("data", (chunk: Buffer) => this.feed(chunk));
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
		if (head.length > 0) this.feed(head);
	}

	static async connect(url: URL, headers: Record<string, string> = {}): Promise<TestWsClient> {
		const socket = net.connect({ host: url.hostname, port: Number(url.port) });
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			const key = randomBytes(16).toString("base64");
			const lines = [
				`GET ${url.pathname}${url.search} HTTP/1.1`,
				`Host: ${url.host}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${key}`,
				"Sec-WebSocket-Version: 13",
				...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			];
			socket.write(`${lines.join("\r\n")}\r\n\r\n`);

			const { response, rest } = await readHandshake(socket);
			if (!response.startsWith("HTTP/1.1 101")) {
				socket.destroy();
				throw new Error(`handshake rejected: ${response.split("\r\n")[0]}`);
			}
			return new TestWsClient(socket, response, key, rest);
		} catch (error) {
			socket.destroy();
			throw error;
		}
	}

	sendText(text: string): void {
		this.sendFrame(OPCODE_TEXT, Buffer.from(text, "utf8"));
	}

	sendFrame(opcode: number, payload: Buffer, options: { fin?: boolean; masked?: boolean } = {}): void {
		const fin = options.fin ?? true;
		const masked = options.masked ?? true;
		const header: number[] = [];
		header.push((fin ? 0x80 : 0) | opcode);
		const maskBit = masked ? 0x80 : 0;
		if (payload.length < 126) {
			header.push(maskBit | payload.length);
		} else if (payload.length < 65536) {
			header.push(maskBit | 126, payload.length >> 8, payload.length & 0xff);
		} else {
			header.push(
				maskBit | 127,
				0,
				0,
				0,
				0,
				payload.length >>> 24,
				payload.length >>> 16,
				payload.length >>> 8,
				payload.length,
			);
		}
		if (!masked) {
			this.socket.write(Buffer.concat([Buffer.from(header), payload]));
			return;
		}
		const mask = randomBytes(4);
		const body = Buffer.from(payload);
		for (let index = 0; index < body.length; index += 1) body[index] = body[index]! ^ mask[index % 4]!;
		this.socket.write(Buffer.concat([Buffer.from(header), mask, body]));
	}

	async nextText(timeoutMs = 2000): Promise<string> {
		const queued = this.texts.shift();
		if (queued !== undefined) return queued;
		return new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.textWaiters = this.textWaiters.filter((waiter) => waiter.timer !== timer);
				reject(new Error("timed out waiting for a text frame"));
			}, timeoutMs);
			this.textWaiters.push({ resolve, reject, timer });
		});
	}

	async nextJson<T = unknown>(timeoutMs = 2000): Promise<T> {
		return JSON.parse(await this.nextText(timeoutMs)) as T;
	}

	/** The next JSON frame matching `predicate`; non-matching frames are discarded. */
	async waitForJson<T = unknown>(predicate: (value: unknown) => boolean, timeoutMs = 2000): Promise<T> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error("timed out waiting for a matching frame");
			const value = JSON.parse(await this.nextText(remaining)) as unknown;
			if (predicate(value)) return value as T;
		}
	}

	/** The first frame with `opcode`, waiting for it when it has not arrived yet. */
	waitForFrame(opcode: number, timeoutMs = 2000): Promise<TestWsFrame> {
		const existing = this.frames.find((frame) => frame.opcode === opcode);
		if (existing !== undefined) return Promise.resolve(existing);
		return new Promise<TestWsFrame>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.frameWaiters = this.frameWaiters.filter((waiter) => waiter.timer !== timer);
				reject(new Error(`timed out waiting for opcode ${opcode}`));
			}, timeoutMs);
			this.frameWaiters.push({ opcode, resolve, timer });
		});
	}

	waitForClose(timeoutMs = 2000): Promise<number | undefined> {
		if (this.isClosed) return Promise.resolve(this.closeCode);
		return new Promise<number | undefined>((resolve, reject) => {
			let timer: NodeJS.Timeout | undefined;
			const wrapped = (code: number | undefined): void => {
				if (timer !== undefined) clearTimeout(timer);
				resolve(code);
			};
			timer = setTimeout(() => {
				this.closeWaiters = this.closeWaiters.filter((waiter) => waiter !== wrapped);
				reject(new Error("timed out waiting for the socket to close"));
			}, timeoutMs);
			this.closeWaiters.push(wrapped);
		});
	}

	close(code = 1000): void {
		const body = Buffer.alloc(2);
		body.writeUInt16BE(code, 0);
		this.sendFrame(OPCODE_CLOSE, body);
		this.socket.end();
	}

	private feed(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		for (;;) {
			if (this.buffer.length < 2) return;
			const first = this.buffer[0]!;
			const second = this.buffer[1]!;
			let length = second & 0x7f;
			let offset = 2;
			if ((second & 0x80) !== 0) throw new Error("server frame must not be masked");
			if (length === 126) {
				if (this.buffer.length < 4) return;
				length = this.buffer.readUInt16BE(2);
				offset = 4;
			} else if (length === 127) {
				if (this.buffer.length < 10) return;
				length = Number(this.buffer.readBigUInt64BE(2));
				offset = 10;
			}
			if (this.buffer.length < offset + length) return;
			const opcode = first & 0x0f;
			const fin = (first & 0x80) !== 0;
			const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
			this.buffer = this.buffer.subarray(offset + length);
			this.handleFrame(opcode, payload, fin);
			if (this.isClosed) return;
		}
	}

	private handleFrame(opcode: number, payload: Buffer, fin: boolean): void {
		this.frames.push({ opcode, payload });
		const waiterIndex = this.frameWaiters.findIndex((waiter) => waiter.opcode === opcode);
		if (waiterIndex !== -1) {
			const waiter = this.frameWaiters.splice(waiterIndex, 1)[0]!;
			clearTimeout(waiter.timer);
			waiter.resolve({ opcode, payload });
		}
		if (opcode === 0x9) {
			this.sendFrame(OPCODE_PONG, payload);
			return;
		}
		if (opcode === 0xa) return;
		if (opcode === OPCODE_CLOSE) {
			this.closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
			this.finish();
			return;
		}
		if (opcode === OPCODE_TEXT && fin) {
			const text = payload.toString("utf8");
			const waiter = this.textWaiters.shift();
			if (waiter !== undefined) {
				clearTimeout(waiter.timer);
				waiter.resolve(text);
			} else {
				this.texts.push(text);
			}
		}
	}

	private finish(): void {
		if (this.isClosed) return;
		this.isClosed = true;
		for (const waiter of this.textWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("socket closed"));
		}
		for (const waiter of this.frameWaiters.splice(0)) clearTimeout(waiter.timer);
		for (const waiter of this.closeWaiters.splice(0)) waiter(this.closeCode);
	}
}

function readHandshake(socket: net.Socket): Promise<{ response: string; rest: Buffer }> {
	return new Promise((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end === -1) return;
			socket.off("data", onData);
			socket.off("close", onClose);
			socket.off("error", onError);
			resolve({ response: buffer.subarray(0, end).toString("latin1"), rest: buffer.subarray(end + 4) });
		};
		const onClose = (): void => {
			socket.off("data", onData);
			reject(new Error("socket closed before the handshake response"));
		};
		const onError = (error: Error): void => {
			socket.off("data", onData);
			reject(error);
		};
		socket.on("data", onData);
		socket.once("close", onClose);
		socket.once("error", onError);
	});
}
