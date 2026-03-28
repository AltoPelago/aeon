# Versioning

This repository has three separate version tracks:

1. Language/spec version
2. Conformance suite version
3. Implementation/package version

They should not be treated as the same thing.

## 1. Language And Spec Version

The AEON language version is the long-lived compatibility contract.

Examples:

- `AEON v1`
- future `AEON v2`

This version changes only when the language or normative semantics change in a way
that deserves a new spec line.

For the current public work, the language/spec line is `v1`.

## 2. CTS Version

CTS versions track conformance data for a given spec line.

Examples:

- `cts/core/v1`
- `cts/aes/v1`
- `cts/canonical/v1`

Adding or tightening coverage inside `v1` CTS does not automatically mean `AEON v2`.
It usually means the public conformance surface for `v1` got stronger.

## 3. Implementation And Package Version

Implementation artifacts use their own release versions.

Examples in this repo today:

- TypeScript packages under `implementations/typescript/**/package.json`
- Python package under `implementations/python/pyproject.toml`
- Rust workspace/crates under `implementations/rust/**/Cargo.toml`

At the moment, the public TypeScript, Python, and Rust implementation surfaces are
all on `0.9.0`.

These versions should follow SemVer as implementation releases:

- patch: bug fixes, parity fixes, conformance fixes, doc-only packaging fixes
- minor: backward-compatible feature additions
- major: breaking API/CLI/package changes

## Release Rule Of Thumb

If a change makes the implementation more correct against existing `AEON v1` spec
and `v1` CTS, that is usually a patch release, not a new language version.

Examples:

- fixing a custom-mode validation bug: patch
- fixing canonical formatting parity: patch
- adding new `v1` CTS cases for already-defined `v1` semantics: CTS update within `v1`

## Practical Guidance

- Do not infer the language version from the package version.
- Do not infer the package version from the CTS lane version.
- Keep spec compatibility statements explicit in docs and release notes.
- When possible, release TypeScript and Rust parity fixes together if they are
  implementing the same already-defined language behavior.

## Current Public Baseline

- Language/spec line: `AEON v1`
- CTS line: `v1`
- TypeScript implementation/package line: `0.9.0`
- Python implementation/package line: `0.9.0`
- Rust implementation/package line: `0.9.0`
