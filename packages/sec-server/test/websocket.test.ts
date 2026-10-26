import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { acceptWebSocket, type SecWebSocket } from "../src/websocket.ts";
import { TestWsClient } from "./websocket-client.ts";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;

type EchoServer = {
	readonly url: URL;
	readonly received: string[];
	readonly clients: SecWebSocket[];
	stop(): Promise<void>;
};

const running: EchoServer[] = [];

afterEach(async () => {
	for (const server of running.splice(0)) await server.stop();
});

async function startEchoServer(): Promise<EchoServer> {
	const received: string[] = [];
	const clients: SecWebSocket[] = [];
	const server: Server = createServer();
	server.on("upgrade", (request, socket, head) => {
		const client = acceptWebSocket(request, socket, head);
		if (client === undefined) return;
		clients.push(client);
		client.onMessage((text) => {
			received.push(text);
			client.send({ echo: text });
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const port = (server.address() as AddressInfo).port;
	const echo: EchoServer = {
		url: new URL(`ws://127.0.0.1:${port}/socket`),
		received,
		clients,
		stop: () =>
			new Promise<void>((resolve) => {
				for (const client of clients) client.close(1001, "done");
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
	running.push(echo);
	return echo;
}

describe("acceptWebSocket", () => {
	test("completes the RFC 6455 handshake", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		const accept = createHash("sha1").update(`${client.key}${WS_GUID}`).digest("base64");
		expect(client.handshake).toContain("HTTP/1.1 101 Switching Protocols");
		expect(client.handshake).toContain(`Sec-WebSocket-Accept: ${accept}`);
		client.close();
	});

	test("delivers a masked text frame and sends JSON back", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendText('{"type":"ping"}');
		expect(await client.nextJson()).toEqual({ echo: '{"type":"ping"}' });
		expect(server.received).toEqual(['{"type":"ping"}']);
		client.close();
	});

	test("assembles a fragmented message", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(0x1, Buffer.from('{"type":', "utf8"), { fin: false });
		client.sendFrame(0x0, Buffer.from('"ping"}', "utf8"));
		expect(await client.nextJson()).toEqual({ echo: '{"type":"ping"}' });
		client.close();
	});

	test("answers a client ping with a pong", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(OPCODE_PING, Buffer.from("hello"));
		const pong = await client.waitForFrame(OPCODE_PONG);
		expect(pong.payload.toString()).toBe("hello");
		client.close();
	});

	test("closes a connection whose client frame is not masked", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(0x1, Buffer.from("unmasked", "utf8"), { masked: false });
		expect(await client.waitForClose()).toBe(1002);
	});

	test("closes on a binary frame", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(0x2, Buffer.from([0x00, 0x01]));
		expect(await client.waitForClose()).toBe(1003);
	});

	test("closes on invalid UTF-8", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(0x1, Buffer.from([0xff, 0xfe]));
		expect(await client.waitForClose()).toBe(1007);
	});

	test("closes on a continuation without a started message", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.sendFrame(0x0, Buffer.from("orphan", "utf8"));
		expect(await client.waitForClose()).toBe(1002);
	});

	test("echoes a close frame's code", async () => {
		const server = await startEchoServer();
		const client = await TestWsClient.connect(server.url);

		client.close(4001);
		expect(await client.waitForClose()).toBe(4001);
	});

	test("rejects an upgrade without a key", async () => {
		const server = await startEchoServer();
		const port = server.url.port;
		const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
		const response = await new Promise<string>((resolve, reject) => {
			let text = "";
			socket.on("data", (chunk: Buffer) => {
				text += chunk.toString("latin1");
				if (text.includes("\r\n\r\n")) {
					socket.destroy();
					resolve(text);
				}
			});
			socket.on("error", reject);
			socket.write(
				"GET /socket HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
					"Sec-WebSocket-Version: 13\r\n\r\n",
			);
		});
		expect(response).toContain("HTTP/1.1 426 Upgrade Required");
	});
});
