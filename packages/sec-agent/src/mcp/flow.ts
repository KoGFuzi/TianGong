/**
 * The packet a yak http-flow reference resolves to: the request and response bytes are the two
 * bodies the evidence store freezes, with the same descriptive metadata an exchange capture carries.
 * The bridge fetches it through `fetch_http_packet_by_id`; the evidence tool only sees this shape.
 */
export type TgSecFlowPacket = {
	readonly request: Uint8Array;
	readonly response: Uint8Array;
	readonly url?: string;
	readonly method?: string;
	readonly status?: number;
	readonly contentType?: string;
	readonly reqHead?: string;
	readonly respHead?: string;
};

/**
 * Resolve one flow id to its packet. The MCP bridge supplies this; `evidence_capture` accepts it as
 * an injected seam so the flow path is testable without a live yak instance.
 */
export type TgSecFlowFetcher = (flowId: string) => Promise<TgSecFlowPacket>;
