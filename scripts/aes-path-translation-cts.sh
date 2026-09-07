#!/usr/bin/env bash
# Purpose: run the experimental AES source/event path translation target across all AEON implementations.
# Run from: any directory.
set -euo pipefail

AEON_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAMILY_ROOT="$(cd "$AEON_ROOT/../.." && pwd)"
CTS_MANIFEST="$FAMILY_ROOT/aeonite-org/aeonite-cts/cts/aes/v0/aes-path-translation-cts.v0.next.json"
RUNNER="$AEON_ROOT/scripts/cts-source-lane-runner.mjs"

node "$AEON_ROOT/scripts/ensure-typescript-build.mjs"
cargo build --manifest-path "$AEON_ROOT/implementations/rust/Cargo.toml" -p aeon-cli

run_target() {
  local label="$1"
  local sut="$2"
  echo "-- $label"
  node "$RUNNER" \
    --sut "$sut" \
    --cts "$CTS_MANIFEST" \
    --lane aes-path-translation
}

run_target "TypeScript" "$AEON_ROOT/implementations/typescript/packages/cli/dist/main.js"
run_target "Rust" "$AEON_ROOT/implementations/rust/target/debug/aeon-rust"
run_target "Python" "$AEON_ROOT/implementations/python/bin/aeon-python"
run_target "PHP" "$FAMILY_ROOT/altopelago/aeon-php/bin/aeon-php"
