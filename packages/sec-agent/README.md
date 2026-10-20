# @OnePanda-TgSec/tg-sec-agent

TianGong's coding agent CLI: read, bash, edit, and write tools, session management, extensions,
skills, prompt templates, and themes. The `tg` binary is this package.

The package was adopted from the pi agent project's `pi-coding-agent` and brought under the
TianGong house standard. See [`docs/provenance.md`](../../docs/provenance.md) for what changed and
what was deliberately left alone.

## Build and run from the workspace

```bash
bun install --ignore-scripts
bun run build
bun packages/sec-agent/src/cli.ts       # run from source
./packages/sec-agent/dist/cli.js        # run the built CLI
```

`bun run test packages/sec-agent` runs this package's Vitest suite. `bun run check` runs the house
standard, formatting, types, and relative-import checks.

## Configuration

Settings and user resources live under the config root; machine-generated state lives under the data
root:

```text
~/.config/TianGong/          settings.json, models.json, themes, prompts, tools
~/.local/share/TianGong/     auth.json, sessions, logs
<project>/.tiangong/         project extensions, skills, MCP servers, packages
```

`TG_CODING_AGENT_DIR` relocates both roots to one directory, which is what tests and embedded
processes use. `@OnePanda-TgSec/tg-ai/config-paths` resolves every root and honors the standard
`XDG_*` variables.

Upstream-hosted services do not carry over. These features stay inert until configured:

| Variable | Feature |
| --- | --- |
| `TG_VERSION_CHECK_URL` | Release feed for the startup version check |
| `TG_MODEL_CATALOG_URL` | Remote model-catalog overlay |
| `TG_MCP_CLIENT_METADATA_BASE_URL` | MCP Client ID Metadata Document host |
| `TG_INSTALLER_API_BASE` | Managed-install update artifacts |
| `TG_SHARE_VIEWER_URL` | Session viewer used by `/share` |

Everything else is local. Provider credentials are written to `~/.local/share/TianGong/auth.json`.

## Documentation

Start at [`docs/index.md`](docs/index.md): usage, CLI and RPC modes, extensions, skills, settings,
providers, sessions, and the SDK.

## License

MIT
