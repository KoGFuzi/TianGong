# Environment Variables

TianGong uses environment variables in three ways:

- Variables such as `TG_OFFLINE` configure the TianGong process.
- TianGong sets process markers so child processes can identify TianGong as the launching agent.
- Commands run by the LLM-callable shell tools receive `TG_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=tg` is a generic marker that lets tooling identify TianGong as the agent that launched the process.
- `TG_CODING_AGENT=true` is TianGong-specific and lets child processes detect that they run inside TianGong.

Child processes inherit both markers. They are not session-specific and are not set automatically when TianGong is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current TianGong session state:

| Variable | Description |
|----------|-------------|
| `TG_SESSION_ID` | Current session ID |
| `TG_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `TG_PROVIDER` | Currently selected model provider |
| `TG_MODEL` | Currently selected model ID |
| `TG_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting TianGong. `TG_PROVIDER` and `TG_MODEL` identify the selected TianGong model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$TG_PROVIDER" "$TG_MODEL"
printf 'reasoning=%s session=%s\n' "$TG_REASONING_LEVEL" "$TG_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$TG_SESSION_FILE" ]; then
  tail -n 1 "$TG_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with TianGong. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, TianGong removes inherited values for these variables so nested TianGong processes do not expose stale parent-session metadata.

## TianGong Process Configuration

These variables are read by TianGong itself:

| Variable | Description |
|----------|-------------|
| `TG_CODING_AGENT_DIR` | Override the config directory; default is `~/.tiangong/agent` |
| `TG_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `TG_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `TG_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `TG_SKIP_VERSION_CHECK` | Disable the `tg.dev` latest-version request |
| `TG_PROVIDER_ATTRIBUTION` | Enable provider attribution headers for selected providers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `TG_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `TG_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `TG_RADIUS_GATEWAY` | Override the Radius gateway origin used by `/bug` uploads |
| `TG_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `TG_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as TianGong does over SSH. Use it when a remote client reaches TianGong without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `TG_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `TG_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise TianGong reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `TG_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `TG_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `TG_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).
