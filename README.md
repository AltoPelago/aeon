# AEON

Core AEON implementation workspace.

License: MIT. See [LICENSE](./LICENSE).

It currently contains:

- `implementations/`
- `docs/implementations/`
- `scripts/`
- `stress-tests/`

Script catalog and operational usage notes live in [scripts/README.md](./scripts/README.md).
Deeper script runbooks live in [docs/scripts/README.md](./docs/scripts/README.md).

Root npm workflow wrappers:

- `npm run ci`: implementation CI entrypoint (delegates to TypeScript CI, including canonical cross-implementation checks).
- `npm run ci:rust`: full Rust workspace sweep (fmt/check/clippy/test).
- `npm run ci:rust:verbose`: same as `ci:rust`, but keeps Rust test stdout/stderr (`--nocapture`).
- `npm run ci:full`: `ci` plus `ci:rust`.
- `npm run tests:all`: `ci:full` plus matrix snippet combination run.

Security hardening notes:

- pull requests run dependency review plus a TypeScript lockfile integrity check
- TypeScript workspace installs prefer exact versions and frozen lockfile behavior
- Dependabot is configured for GitHub Actions, TypeScript npm dependencies, and Rust cargo dependencies

This repository contains the maintained AEON implementation surface.

Implementation references to specs, CTS, and contracts should continue to point at their proper authority surfaces rather than relying on mixed staging-era repo layout assumptions.

Related authority surfaces:

- [aeonite-org/aeonite-specs](https://github.com/aeonite-org/aeonite-specs): normative AEON specification authority
- [aeonite-org/aeonite-cts](https://github.com/aeonite-org/aeonite-cts): cross-implementation conformance authority

Centralized sibling-path resolution lives under:

- `scripts/repo-paths.mjs`
- `scripts/repo_paths.py`

The main environment overrides are:

- `AEONITE_CTS_ROOT`
- `AEON_TOOLING_ROOT`
- `AEONITE_SPECS_ROOT`

Future-facing sibling alias:

- `AEON_EXAMPLES_ROOT`

Backward-compatible alias:

- `AEON_TOOLING_PRIVATE_ROOT`
- `AEON_EXAMPLES_PRIVATE_ROOT`

TypeScript generated outputs under `implementations/typescript/**/dist/` are build artifacts, not source of truth.
The expected workflow in this repo is to install dependencies and build locally before running CTS or package tests.

Governance and contribution expectations are tracked in [GOVERNANCE.md](./GOVERNANCE.md).
Contributor guidance is tracked in [CONTRIBUTING.md](./CONTRIBUTING.md).
Security reporting guidance is tracked in [SECURITY.md](./SECURITY.md).

Release workflow notes for the TypeScript npm surface are tracked in [RELEASING.md](./RELEASING.md).
Version separation across spec, CTS, and implementation packages is tracked in [VERSIONING.md](./VERSIONING.md).
