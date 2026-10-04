#!/usr/bin/env sh
# TianGong test entrypoint.
#
# `bun run test` calls scripts/test.ts, which walks the workspace in dependency order.
# This shell wrapper exists for CI and for humans who want the same behaviour without
# remembering the flag spelling.
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$repo_root"

exec bun run scripts/test.ts "$@"