# Security Policy

## Reporting a vulnerability

Do not open a public issue. Report privately to the maintainer of
<https://github.com/KoGFuzi/TianGong> with:

- the affected package and version,
- a description of the impact and the conditions under which it triggers,
- a proof of concept or reproduction steps,
- the Bun and Node versions you tested against.

You will get an acknowledgement within three business days and a fix or mitigation plan within ten.

## Threat model

TianGong handles credentials and executes tool calls, so these are in scope:

| Area | Concern |
| --- | --- |
| Provider credentials | API keys, OAuth tokens, and refresh tokens for model providers and MCP servers. See `packages/ai/src/auth` and `packages/mcp/src/oauth`. |
| Durable storage | Conversation transcripts, tool results, and documents written by `packages/gibraltar`. Storage backends are local files; treat the SQLite and JSONL files as sensitive. |
| Sandbox escape | `packages/codemode` runs model-authored JavaScript in QuickJS/WASI. Escape from the sandbox is in scope. |
| Tool execution | `packages/agent` and `packages/gibraltar` execute tools. Path traversal, argument injection, and unvalidated command construction are in scope. |
| MCP transports | `packages/mcp` speaks to servers over stdio and Streamable HTTP, including OAuth. Server impersonation, redirect handling, and token leakage are in scope. |

Out of scope: denial of service against someone else's deployment, and issues that require an
already-compromised local machine.

## Vendored packages

`packages/codemode` and `packages/mcp` are migrated verbatim from
[pi agent](https://github.com/earendil-works/pi). Report a vulnerability in them **upstream** at
<https://github.com/earendil-works/pi/issues>, and tell us so we can track the fix and re-sync. See
[`docs/provenance.md`](docs/provenance.md).

## Hardening notes

- Install with `bun install --ignore-scripts`. Lifecycle scripts do not run unless you ask for them.
- Do not commit `.env` files, keys, or session databases. `.gitignore` covers `.env*` and `dist/`.
- `packages/ai/src/providers/data/` is generated from public catalogs. Review
  `bun run generate:models` output before committing a regeneration.