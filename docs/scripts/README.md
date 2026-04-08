# Script Operations Guide

This directory contains deeper operational documentation for implementation-owned scripts under `scripts/`.

Use this alongside the quick index in [`scripts/README.md`](../../scripts/README.md):

- [`repo-paths.md`](./repo-paths.md): repository path resolution and environment variable behavior.
- [`source-lanes.md`](./source-lanes.md): CTS source-lane runner contract and lane expectations.
- [`canonical-and-stress.md`](./canonical-and-stress.md): canonical lane and stress harness usage guidance.

Common root wrappers:

- `npm run ci`
- `npm run ci:rust`
- `npm run ci:rust:verbose`
- `npm run ci:full`
- `npm run tests:all`

Security-related helpers:

- `scripts/check-typescript-lockfile.sh`
- `scripts/check-typescript-lifecycle-scripts.mjs`
- `scripts/check-typescript-publish-surface.mjs`
- `implementations/rust/deny.toml` (`cargo deny` policy input for Rust CI)

Security workflow guardrails:

- `.github/CODEOWNERS` keeps workflow, manifest, lockfile, and publish-surface changes under explicit owner review.
- `.github/workflows/dependency-security.yml` runs dependency review, lockfile integrity, lifecycle-script policy, `cargo audit`, and `cargo deny`.
- `.github/workflows/publish-guard.yml` blocks central TypeScript publish-control changes and non-first-wave publish metadata changes unless they are handled as an explicit release-policy update.

## Scope boundaries

- These documents describe implementation workflows only.
- Normative AEON language behavior is owned by `aeonite-org/aeonite-specs`.
- Cross-implementation conformance truth is owned by `aeonite-org/aeonite-cts`.
