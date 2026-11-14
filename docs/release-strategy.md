# Release Strategy

This document describes how AEON implementation releases should be cut from this
repository.

It is an implementation operations document, not a language specification
document.

## Core model

This repository should use:

- one long-lived integration branch: `main`
- short-lived release branches only when actively stabilizing a release
- implementation-specific tags and release notes

This repository should not use long-lived implementation-specific release
branches such as `release/typescript`, `release/rust`, or `release/python`.

That would add merge overhead without matching the authority split already
documented in [`VERSIONING.md`](../VERSIONING.md).

## Why releases are split by implementation

AEON has separate tracks for:

- language/spec version
- CTS version
- implementation/package version

The public release units in this repo are therefore implementation-specific:

- TypeScript workspace packages
- Rust workspace / crates / CLI
- Python package / CLI

A TypeScript release does not automatically imply a Rust or Python release, even
when they are all implementing the same `AEON v1` semantics.

## Branching strategy

Recommended branch shapes:

- `main`
- `release/<implementation>/<version>`
- `hotfix/<implementation>/<version>` when needed

Examples:

- `release/typescript/0.17.0-rc.1`
- `release/rust/0.16.0`
- `release/python/0.16.0`
- `hotfix/typescript/0.17.0-rc.1`

## Tagging strategy

Use implementation-specific tags instead of a single repo-wide version tag.

Examples:

- `typescript/v0.17.0-rc.1`
- `rust/v0.16.0`
- `python/v0.16.0`

This keeps the release history honest about what was actually shipped.

## Release flow

### Beta, release candidate, and stable stages

Use `X.Y.Z-beta.N` while intended release work is still landing. A beta is an
installable integration checkpoint; its notes must identify incomplete scope,
known failures and supported implementation surfaces. Required packaging,
security and publication checks still apply.

Use `X.Y.Z-rc.N` only when the declared scope is complete, release notes and
migration guidance are ready, and repository checks pass on the selected
revision. Freeze scope at RC: only stabilization fixes enter the cut, and each
changed candidate gets a new immutable version and renewed affected checks.
If scope must expand, explicitly reopen planning and repeat candidate acceptance.

Publish npm betas and RCs through the existing publisher with `next`; reserve
`latest` for stable versions. Downstream acceptance installs exact versions,
not the moving `next` tag. Rust uses SemVer prereleases; Python distribution
metadata uses its registry's normalized form, such as `X.Y.Zb1` and `X.Y.Zrc1`.
Verify the version tool, tag validator and wheel metadata agree before a native
prerelease; TypeScript prerelease support does not establish native readiness.

Accept an RC only after clean registry consumer and affected downstream checks
pass for the recorded artifact combination. Publish stable with a new stable
version and verified tag, then repeat package/consumer checks: changing only a
dist-tag does not turn an RC version into a stable version. Preserve exact
source revisions, dependency versions, artifact integrity and verification limits.

All stages follow the reviewed-main, signed-tag and implementation-specific
publication gates below. They do not synchronize independent package, language
or CTS version numbers. For the coordinated cut, use the
[shared 0.17.0 checklist](https://github.com/AltoPelago/roadmap/blob/main/aeon/work-in-progress/release-0.17.0-checklist.md).

Normal release flow:

1. Merge release-ready work into `main`.
2. Cut `release/<implementation>/<version>` from `main`.
3. Run the implementation-specific verification set on that branch.
4. Apply only release-stabilization fixes there.
5. Merge the release preparation and stabilization fixes into protected `main`
   and confirm checks pass on the exact merged commit.
6. Create signed implementation-specific tags from that checked `main` commit,
   verify them locally, and push them to trigger publication. Do not tag an
   unmerged release-branch commit.

Use a release branch when:

- you need a stabilization window
- you expect version-bump or packaging-only fixes
- you want a clean audit trail for the exact cut

Avoid a release branch when:

- the release is a trivial patch with no stabilization risk
- the release is purely internal and not meant to create a public artifact

In those simpler cases, tagging directly from `main` is acceptable.

## Coordinated parity releases

Sometimes the same already-defined AEON behavior fix should ship in more than
one implementation at roughly the same time.

In that case:

- coordinate the planning and notes together
- cut separate implementation release branches if needed
- publish separate implementation tags

Do not force a fake unified repo release number when only one implementation is
actually shipping an artifact.

## Implementation checklists

### TypeScript

TypeScript should be treated as a workspace release unit.

Before cutting a TypeScript release:

- run `npm run version:set -- typescript X.Y.Z` from the repository root
- add the matching dated `CHANGELOG.md` section and run
  `npm run version:check` plus `npm run test:version`
- verify any publish-surface changes are intentional and documented
- for 0.16.0, canonical conformance and source API/CLI defaults adopt
  `canonical-cts-v1-snapshot-0.4` (reference-safe ordering). CI pins the merged
  authority revision before switching the claim. Explicit `lexical-v1` remains
  for historical source bytes; integrity event hashing does not change
- for 0.14.0, Core conformance is pinned to
  `core-cts-v1-snapshot-0.5`, which requires decodable Base64URL values while
  preserving the opaque `encoding`, `inline`, and `embed` datatype behavior
- run:

```bash
cd implementations/typescript
pnpm install
pnpm build
pnpm test
pnpm test:cts:all
```

Recommended repo-level checks:

```bash
cd ../..
npm run ci
python3 ./scripts/stress-combinations.py --run both --brief --failures-only
```

Release-specific checks:

- confirm the first-wave publish set still matches [`RELEASING.md`](../RELEASING.md)
- run `npm pack --dry-run --json` on intended public packages
- confirm no unexpected lifecycle scripts or publish-surface drift were added
- create a signed annotated tag, verify it locally with `git tag -v`, and push
  it only after the tagged commit is on `main`

Tag shape:

- `typescript/vX.Y.Z`

### Rust

Rust should be treated as a workspace release unit, even if the CLI is the main
user-facing binary.

Before cutting a Rust release:

- run `npm run version:set -- rust X.Y.Z` from the repository root
- add the matching dated `CHANGELOG.md` section and run
  `npm run version:check` plus `npm run test:version`

```bash
cd implementations/rust
cargo fmt --all --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets
cargo test --workspace --all-targets --all-features
```

Recommended repo-level checks:

```bash
cd ../..
npm run ci:rust
bash ./scripts/canonical-cts.sh --mode all --brief
```

Security and policy checks:

- ensure `cargo audit` is green
- ensure `cargo deny check` is green
- confirm crate metadata matches the intended public release surface
- create a signed annotated tag, verify it locally with `git tag -v`, and push
  it only after the tagged commit is on `main`

Tag shape:

- `rust/vX.Y.Z`

### Python

Python should be treated as its own package release unit.

Before cutting a Python release:

- run `npm run version:set -- python X.Y.Z` from the repository root
- add the matching dated `CHANGELOG.md` section and run
  `npm run version:check` plus `npm run test:version`

```bash
cd implementations/python
python3 -m unittest discover -s tests -p 'test_*.py'
python3 tools/run_cts.py
cd ../rust
python3 tools/run_cts.py
```

Recommended repo-level checks:

```bash
cd ../..
python3 ./scripts/compare-canonical-implementations.py
python3 ./scripts/stress-combinations.py --run both --brief --failures-only
```

Release-specific checks:

- confirm the dependency-free runtime surface is still intact unless an explicit
  policy change was made
- confirm package metadata and console entry points are correct
- create a signed annotated tag, verify it locally with `git tag -v`, and push
  it only after the tagged commit is on `main`

Tag shape:

- `python/vX.Y.Z`

## Release notes guidance

Release notes should always say:

- which implementation was released
- the implementation version
- the AEON spec line targeted, for example `AEON v1`
- whether the change is parity, packaging, API, CLI, or security related

Release notes should not imply that:

- a new package version means a new language version
- a CTS tightening automatically means a language major version bump

## Authority boundaries

- language and normative semantics: sibling specs repo
- conformance truth: sibling CTS repo
- implementation packaging and release operations: this repo

## Held SANSA development candidate

The private TypeScript workspace override uses the source-verified SANSA
`0.15.0-rc.1` archive from merged commit
`0436666176c9225393c43a80b99d800d00b46452`. The filename, staging helper,
checksum whitelist, provenance record and frozen lock identify the same bytes:
SHA-256 `bb3243188ca46198301d778fb92ea6c174842372671084b481330b965c1be759`.
Rust development pins the same immutable Git revision under the existing strict
source policy. Package versions and unrelated locked dependencies are unchanged.

This override is development preparation and does not certify that a registry
contains these bytes. Before official publication, remove the private override
and archive, select coordinated final versions, and qualify the actual registry
artifacts, integrity locks and installed consumers through the existing release
checks. Do not treat the local archive checksum as registry provenance.

Official releases, deployment, final version allocation and stable contract
promotion remain on hold. This development-pin refresh does not relax publish
guards, compatibility or target-preservation checks, performance ceilings, or
the remaining platform and artifact qualification requirements.
