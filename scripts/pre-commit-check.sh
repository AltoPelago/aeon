#!/usr/bin/env bash
# Purpose: run fast pre-commit repository safety checks.
# Run from: anywhere inside this git repo.
# Example: bash ./scripts/pre-commit-check.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

bash "$script_dir/check-no-local-paths.sh"
