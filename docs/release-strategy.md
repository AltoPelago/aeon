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

- `release/typescript/0.17.0-rc.2`
- `release/rust/0.17.0-rc.2`
- `release/python/0.17.0-rc.2`
- `hotfix/typescript/0.17.0-rc.2`

## Tagging strategy

Use implementation-specific tags instead of a single repo-wide version tag.

Examples:

- `typescript/v0.17.0-rc.2`
- `rust/v0.17.0-rc.2`
- `python/v0.17.0-rc.2`

This keeps the release history honest about what was actually shipped.

## Release flow

### Property Resolve SDK development candidate

The combined-main preparation also rebuilds committed WASM from the merged Rust
block-comment newline fix. Compile/process, canonical and byte-stream parity must
pass against that generated artifact as well as source. Oversized structured
comments retain at most one newline layout witness after certain overflow,
release excess metadata capacity, and preserve closing/lexical error precedence.
The source allocation controls and rebuilt-binary streaming checks must pass;
this is not a total-worker-memory or new performance-qualification claim. This
does not authorize publication or change the existing compatibility/target/performance gates.

The Rust and TypeScript SDK provider slice selects the coordinated SANSA development source
`8175c7b7ea8c765ebc3c6e5da35a949df9ae0783`. The central TypeScript workspace override
selects the retained local archive
`altopelago-sansa-0.15.0-rc.1-radix16-qa-936d2929.tgz`, SHA-256
`936d29298e1fb56157e3f0cfaa70b8b7133c3c19790777ff3985017a90d7ae32`;
the staging helper, provenance record and lockfile must agree. Rust pins the same
source revision. Previous archives remain available for provenance.

This coordinated development selection enables authoritative standalone SDK
key/tag/headTag Resolve and direct read-only Query. It is not a registry artifact selection or permission to
publish existing package versions. Before any release, select the final registry
dependency and integrity, refresh affected consumer locks and verify the actual
artifact combination. Do not publish an old version with these new bytes.

The merged implementation includes pure Python standalone document Resolve and Core property
Addressing with rebuilt native/WASM inert-value representation. It does not add a
native/WASM standalone Resolve API. Core's reduced namespace rejects evaluation;
Python's detailed CLI AST JSON export remains closed for property literals.
Core qualifier ownership and public Rust source changes are documented in its
README. These development ports do not establish stable profile support.

Owning review/main verification of these ports, remaining tooling JSON export,
authoritative provider/playground integration, Query review/main verification
and affected resource/platform qualification remain open. Keep the original
compatibility and target-preservation checks and 1.15x latency/1.20x memory
ceilings. Capability/profile promotion, official releases and deployment remain
on hold; the local override grants none of them.

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
`0.15.0-rc.1` archive from reviewed development commit
`05b8739f06be0e76d03e0d3b17ec6c403568d41e`. The filename, staging helper,
checksum whitelist, provenance record and frozen lock identify the same bytes:
SHA-256 `c0471ad59f6f0594e0ca6183ad6a292d02c208bd9cc30709bb5b27ac9e7d222b`.
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

The combined empty-key/Unicode development graph selects SANSA `05b8739f06be0e76d03e0d3b17ec6c403568d41e`
from `altopelago-sansa-0.15.0-rc.1-unicode-empty-keys-c0471ad5.tgz` (SHA-256 `c0471ad59f6f0594e0ca6183ad6a292d02c208bd9cc30709bb5b27ac9e7d222b`).
The TypeScript override and frozen lock select these same bytes; Rust selects the
same source revision. This deliberately updates the private development controls,
not the publishable package roster or public package versions. Empty ordinary
property keys supersede only the explicitly audited historical rejection cases.
Official releases, registry publication, deployment and stable CTS promotion stay
held until owning reviews merge and the separate release gates are completed.

## Optional browser highlighting package in TypeScript 0.17.0

The reviewed 0.17.0 TypeScript package set may add
`@altopelago/aeon-highlight` alongside the existing published libraries. This is
an explicit publish-surface preparation change, independently reviewed in the
browser-package branch; it does not authorize publication. The package uses the
same TypeScript release version and an exact packed dependency on the matching
AEON lexer. Core/runtime packages do not depend on it.

Its public surfaces are the DOM-free renderer, an optional explicitly registered
browser element, and two scoped CSS themes. JavaScript remains side-effect free;
only this package's exact exported `dist/theme.css` and `dist/theme-light.css`
assets are marked as side effects so bundlers retain requested styles. Existing
packages keep their `sideEffects=false` requirement. The package discovery,
version checks, clean registry-consumer roster and installed API smoke include
the new package through the existing release workflow.

Package review, fresh frozen installation, full package preflight, CI and
consumer migrations must finish before selecting a release combination. The
[consumer checklist](browser-highlighting-0.17.0.md) records the local packaging
proof and remaining gates. Official releases and deployment remain on hold.

The optional `./renderer` entry exports a provider-bound renderer for hosts that
select their own implementation lexer. It loads no lexer or DOM itself. Existing
root/element entries retain the exact matching 0.17 lexer dependency. Website
legacy 0.16 and candidate 0.17 providers require explicit consumer compatibility
checks; this does not upgrade or relax their runtime graphs.

The unpublished 0.2 property revision separates container-only `&tag` from
head-only `&headTag`. The container/head split is merged; direct property Query is a coordinated candidate
under owning review. Shared
callbacks, parser/inspection ceilings and prohibited consumer admission are
unchanged. Old head-target predicates must migrate explicitly to `&headTag`;
no published selector contract or immutable reference/target fixture is revised.
