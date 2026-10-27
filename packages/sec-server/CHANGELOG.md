# Changelog

## [Unreleased]

### Added

- New house package `@OnePanda-TgSec/tg-sec-server`, batch 6 of `docs/sec-agent-design.md`: a
  loopback sidecar that subscribes to a gibraltar conversation's `watchEvents` stream, projects the
  action tree and evidence store onto the StrikeAgent graph contract (nine node kinds, five
  relations, risk scoring, RCE-path marking and frontier mode), and serves a self-written WebUI.
- Wire contract (`contract.ts`): `SecGraph`, `SecGraphNode`, `SecGraphEdge`, `SecFinding`,
  `SecGraphIntent`, `SecRcePath`, `SecFrontier`, `SecGraphStats`, the `snapshot` frame, itemized
  `node`/`edge`/`finding`/`intent`/`rce_path` frames, timeline frames, and client `steer` /
  `refresh` / `ping`.
- Projection (`projection.ts`) is a pure function of the action tree and evidence metadata; the
  projector (`projector.ts`) diffs successive graphs and resynchronizes with a snapshot when an id
  disappears.
- Hand-written RFC 6455 server (`websocket.ts`): masked client frames, text only, fragmentation,
  control-frame limits, close codes, a 1 MiB message cap and a 4 MiB backpressure cap.
- Authentication (`auth.ts`): random 12-character entry path persisted at mode 0600, one-time
  login ticket with a 5-minute TTL, SHA-256-digest-keyed ticket/session maps, `HttpOnly`
  `SameSite=Strict` session cookie scoped to the entry path.
- HTTP server (`server.ts`): loopback bind and strict `Host` check, `Origin` check and a
  non-safelisted header on steering, `GET /api/graph`, `POST /api/steer`, WebSocket at
  `/ws`, CSP and hardened headers, heartbeat, debounced projection refresh, and ordered shutdown.
- Self-written WebUI (`web/`): layered SVG graph with pan/zoom and RCE-path highlighting, findings,
  intents and event tabs, node detail, steering composer, and automatic reconnect. No inline
  scripts or styles; the CSP allows only the package's own assets.
- Guard approvals over the same wire: a host-owned `SecApprovalQueue` parks each guard ask, the
  server broadcasts an `ask` frame (`id`, `toolName`, `resource`, `reason`, `forced`, and an
  argument summary with body-shaped keys redacted), accepts `ask_reply {allow|deny|always}` on the
  authenticated WebSocket, and replays every pending ask after each snapshot so a reconnect neither
  loses one nor keeps a settled one. Shutdown denies everything still waiting.
- The WebUI gains an always-visible pending-ask panel: forced asks show no `always` button (the
  guard grants only the one call), and every reply is sent as an `ask_reply` frame.
- Test suites: pure projection and frame-diff tests, the ticket/cookie lifecycle, the WebSocket
  handshake and close-code matrix, a boundary test that keeps the package on chord + gibraltar, and
  an end-to-end test over a real `Harness` (login, snapshot, ping, steering, shutdown).
- The projection reads registered findings through the optional `SecProjectionInput.findings`:
  rubric severity flows into the existing node/finding severity, the five lifecycle states map onto
  the existing verification vocabulary (`open → pending`, `verified`/`retest-pass → verified`,
  `retest-fail → rejected`, `wontfix → excluded`), and a lifecycle change emits the existing
  `finding` frame. No wire-contract field changed; an evidence subject without a finding row keeps
  the previous unrated projection.
- Plan and terminal projection: the optional `SecProjectionInput.plan` turns the newest plan
  revision's steps into the graph's intents (done → verified, dropped → disproved, active/open
  preserved) and replaces the action-derived fallback when a plan exists; a revision change that
  replaces intent ids resynchronizes with a snapshot. The optional `SecProjectionInput.terminals`
  adds `goal` nodes for lane claims. An unverified claim renders `info`/`unverified`, never counts
  as `has_shell`, and changes no finding; a verified `getshell` renders `critical` with `is_rce`,
  `has_shell`, and the target → goal RCE path, while a verified `getflag` uses the `high` floor.
