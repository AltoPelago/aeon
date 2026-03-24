#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_DIR="$ROOT_DIR/implementations/typescript"
DEFAULT_NOTES_DIR="$ROOT_DIR/setup/releases"

MODE="doctor"
VERSION=""
NOTES_FILE=""
EXECUTE=0
SKIP_TESTS=0
ALLOW_DIRTY=0
OUTPUT_DIR=""

readonly INTERNAL_PACKAGES=(
  "packages/lexer"
  "packages/parser"
  "packages/aes"
  "packages/core"
  "packages/finalize"
  "packages/canonical"
  "packages/annotation-stream"
  "packages/sdk-internal"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/release-cut.sh doctor --version X.Y.Z [--notes FILE] [--execute] [--skip-tests] [--allow-dirty]
  scripts/release-cut.sh bundle --version X.Y.Z [--output-dir DIR] [--execute] [--skip-tests] [--allow-dirty]
  scripts/release-cut.sh bundle-verify [--output-dir DIR]
  scripts/release-cut.sh cut    --version X.Y.Z [--notes FILE] [--output-dir DIR] [--execute] [--skip-tests] [--allow-dirty]

Modes:
  doctor   Run release readiness checks only (default mode).
  bundle   Build internal tarball bundle + manifest (no version bump/tag).
  bundle-verify  Verify existing internal bundle against manifest + checksums.
  cut      Run checks and (with --execute) bump versions, commit, and tag.

Flags:
  --version X.Y.Z   Required semver (no leading "v")
  --notes FILE      Release notes file path (default: setup/releases/vX.Y.Z.md)
  --output-dir DIR  Internal bundle output dir (default: implementations/typescript/internal-release)
  --execute         Apply changes (default is dry-run)
  --skip-tests      Skip build/test/CTS checks (not recommended)
  --allow-dirty     Allow uncommitted changes (recommended only for local dry-runs/bundle prep)
EOF
}

log() {
  printf '%s\n' "[release] $*"
}

die() {
  printf '%s\n' "[release] ERROR: $*" >&2
  exit 1
}

run() {
  if [[ "$EXECUTE" -eq 1 ]]; then
    "$@"
  else
    printf '%s\n' "[dry-run] $*"
  fi
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

validate_semver() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must be semver X.Y.Z (got '$1')"
}

parse_args() {
  if [[ $# -gt 0 ]]; then
    case "$1" in
      doctor|bundle|bundle-verify|cut)
        MODE="$1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
    esac
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --version)
        VERSION="${2:-}"
        shift 2
        ;;
      --notes)
        NOTES_FILE="${2:-}"
        shift 2
        ;;
      --output-dir)
        OUTPUT_DIR="${2:-}"
        shift 2
        ;;
      --execute)
        EXECUTE=1
        shift
        ;;
      --skip-tests)
        SKIP_TESTS=1
        shift
        ;;
      --allow-dirty)
        ALLOW_DIRTY=1
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
  done

  if [[ "$MODE" != "bundle-verify" ]]; then
    [[ -n "$VERSION" ]] || die "--version is required"
    validate_semver "$VERSION"
  fi
  if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR="$TS_DIR/internal-release"
  fi
  if [[ -z "$NOTES_FILE" ]]; then
    NOTES_FILE="$DEFAULT_NOTES_DIR/v$VERSION.md"
  fi
}

check_git_state() {
  local branch
  branch="$(git -C "$ROOT_DIR" rev-parse --abbrev-ref HEAD)"
  log "Current branch: $branch"
  if [[ "$MODE" == "cut" ]]; then
    [[ "$branch" =~ ^main$|^release/[0-9]+\.[0-9]+$ ]] || die "Branch must be 'main' or 'release/<major>.<minor>' for cut mode"
  fi

  if [[ -n "$(git -C "$ROOT_DIR" status --porcelain)" ]]; then
    if [[ "$ALLOW_DIRTY" -eq 1 ]]; then
      log "Working tree is dirty; proceeding due to --allow-dirty"
    else
      die "Working tree is not clean. Commit/stash changes before release or pass --allow-dirty."
    fi
  fi

  local tag="v$VERSION"
  if [[ "$MODE" == "cut" ]] && git -C "$ROOT_DIR" rev-parse "$tag" >/dev/null 2>&1; then
    die "Tag already exists: $tag"
  fi
}

check_release_notes() {
  if [[ ! -f "$NOTES_FILE" ]]; then
    die "Missing release notes file: $NOTES_FILE"
  fi
}

run_quality_gates() {
  if [[ "$SKIP_TESTS" -eq 1 ]]; then
    log "Skipping build/test/CTS checks (--skip-tests)"
    return
  fi

  log "Running TypeScript workspace quality gates"
  (cd "$TS_DIR" && pnpm build)
  (cd "$TS_DIR" && pnpm test)
  (cd "$TS_DIR" && pnpm test:stress)
  (cd "$TS_DIR" && pnpm test:cts:all)

  log "Running canonical CTS lane"
  (cd "$ROOT_DIR" && bash ./scripts/canonical-cts.sh --mode all --brief)
}

collect_version_files() {
  rg --files "$TS_DIR/packages" "$TS_DIR/tools" -g "package.json"
}

bump_workspace_versions() {
  local files
  mapfile -t files < <(collect_version_files)
  [[ "${#files[@]}" -gt 0 ]] || die "No package.json files found under implementations/typescript/{packages,tools}"

  if [[ "$EXECUTE" -eq 0 ]]; then
    log "Would bump version fields in ${#files[@]} files to $VERSION"
    return
  fi

  node - "$VERSION" "${files[@]}" <<'NODE'
const fs = require('fs');
const [, , version, ...files] = process.argv;
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  if (typeof json.version === 'string') {
    json.version = version;
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  }
}
NODE
}

commit_and_tag() {
  local tag="v$VERSION"
  local message="chore(release): $tag"
  run git -C "$ROOT_DIR" add implementations/typescript/packages implementations/typescript/tools
  run git -C "$ROOT_DIR" commit -m "$message"
  run git -C "$ROOT_DIR" tag -a "$tag" -m "AEON release $tag"
}

bundle_internal_release() {
  local out_dir="$OUTPUT_DIR"
  log "Bundling internal release artifacts -> $out_dir"

  if [[ "$EXECUTE" -eq 0 ]]; then
    printf '%s\n' "[dry-run] mkdir -p $out_dir"
    for rel in "${INTERNAL_PACKAGES[@]}"; do
      printf '%s\n' "[dry-run] pnpm --dir $TS_DIR/$rel pack --pack-destination $out_dir"
    done
    printf '%s\n' "[dry-run] node scripts to generate $out_dir/manifest.json and $out_dir/SHA256SUMS"
    return
  fi

  mkdir -p "$out_dir"

  for rel in "${INTERNAL_PACKAGES[@]}"; do
    local pkg_dir="$TS_DIR/$rel"
    [[ -d "$pkg_dir" ]] || die "Missing package directory: $pkg_dir"
    log "Packing $rel"
    (cd "$TS_DIR" && pnpm --dir "$pkg_dir" pack --pack-destination "$out_dir" >/dev/null)
  done

  node - "$out_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outDir = process.argv[2];
const files = fs.readdirSync(outDir)
  .filter((name) => name.endsWith('.tgz'))
  .sort();

if (files.length === 0) {
  console.error('[release] ERROR: No .tgz files produced in', outDir);
  process.exit(1);
}

const entries = files.map((name) => {
  const full = path.join(outDir, name);
  const buf = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  return {
    file: name,
    bytes: buf.length,
    sha256,
  };
});

const manifest = {
  generated_at: new Date().toISOString(),
  artifacts: entries,
};

const sums = entries.map((e) => `${e.sha256}  ${e.file}`).join('\n') + '\n';
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums, 'utf8');
NODE

  log "Internal release bundle complete."
}

verify_internal_release_bundle() {
  local out_dir="$OUTPUT_DIR"
  log "Verifying internal release artifacts in $out_dir"
  [[ -d "$out_dir" ]] || die "Missing output directory: $out_dir"
  [[ -f "$out_dir/manifest.json" ]] || die "Missing manifest: $out_dir/manifest.json"
  [[ -f "$out_dir/SHA256SUMS" ]] || die "Missing checksum file: $out_dir/SHA256SUMS"

  node - "$out_dir" <<'NODE'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const outDir = process.argv[2];
const manifestPath = path.join(outDir, 'manifest.json');
const sumsPath = path.join(outDir, 'SHA256SUMS');

function fail(msg) {
  console.error(`[release] ERROR: ${msg}`);
  process.exit(1);
}

const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (err) {
  fail(`manifest.json is not valid JSON (${err.message})`);
}

if (!manifest || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
  fail('manifest.json must contain a non-empty artifacts array');
}

const sumsRaw = fs.readFileSync(sumsPath, 'utf8');
const sums = new Map();
for (const line of sumsRaw.split(/\r?\n/)) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  const match = trimmed.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
  if (!match) fail(`Invalid SHA256SUMS line: "${line}"`);
  const [, sha, file] = match;
  sums.set(file, sha.toLowerCase());
}

const seen = new Set();
for (const entry of manifest.artifacts) {
  if (!entry || typeof entry !== 'object') fail('manifest artifact entry must be an object');
  const { file, bytes, sha256 } = entry;
  if (typeof file !== 'string' || !file.endsWith('.tgz')) fail('manifest artifact.file must be a .tgz string');
  if (!Number.isInteger(bytes) || bytes < 0) fail(`manifest artifact.bytes invalid for ${file}`);
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256)) fail(`manifest artifact.sha256 invalid for ${file}`);
  if (seen.has(file)) fail(`manifest has duplicate artifact entry: ${file}`);
  seen.add(file);

  const full = path.join(outDir, file);
  if (!fs.existsSync(full)) fail(`artifact missing on disk: ${file}`);
  const buf = fs.readFileSync(full);
  if (buf.length !== bytes) fail(`artifact byte size mismatch for ${file}: manifest=${bytes}, actual=${buf.length}`);
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== sha256.toLowerCase()) fail(`artifact sha256 mismatch for ${file}: manifest=${sha256}, actual=${actual}`);

  const sumsSha = sums.get(file);
  if (!sumsSha) fail(`SHA256SUMS missing entry for ${file}`);
  if (sumsSha !== actual) fail(`SHA256SUMS mismatch for ${file}: sums=${sumsSha}, actual=${actual}`);
}

for (const file of sums.keys()) {
  if (!seen.has(file)) fail(`SHA256SUMS contains file not listed in manifest: ${file}`);
}

console.log('[release] Internal bundle verification passed.');
NODE
}

main() {
  parse_args "$@"
  require_cmd git
  require_cmd pnpm
  require_cmd rg
  require_cmd node

  log "Mode: $MODE"
  if [[ -n "$VERSION" ]]; then
    log "Version: $VERSION"
  fi
  if [[ "$MODE" != "bundle-verify" ]]; then
    log "Notes: $NOTES_FILE"
  fi
  log "Output dir: $OUTPUT_DIR"
  [[ "$EXECUTE" -eq 1 ]] && log "Execution: APPLY" || log "Execution: DRY-RUN"

  if [[ "$MODE" == "bundle-verify" ]]; then
    verify_internal_release_bundle
    exit 0
  fi

  check_git_state

  if [[ "$MODE" != "bundle" ]]; then
    check_release_notes
  fi
  run_quality_gates

  if [[ "$MODE" == "doctor" ]]; then
    log "Release doctor checks passed."
    exit 0
  fi

  if [[ "$MODE" == "bundle" ]]; then
    bundle_internal_release
    log "Release bundle complete for v$VERSION."
    exit 0
  fi

  bundle_internal_release

  bump_workspace_versions
  if [[ "$EXECUTE" -eq 1 ]]; then
    run_quality_gates
  fi
  commit_and_tag
  log "Release cut complete for v$VERSION."
}

main "$@"
