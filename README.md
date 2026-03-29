# AEON

Core AEON implementation workspace.

License: MIT. See [LICENSE](./LICENSE).

It currently contains:

- `implementations/`
- `docs/implementations/`
- `scripts/`
- `stress-tests/`

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
