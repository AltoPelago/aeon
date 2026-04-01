#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

patterns=(
  '/Users/'
  'file:///(Users|home)/'
  '/home/[^/[:space:]]+/'
  '[A-Za-z]:\\\\Users\\\\'
)

git_grep_args=(-nI -E)
for pattern in "${patterns[@]}"; do
  git_grep_args+=(-e "$pattern")
done

if git grep "${git_grep_args[@]}" -- . ':(exclude)scripts/check-no-local-paths.sh'; then
  cat <<'EOF'

Local filesystem path markers were found in tracked files.
Please replace them with repository-relative links, code references, or
portable documentation before committing.
EOF
  exit 1
fi

echo "No local filesystem paths found in tracked files."
