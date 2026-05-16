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
pnpm ci
pnpm publish:preflight
```

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
- exclude compiled `*.test.*` artifacts

## Publish Flow

Preferred release path:

1. Configure npm trusted publishing for each public package, pointing at
   `AltoPelago/aeon` and `.github/workflows/npm-publish.yml`.
2. Run the `npm Publish` workflow from GitHub Actions with `dry_run` enabled.
3. If the dry run is clean, rerun the workflow with `dry_run` disabled.

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
- If the workspace-root TypeScript toolchain baseline changes, such as
  `typescript`, `@types/node`, `packageManager`, or `.npmrc`, treat that as an
  explicit publish-surface review point and record the change in this document,
  `VERSIONING.md`, `README.md`, or `docs/release-strategy.md`.
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
