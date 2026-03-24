#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_DIR="$ROOT_DIR/implementations/typescript"
RUST_DIR="$ROOT_DIR/implementations/rust"

usage() {
  cat <<'EOF'
Usage: bash ./scripts/canonical-cts.sh [--mode <transport|strict|custom|all>] [--brief]

Runs the canonical conformance lane:
  1. TypeScript canonical package tests
  2. Rust canonical package tests
  3. Cross-implementation canonical snippet parity

Examples:
  bash ./scripts/canonical-cts.sh
  bash ./scripts/canonical-cts.sh --mode strict
  bash ./scripts/canonical-cts.sh --brief
EOF
}

selected_mode="all"
brief=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)
      if [[ $# -lt 2 ]]; then
        echo "Error: Missing value for --mode" >&2
        usage >&2
        exit 2
      fi
      selected_mode="$2"
      shift 2
      ;;
    --brief)
      brief=1
      shift
      ;;
    --help|-h|help)
      usage
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$selected_mode" in
  transport|strict|custom|all) ;;
  *)
    echo "Error: Invalid value for --mode: $selected_mode" >&2
    usage >&2
    exit 2
    ;;
esac

echo "== Canonical CTS =="
echo

echo "-- TypeScript canonical package tests"
(cd "$TS_DIR" && pnpm --filter @aeon/canonical test)
echo

echo "-- Rust canonical package tests"
(cd "$RUST_DIR" && cargo test -p aeon-canonical -- --nocapture)
echo

echo "-- Cross-implementation canonical snippet parity"
parity_cmd=(python3 "$ROOT_DIR/scripts/stress-canonical-snippets.py" --mode "$selected_mode")
if [[ "$brief" -eq 1 ]]; then
  parity_cmd+=(--brief)
fi
"${parity_cmd[@]}"

