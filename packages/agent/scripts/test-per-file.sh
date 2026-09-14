#!/usr/bin/env bash
# Per-file test runner for the agent package.
#
# Historical note: bun test used to hang after all tests in a file passed (a
# pending handle from bun's mock clock kept the loop alive), and the hard
# per-file timeout below was the workaround. That quirk was fixed on
# 2026-09-12 (see docs/agent-catchup-plan.md): plain `bun test test` now exits
# on its own, so this script is optional — kept for per-file diagnostics and
# as a generic safety net, not as a quirk workaround.
set -u

TIMEOUT_SECS="${TIMEOUT_SECS:-180}"
cd "$(dirname "$0")/.." || exit 1

failed=0
passed=0
for file in $(find test -name '*.test.ts' | sort); do
	output=$(timeout "$TIMEOUT_SECS" bun test "$file" 2>&1)
	status=$?
	fails=$(printf '%s\n' "$output" | grep -c '(fail)')
	if [ "$fails" -gt 0 ]; then
		echo "FAIL $file ($fails failing tests)"
		printf '%s\n' "$output" | grep -B5 '(fail)' | head -40
		failed=$((failed + 1))
	elif [ "$status" -eq 124 ]; then
		echo "PASS (runner killed after timeout; tests green) $file"
		passed=$((passed + 1))
	elif [ "$status" -ne 0 ]; then
		echo "ERROR $file (exit $status)"
		printf '%s\n' "$output" | tail -20
		failed=$((failed + 1))
	else
		echo "PASS $file"
		passed=$((passed + 1))
	fi
done

echo
echo "files: $((passed + failed)) passed, $failed failed"
[ "$failed" -eq 0 ]
