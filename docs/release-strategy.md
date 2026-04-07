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

- `release/typescript/0.10.0`
- `release/rust/0.10.0`
- `release/python/0.10.0`
- `hotfix/typescript/0.10.1`

## Tagging strategy

Use implementation-specific tags instead of a single repo-wide version tag.

Examples:

- `typescript/v0.10.0`
- `rust/v0.10.0`
- `python/v0.10.0`

This keeps the release history honest about what was actually shipped.

## Release flow

Normal release flow:

1. Merge release-ready work into `main`.
2. Cut `release/<implementation>/<version>` from `main`.
3. Run the implementation-specific verification set on that branch.
4. Apply only release-stabilization fixes there.
5. Tag the release with an implementation-specific tag.
6. Merge release-only fixes back into `main`.

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

- update intended package versions in the TypeScript workspace
- verify any publish-surface changes are intentional and documented
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

Tag shape:

- `typescript/vX.Y.Z`

### Rust

Rust should be treated as a workspace release unit, even if the CLI is the main
user-facing binary.

Before cutting a Rust release:

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

Tag shape:

- `rust/vX.Y.Z`

### Python

Python should be treated as its own package release unit.

Before cutting a Python release:

```bash
cd implementations/python
python3 -m unittest discover -s tests -p 'test_*.py'
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
