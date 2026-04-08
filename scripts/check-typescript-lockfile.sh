#!/usr/bin/env bash
# Purpose: ensure TypeScript manifest changes are accompanied by a pnpm lockfile update.
# Run from: anywhere inside this git repo.
# Example: bash ./scripts/check-typescript-lockfile.sh <base-sha> <head-sha>
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: bash ./scripts/check-typescript-lockfile.sh <base-sha> <head-sha>" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
cd "$repo_root"

manifest_paths=(
  "implementations/typescript/package.json"
  "implementations/typescript/pnpm-workspace.yaml"
  "implementations/typescript/packages/**/package.json"
  "implementations/typescript/tools/**/package.json"
)

lockfile_path="implementations/typescript/pnpm-lock.yaml"

manifest_changed=0
for pathspec in "${manifest_paths[@]}"; do
  if git diff --name-only "$base_sha" "$head_sha" -- "$pathspec" | grep -q .; then
    manifest_changed=1
    break
  fi
done

if [[ "$manifest_changed" -eq 0 ]]; then
  echo "No TypeScript manifest changes detected."
  exit 0
fi

if git diff --name-only "$base_sha" "$head_sha" -- "$lockfile_path" | grep -q .; then
  echo "TypeScript lockfile updated alongside manifest changes."
  exit 0
fi

cat >&2 <<'EOF'
TypeScript dependency manifests changed without a matching pnpm lockfile update.
Please run `pnpm install` or `pnpm update` in `implementations/typescript` and commit the resulting
`implementations/typescript/pnpm-lock.yaml` changes.
EOF
exit 1
