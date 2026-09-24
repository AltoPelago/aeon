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
2. Regenerate the committed WASM artifact when one of its build inputs changed.
3. Build and run the relevant CTS and package tests against that artifact.
4. Confirm package tarballs are clean.
5. Update [`CHANGELOG.md`](./CHANGELOG.md) for the package version being released.

Set and validate implementation versions from the repository root. Select one
independent track, or use `all` only for an intentional parity release:

```bash
npm run version:set -- typescript X.Y.Z
# or: npm run version:set -- rust X.Y.Z
# or: npm run version:set -- python X.Y.Z
# or: npm run version:set -- all X.Y.Z
```

The setter performs one recoverable transaction across every machine-owned
version field for the selected track, including its implementation version in
`conformance/cts-claims.json`. It intentionally leaves the dated, human-authored
`CHANGELOG.md` section to the release author. After adding that section, run:

```bash
npm run version:check
npm run test:version
```

If either command reports an interrupted transaction, first confirm no other
version command is active, then run `npm run version:recover`. Never delete an
unknown or malformed transaction directory; preserve it for manual review.

Recommended commands:

```bash
pnpm install --frozen-lockfile --ignore-scripts
```

Regenerate the committed WASM artifact after installation and before CI whenever
the Rust/WASM source, locked Rust dependency graph, pinned Rust toolchain, WASM
wrapper version, or pinned generator changes:

```bash
pnpm --filter @altopelago/aeon-wasm build:wasm
```

Then test and run package preflight against that committed artifact:

```bash
pnpm run ci
pnpm publish:preflight
```

`pnpm run ci` includes `pnpm test:cts:film`. The TypeScript Film v1 release
surface currently claims reader conformance only: it must decode every
reader-decodable vector in `film-cts-v1-snapshot-0.1`, while encoder-only
vectors remain outside the claim. Adding Film encoding or durable writing to a
publishable package requires a separate release-policy update and review.

Once the artifact has been generated and reviewed for the current wrapper
version, do not rebuild it merely to repeat verification with unchanged build
inputs. The build requires the Rust version in
`implementations/rust/rust-toolchain.toml` and exactly `wasm-pack 0.14.0`.
After generation, the build script synchronizes `pkg/package.json` to the WASM
wrapper version. The version tool also updates that generated manifest as part
of its TypeScript transaction, but this does not replace required regeneration
when a listed WASM build input changed. A TypeScript-only wrapper release does
not require a coordinated Rust crate version bump.

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
   `AltoPelago/aeon`, workflow `npm-publish.yml`, and environment `npm`.
   Protect that GitHub environment with required reviewer approval.
2. Run the `npm Publish` workflow from GitHub Actions with `dry_run` enabled.
3. If the dry run is clean, create and verify a signed annotated
   `typescript/vX.Y.Z` tag on the release commit already present on `main`, then
   push that tag. The tag-triggered workflow performs the real publication.

The workflow runs `npm run version:check` and verifies that the pushed tag is
exactly `typescript/vX.Y.Z` for the checked TypeScript package line before it
installs or publishes workspace packages.

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

## Rust crates.io Release Flow

The Rust release workflow is `.github/workflows/rust-publish.yml`. A manual run
performs version validation and locked package dry runs without publishing.
Pushing a signed annotated `rust/vX.Y.Z` tag publishes the four AEON crates in
dependency order, but only when the tag version matches the Rust package line
and its commit is already on `main`.

Configure trusted publishing separately on each existing crates.io project:

- repository owner: `AltoPelago`
- repository: `aeon`
- workflow: `rust-publish.yml`
- environment: `crates-io`
- crates: `altopelago-aeon-core`, `altopelago-aeon-aeos`,
  `altopelago-aeon-finalize`, and `altopelago-aeon`

Create the matching protected GitHub environment and require reviewer approval
for deployment. After all four trusted-publisher records work, require trusted
publishing for new versions and revoke any bootstrap crates.io token.

The workflow gives OIDC permission only to its publish job. It obtains a
short-lived crates.io token through the official crates.io authentication
action; no registry token belongs in GitHub secrets. After publication, a new
job with no repository checkout creates a fresh Cargo project, resolves the
exact tagged facade version from crates.io, and exercises AEON-to-Telex output.

## Native Python PyPI Release Flow

The native Rust-backed distribution is `altopelago-aeon`; the pure-Python
reference implementation is not a fallback inside that package. The version
tool keeps both Python project manifests aligned, and the release workflow is
`.github/workflows/python-publish.yml`.

A manual run builds and tests the complete 15-wheel CPython 3.12–3.14 matrix
plus the sdist without publishing. Pushing a signed annotated `python/vX.Y.Z`
tag builds the same artifacts and publishes them only when the tag version
matches the Python package line and its commit is already on `main`.

Configure a PyPI pending trusted publisher for the first release, or a normal
trusted publisher after the project exists:

- PyPI project: `altopelago-aeon`
- GitHub owner: `AltoPelago`
- repository: `aeon`
- workflow: `python-publish.yml`
- environment: `pypi`

Create the matching protected GitHub environment and require reviewer approval
for deployment. The unprivileged build jobs upload the tested distributions;
the final Linux job only downloads those artifacts and invokes the official
PyPI publishing action with OIDC. PyPI attestations remain enabled by default,
and no PyPI token belongs in GitHub secrets. A subsequent clean job installs
the exact tagged CPython 3.12 wheel from PyPI with source builds disabled and
exercises both the typed compile API and Telex export.

The npm release workflow likewise finishes with a separate clean job that has
no repository checkout. It installs the exact published `@altopelago/aeon-sdk`
version together with every other public package at that version, thereby
checking the complete npm release set and its public dependency graph, and
exercises the checked read/finalize API. All three registry smoke jobs retry
dependency resolution for up to two minutes to tolerate normal index
propagation, but run the behavioral check only once so implementation failures
are not masked.

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
