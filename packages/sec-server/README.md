# @OnePanda-TgSec/tg-sec-server

The campaign WebUI sidecar: it subscribes to a gibraltar conversation's event stream, projects the
action tree and evidence store onto the StrikeAgent graph contract, and serves a self-written,
dependency-free browser shell over loopback HTTP and WebSocket.

The package is the read/projection side of the campaign. It owns no agent loop, no storage and no
tool policy: the host (`tgsec --webui` in `@OnePanda-TgSec/tg-sec-agent`) hands it a harness, a
projection read, and a `steer` entry point. `sec-agent` depends on this package; this package depends
only on `chord` and `tg-gibraltar`.

## What it speaks

The wire literals are the StrikeAgent protocol's, kept verbatim (`docs/sec-agent-design.md` 批6):

- node kinds: `target`, `info`, `service`, `danger`, `vuln`, `credential`, `foothold`, `honeypot`, `goal`
- relations: `LEADS_TO`, `EXPLOITS`, `ESCALATES_TO`, `PIVOTS_TO`, `CONTAINS`
- verdicts: severities `info`/`low`/`medium`/`high`/`critical`, intent statuses `open`/`active`/
  `verified`/`disproved`/`deferred`, verification statuses `pending`/`verified`/`rejected`/`excluded`
- frames: one `snapshot` with the whole graph, then `node`/`edge`/`finding`/`intent`/`rce_path` for
  graph changes, `status`/`tool`/`tool_result`/`thought`/`steer`/`log`/`memory` for the timeline,
  and `ask` for a guard escalation waiting on the operator

`SecGraphProjector` diffs successive projections into those frames; a projection that loses an id
resynchronizes with a fresh snapshot. `SecRunProjector` translates gibraltar `AgentEvent`s. Tool
arguments are summarized and every body-shaped key (`body`, `requestBase64`, `bytes`, …) is replaced
with a byte count, so evidence bytes never reach the browser.

## Approvals

The sidecar owns no tool policy, but it does own the surface an operator uses to answer one. The
host creates a `SecApprovalQueue`, adapts its guard's ask channel onto `queue.ask`, and passes the
same queue as `host.approvals`. Each parked ask becomes an `ask` frame; the browser answers with
`ask_reply {id, reply: allow | deny | always}`. The queue stores only a summarized argument tree
(body-shaped keys are replaced with a byte count), replays its pending entries after every snapshot,
and denies everything still parked when the server shuts down. The meaning of `always` stays inside
sec-guard: a forced ask approves that call only, and an ordinary ask banks the exact `tool:<name>`
resource.

## Authentication

The server binds `127.0.0.1` by default and refuses any `Host` header that is not a loopback name on
its own port (DNS-rebinding guard). The entry path is 12 random characters, persisted at mode 0600.
A login URL carries a one-time ticket (5-minute TTL); redeeming it sets an `HttpOnly`,
`SameSite=Strict` cookie scoped to `/<entry>/` and redirects to the shell. Steers are `POST`s with
an `Origin` check and a non-safelisted `x-tg-sec-steer` header. `ask_reply` is a WebSocket frame, so
it inherits the upgrade gate instead: `Host`, `Origin`, the session cookie and `Sec-Fetch-Site` are
all checked before the socket is accepted (a browser cannot attach the custom steering header to a
WebSocket handshake). Every response carries `no-store`, `nosniff`, `DENY` framing and a strict CSP
that allows only the package's own script and style.

## Use

```ts
import { createSecApprovalQueue, startSecServer } from "@OnePanda-TgSec/tg-sec-server";

const approvals = createSecApprovalQueue();
const server = await startSecServer({
	host: {
		project: "campaign",
		target: "example.internal",
		harness: agent.harness,
		conversationId: agent.root.id,
		context,
		readProjection: async () => ({ actions: await agent.actionTree(context), evidence: await readEvidence() }),
		steer: async (content) => {
			await (
				await agent.root.submit(
					{ type: "input", content, whenBusy: "steer", entry: { kind: "sec.steer" } },
					context,
				)
			).wait(context);
		},
		approvals,
	},
	dataDir: join(dataDir, "sec-server"),
});
const ticket = server.issueTicket();
console.log(server.ticketUrl(ticket.ticket));
```

The host's guard ask channel is `(request, decision) => approvals.ask({ ... })`; see
`tg-sec-agent`'s `createApprovalAskChannel` for the adapter that fills in the fields.

The packaged `web/` shell is served as-is: `index.html`, `app.js` (layered SVG graph, pending guard
asks, findings, intents and event tabs, steering composer, reconnect) and `style.css`. No build
step, no external assets, no inline script or style.
