#!/usr/bin/env bash
# Purpose: ensure TypeScript dependency graph changes are accompanied by a pnpm lockfile update.
# Run from: anywhere inside this git repo.
# Example: bash ./scripts/check-typescript-lockfile.sh <base-sha> <head-sha>
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$script_dir/check-typescript-lockfile.mjs" "$@"
