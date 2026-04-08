#!/usr/bin/env bash
# Purpose: run canonical conformance checks across TS/Rust plus parity snippets.
# Run from: repo root.
# Example: bash ./scripts/canonical-cts.sh --mode all --brief
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_DIR="$ROOT_DIR/implementations/typescript"
RUST_DIR="$ROOT_DIR/implementations/rust"
PY_DIR="$ROOT_DIR/implementations/python"

resolve_python() {
  local candidate
  for candidate in python3.14 python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

usage() {
  cat <<'EOF'
Usage: bash ./scripts/canonical-cts.sh [--mode <transport|strict|custom|all>] [--brief]

Runs the canonical conformance lane:
  1. TypeScript canonical package tests
  2. Rust canonical package tests
  3. Cross-implementation canonical snippet parity
  4. Cross-implementation diagnostic snippet parity

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

echo "-- Python implementation tests"
PYTHON_BIN="$(resolve_python)" || {
  echo "Error: no Python interpreter found" >&2
  exit 2
}
(cd "$PY_DIR" && PYTHONPATH=src "$PYTHON_BIN" -m unittest discover -s tests -p 'test_*.py')
echo

echo "-- Rust canonical package tests"
(cd "$RUST_DIR" && cargo test -p aeon-canonical -- --nocapture)
echo

echo "-- Cross-implementation canonical snippet parity"
parity_cmd=("$PYTHON_BIN" "$ROOT_DIR/scripts/stress-canonical-snippets.py" --mode "$selected_mode")
if [[ "$brief" -eq 1 ]]; then
  parity_cmd+=(--brief)
fi
"${parity_cmd[@]}"
echo

echo "-- Cross-implementation diagnostic snippet parity"
diag_cmd=("$PYTHON_BIN" "$ROOT_DIR/scripts/stress-diagnostic-snippets.py")
if [[ "$brief" -eq 1 ]]; then
  diag_cmd+=(--brief)
fi
"${diag_cmd[@]}"
