# AEON Private

This repository is the private maintenance surface for the core AEON implementations.

It currently contains:

- `implementations/`
- `docs/implementations/`
- `scripts/`
- `stress-tests/`

This layout is intended to become the basis for the public `aeon` implementation surface once repo framing and the remaining support-material split are cleaned up.

Implementation references to specs, CTS, and contracts should continue to point at their proper authority surfaces rather than relying on mixed staging-era repo layout assumptions.

Centralized sibling-path resolution lives under:

- `scripts/repo-paths.mjs`
- `scripts/repo_paths.py`

The main environment overrides are:

- `AEONITE_CTS_ROOT`
- `AEON_TOOLING_PRIVATE_ROOT`
- `AEONITE_SPECS_ROOT`

TypeScript generated outputs under `implementations/typescript/**/dist/` are build artifacts, not source of truth.
The expected workflow in this repo is to install dependencies and build locally before running CTS or package tests.
