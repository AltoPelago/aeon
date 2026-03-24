#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_ROOT="$ROOT/implementations/typescript"
OUTDIR="$TS_ROOT/internal-release"

PKGS=(
  "@aeon/lexer"
  "@aeon/parser"
  "@aeon/aes"
  "@aeon/annotation-stream"
  "@aeon/core"
  "@aeon/finalize"
  "@aeon/canonical"
  "@aeon/sdk-internal"
)
PKG_DIRS=(
  "lexer"
  "parser"
  "aes"
  "annotation-stream"
  "core"
  "finalize"
  "canonical"
  "sdk-internal"
)

cd "$TS_ROOT"

for pkg in "${PKGS[@]}"; do
  pnpm --filter "$pkg" build

done

rm -rf "$OUTDIR"
mkdir -p "$OUTDIR"

for pkg_dir in "${PKG_DIRS[@]}"; do
  (
    cd "$TS_ROOT/packages/$pkg_dir"
    pnpm pack --pack-destination "$OUTDIR"
  )

done

echo "Packed internal SDK release to: $OUTDIR"
ls -1 "$OUTDIR"
