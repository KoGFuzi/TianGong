# Contributing to TianGong

Read [`AGENTS.md`](AGENTS.md) first. It is the house standard, and it wins over anything written
here.

## Setup

```bash
bun install
bun run prepare          # installs .githooks/pre-commit
bun run generate:models  # required before building or testing @OnePanda-TgSec/tg-ai
```

## Before you open a change

1. `bun run check` — house standard, Biome, `tsc --noEmit`, relative-import rule. Fix every
   error, warning, and info.
2. `bun run test` — or `bun run test packages/<name>` for the package you touched. Never call
   `bun test`; it is Bun's built-in runner and ignores the per-package configuration.
3. `bun run build` if you changed anything a downstream package compiles against.

## Change shape

- Stage explicit paths. `git add -A` and `git add .` are not allowed: other sessions share this
  working directory and will lose work.
- Commit messages: `{feat,fix,docs,refactor,chore}[(package)]: <message>`. Package is one of
  `ai`, `tui`, `agent`, `gibraltar`, `chord`, `telemetry`, `mcp`, `codemode`, or omitted.
- Never `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, or
  `git commit --no-verify`.

## Vendored packages

`packages/codemode` and `packages/mcp` are migrated verbatim from pi agent and are frozen. Do not
edit them. If a vendored package needs to behave differently inside TianGong, put the adaptation in
the house package that calls it. If a vendored package should be replaced wholesale, follow the
re-sync procedure in [`docs/provenance.md`](docs/provenance.md).

## Changelog

Every user-visible change gets an entry under `## [Unreleased]` in the affected
`packages/*/CHANGELOG.md`, using the section order `Breaking Changes`, `Added`, `Changed`,
`Fixed`, `Removed`. Released version sections are immutable. Vendored packages are exempt.

## Dependencies

Direct dependencies are pinned to exact versions. Regenerate `bun.lock` with `bun install` after
any manifest change and treat the lockfile diff as reviewed code. Do not run lifecycle scripts
during install unless you are deliberately debugging one.

## Reporting bugs

Open an issue with the affected package, the Bun version (`bun --version`), the Node version
(`node --version`), a minimal reproduction, and the full output of the failing command. Regression
tests added for an issue carry a comment with the issue number.