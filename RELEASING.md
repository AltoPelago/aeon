# Releasing

The TypeScript implementation publishes public packages to npm under the
`@altopelago` scope.

For cross-repo branching and per-implementation release strategy, see
[`docs/release-strategy.md`](./docs/release-strategy.md).

## Scope

The public npm implementation surface is:

- `@altopelago/aeon-aes`
- `@altopelago/aeon-annotation-stream`
- `@altopelago/aeon-canonical`
- `@altopelago/aeon-cli`
- `@altopelago/aeon-core`
- `@altopelago/aeon-finalize`
- `@altopelago/aeon-integrity`
- `@altopelago/aeon-lexer`
- `@altopelago/aeon-parser`
- `@altopelago/aeon-profiles`
- `@altopelago/aeon-runtime`
- `@altopelago/aeon-sdk`
- `@altopelago/aeon-tonic`
- `@altopelago/aeon-transport`
- `@altopelago/aeon-typegen`
- `@altopelago/aeon-wasm`
- `@altopelago/aeos-core`

Tooling, CTS helpers, fuzzing, and internal support packages should not be published.

## Why Publish From The Workspace Root

Several packages depend on one another using `workspace:*`.
The release flow should therefore run from the TypeScript workspace root so pnpm can:

- pack packages with internal `workspace:*` dependencies rewritten to the released version
- use the already-defined workspace build scripts

Avoid ad hoc folder-by-folder `npm publish`.

## Preconditions

From `implementations/typescript/`:

1. Install dependencies.
2. Build the workspace.
3. Run the relevant CTS and package tests.
4. Confirm package tarballs are clean.
5. Update [`CHANGELOG.md`](./CHANGELOG.md) for the package version being released.

Recommended commands:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run ci
pnpm publish:preflight
```

Regenerate the committed WASM artifact before preflight only when the Rust/WASM
source, locked Rust dependency graph, pinned Rust toolchain, WASM wrapper
version, or pinned generator changes:

```bash
pnpm --filter @altopelago/aeon-wasm build:wasm
```

Do not rebuild an already reviewed artifact merely to verify an otherwise
unchanged patch release. The build requires the Rust version in
`implementations/rust/rust-toolchain.toml` and exactly `wasm-pack 0.14.0`.
After generation, the build script synchronizes `pkg/package.json` to the WASM
wrapper version, so a TypeScript-only wrapper release does not require a
coordinated Rust crate version bump.

Optional dry-run npm publish verification:

```bash
pnpm publish:npm:dry-run
```

Dry-run verification intentionally omits npm provenance because npm validates
published versions differently when provenance is requested. The real publish
workflow keeps provenance enabled. When a package version already exists on
npm, dry-run verification still packs the tarball but skips `npm publish
--dry-run` for that exact package version because npm rejects republishing an
existing version even in dry-run mode.

The expected tarballs should:

- include built `dist/`
- include `README.md`
- include regenerated `pkg/` artifacts for `@altopelago/aeon-wasm` when that
  package is part of the release, with `pkg/package.json` matching the wrapper
  package version
- exclude compiled `*.test.*` artifacts

## Publish Flow

Preferred release path:

1. Configure npm trusted publishing for each public package, pointing at
   `AltoPelago/aeon` and `.github/workflows/npm-publish.yml`.
2. Run the `npm Publish` workflow from GitHub Actions with `dry_run` enabled.
3. If the dry run is clean, create and verify a signed annotated
   `typescript/vX.Y.Z` tag on the release commit already present on `main`, then
   push that tag. The tag-triggered workflow performs the real publication.

Do not also rerun the workflow with `dry_run` disabled after pushing the tag;
that would attempt to publish the same immutable npm versions twice. A manual
non-dry-run dispatch is an explicit fallback when no release tag will be used,
not part of the preferred tagged flow.

The workflow uses GitHub OIDC (`id-token: write`) and npm provenance rather than
long-lived npm tokens. It packs with `pnpm pack`, then publishes the resulting
tarballs with `npm publish --provenance --access public` in local dependency
order.

npm trusted publishing requires Node `22.14.0` or newer and npm `11.5.1` or
newer. The publish workflow pins Node `22.14.0` and installs npm `11.14.1`
with lifecycle scripts disabled before publishing.

Manual local publishing is a fallback only. If it is needed, run from
`implementations/typescript/` after the full preflight:

```bash
pnpm publish:preflight
pnpm publish:npm --no-provenance
```

Prefer the CI path for public releases so npm can attach package provenance.

## Notes

- If version bumps are needed, do them before the build and dry-run pass.
- If `@altopelago/aeon-wasm` has a changed Rust/WASM source, locked Rust
  dependency, pinned Rust toolchain, wrapper version, or generator, regenerate
  `implementations/typescript/packages/wasm/pkg/` with
  `pnpm --filter @altopelago/aeon-wasm build:wasm` after version bumps and
  commit the generated artifacts. The build script rejects any `wasm-pack`
  version other than `0.14.0`; changing that pin requires an explicit review
  and regenerated artifact diff.
- If the workspace-root TypeScript toolchain baseline changes, such as
  `typescript`, `@types/node`, `packageManager`, or `.npmrc`, treat that as an
  explicit publish-surface review point and record the change in this document,
  `VERSIONING.md`, `README.md`, or `docs/release-strategy.md`.
- As of 2026-05-31, the TypeScript workspace `.npmrc` enforces `ignore-scripts=true`
  (and CI installs pass `--ignore-scripts`) to reduce npm/pnpm supply-chain risk.
  If a release requires lifecycle scripts for a specific dependency/tooling step,
  treat it as an explicit, reviewed exception and document the rationale in this
  section (including the exact commands/env overrides used, e.g.
  `NPM_CONFIG_IGNORE_SCRIPTS=false pnpm install`).
- The current `typescript 6.0.3` uplift is one such intentional workspace
  toolchain baseline change and should be reviewed as publish-surface policy,
  even though it is a developer-tooling update.
- The current `@types/node 25.8.0` uplift is also an intentional workspace
  toolchain baseline change and should be reviewed with the same
  publish-surface policy even though it is a developer-tooling update.
- If public package names or the package set changes, update this document first.
- Specs and CTS remain authoritative in sibling repos:
  - [aeonite-specs](https://github.com/aeonite-org/aeonite-specs)
  - [aeonite-cts](https://github.com/aeonite-org/aeonite-cts)
