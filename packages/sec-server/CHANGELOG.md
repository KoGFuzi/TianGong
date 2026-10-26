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
- Test suites: pure projection and frame-diff tests, the ticket/cookie lifecycle, the WebSocket
  handshake and close-code matrix, a boundary test that keeps the package on chord + gibraltar, and
  an end-to-end test over a real `Harness` (login, snapshot, ping, steering, shutdown).
