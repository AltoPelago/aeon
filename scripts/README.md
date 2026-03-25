# Implementation Scripts

Implementation-owned support scripts live here.

This includes:

- hardening and parity runners
- canonical comparison helpers
- benchmark and release-maintenance helpers

These scripts should only move into a public implementation surface if they are intentionally part of the maintained public workflow.

Current public-readiness classification:

- likely public workflow:
  - `cts-source-lane-runner.mjs`
  - `repo-paths.mjs`
  - `repo_paths.py`
  - `run-with-repo-paths.mjs`
  - `ensure-typescript-build.mjs`
  - `compare-canonical-implementations.py`
  - `canonical-cts.sh`
- likely implementation-internal:
  - `bench-cli.py`
  - `stress-smoke.sh`
  - `stress-fixtures.py`
  - `stress-positive-snippets.py`
  - `stress-negative-snippets.py`
  - `stress-canonical-snippets.py`
- likely archival or release-maintenance:
  - `pack-sdk-internal.sh`
  - `release-cut.sh`
  - `resign-rust-release.sh`
