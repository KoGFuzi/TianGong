import http from "node:http";
import https from "node:https";

/** One outbound request the http tool asks the transport to perform. `body` is the request body, `""` for none. */
export type HttpRequest = {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
};

/** The response the transport hands back. `body` is the raw response bytes; nothing is decoded or truncated. */
export type HttpResponse = {
	readonly status: number;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: Uint8Array;
	readonly contentType: string;
};

/**
 * The seam the `http_request` tool calls to put bytes on the wire. Production injects
 * {@link nodeRequestExecutor}; a test injects its own so no request ever leaves the machine. It exists as an
 * injected interface rather than a direct `fetch` so the Node type program the `src` lives in never binds to a
 * global whose type differs under Bun — and so a tool test drives the exchange without an egress dependency.
 */
export type RequestExecutor = {
	send(request: HttpRequest): Promise<HttpResponse>;
};

const DEFAULT_TIMEOUT_MS = 15_000;

function flattenHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
	const flat: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		flat[name] = Array.isArray(value) ? value.join(", ") : value;
	}
	return flat;
}

/**
 * The production executor: `node:https`/`node:http`, one request per `send`, with a bounded timeout. **Redirects are
 * deliberately not followed** — for a scope-enforced tool a `3xx` that would bounce the request to another host must
 * stay the caller's decision, never a silent transport hop past the scope check. The request body is sent verbatim; the
 * response body is collected as raw bytes.
 */
export function nodeRequestExecutor(timeoutMs: number = DEFAULT_TIMEOUT_MS): RequestExecutor {
	return {
		send(request: HttpRequest): Promise<HttpResponse> {
			return new Promise<HttpResponse>((resolve, reject) => {
				let target: URL;
				try {
					target = new URL(request.url);
				} catch {
					reject(new TypeError(`http_request: ${request.url} is not a valid absolute URL`));
					return;
				}
				const options: http.RequestOptions = {
					method: request.method,
					headers: request.headers,
					timeout: timeoutMs,
				};
				const onResponse = (response: http.IncomingMessage): void => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => {
						resolve({
							status: response.statusCode ?? 0,
							headers: flattenHeaders(response.headers),
							body: Buffer.concat(chunks),
							contentType: response.headers["content-type"] ?? "",
						});
					});
					response.on("error", reject);
				};
				const handle =
					target.protocol === "https:"
						? https.request(target, options, onResponse)
						: http.request(target, options, onResponse);
				handle.on("timeout", () => handle.destroy(new Error(`http_request: timed out after ${timeoutMs}ms`)));
				handle.on("error", reject);
				if (request.body !== "") handle.write(request.body);
				handle.end();
			});
		},
	};
}
