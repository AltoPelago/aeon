#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TS_DIR="$ROOT_DIR/implementations/typescript"
TS_CMD=(node "$TS_DIR/packages/cli/dist/main.js" inspect)

resolve_python_bin() {
  if [[ -n "${AEON_PYTHON_BIN:-}" ]] && [[ -x "${AEON_PYTHON_BIN}" ]]; then
    echo "${AEON_PYTHON_BIN}"
    return 0
  fi

  local candidate
  for candidate in python3.14 python3.13 python3.12 python3; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  return 1
}

PYTHON_BIN="$(resolve_python_bin || true)"
PY_CMD=()
if [[ -n "$PYTHON_BIN" ]]; then
  PY_CMD=("$PYTHON_BIN" "$ROOT_DIR/implementations/python/bin/aeon-python" inspect)
fi
RUST_CMD=("$ROOT_DIR/implementations/rust/target/debug/aeon-rust" inspect)

usage() {
  cat <<'EOF'
Usage: bash ./scripts/stress-smoke.sh [--impl <typescript|python|rust|all>]

Runs a portable stress-smoke fixture set against one or more implementation CLIs.

Examples:
  bash ./scripts/stress-smoke.sh
  bash ./scripts/stress-smoke.sh --impl rust
  bash ./scripts/stress-smoke.sh --impl all
EOF
}

selected_impl="all"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --impl)
      if [[ $# -lt 2 ]]; then
        echo "Error: Missing value for --impl" >&2
        usage >&2
        exit 2
      fi
      selected_impl="$2"
      shift 2
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

case "$selected_impl" in
  typescript|python|rust|all) ;;
  *)
    echo "Error: Invalid value for --impl: $selected_impl" >&2
    usage >&2
    exit 2
    ;;
esac

implementations=()
if [[ "$selected_impl" == "all" ]]; then
  implementations=(typescript python rust)
else
  implementations=("$selected_impl")
fi

is_available() {
  local impl="$1"
  case "$impl" in
    typescript)
      [[ -f "$TS_DIR/packages/cli/dist/main.js" ]]
      ;;
    python)
      [[ -x "$ROOT_DIR/implementations/python/bin/aeon-python" ]] && [[ ${#PY_CMD[@]} -gt 0 ]]
      ;;
    rust)
      [[ -x "$ROOT_DIR/implementations/rust/target/debug/aeon-rust" ]]
      ;;
    *)
      return 1
      ;;
  esac
}

run_inspect() {
  local impl="$1"
  shift
  case "$impl" in
    typescript)
      (cd "$ROOT_DIR" && "${TS_CMD[@]}" "$@")
      ;;
    python)
      (cd "$ROOT_DIR" && "${PY_CMD[@]}" "$@")
      ;;
    rust)
      (cd "$ROOT_DIR" && "${RUST_CMD[@]}" "$@")
      ;;
    *)
      echo "unknown implementation: $impl" >&2
      return 2
      ;;
  esac
}

total=0
failed=0
skipped=0

run_case() {
  local impl="$1"
  local name="$2"
  local fixture="$3"
  local expected_exit="$4"
  local must_match="$5"
  shift 5

  total=$((total + 1))
  local tmp
  tmp="$(mktemp)"

  set +e
  run_inspect "$impl" "$fixture" "$@" >"$tmp" 2>&1
  local code=$?
  set -e

  local ok=1
  if [[ "$code" -ne "$expected_exit" ]]; then
    ok=0
  fi
  if [[ -n "$must_match" ]] && ! grep -Eq "$must_match" "$tmp"; then
    ok=0
  fi

  if [[ "$ok" -eq 1 ]]; then
    echo "PASS  [$impl] $name (exit=$code)"
  else
    failed=$((failed + 1))
    echo "FAIL  [$impl] $name (exit=$code expected=$expected_exit)"
    if [[ -n "$must_match" ]]; then
      echo "  expected output to match regex: $must_match"
    fi
    echo "  output:"
    sed -n '1,160p' "$tmp"
  fi

  rm -f "$tmp"
}

for impl in "${implementations[@]}"; do
  if ! is_available "$impl"; then
    skipped=$((skipped + 1))
    echo "SKIP  [$impl] implementation binary/build is not available"
    continue
  fi

  run_case "$impl" \
    "full/full-feature-stress.aeon" \
    "stress-tests/full/full-feature-stress.aeon" \
    0 \
    '"errors"[[:space:]]*:[[:space:]]*\[\]' \
    --json

  run_case "$impl" \
    "full/comment-stress-pass.aeon" \
    "stress-tests/full/comment-stress-pass.aeon" \
    0 \
    '"annotations"[[:space:]]*:' \
    --json --annotations

  run_case "$impl" \
    "edge/comment-stress-unterminated.aeon" \
    "stress-tests/edge/comment-stress-unterminated.aeon" \
    1 \
    'UNTERMINATED_BLOCK_COMMENT' \
    --json --annotations

  run_case "$impl" \
    "canonical/node-introducer-multiline.aeon" \
    "stress-tests/canonical/node-introducer-multiline.aeon" \
    0 \
    '"errors"[[:space:]]*:[[:space:]]*\[\]' \
    --json

  run_case "$impl" \
    "canonical/node-trailing-separator.aeon" \
    "stress-tests/canonical/node-trailing-separator.aeon" \
    0 \
    '"errors"[[:space:]]*:[[:space:]]*\[\]' \
    --json

  run_case "$impl" \
    "canonical/node-legacy-reject.aeon" \
    "stress-tests/canonical/node-legacy-reject.aeon" \
    1 \
    'SYNTAX_ERROR' \
    --json
done

echo
echo "Stress smoke summary: total=$total failed=$failed skipped=$skipped passed=$((total - failed - skipped))"

if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
