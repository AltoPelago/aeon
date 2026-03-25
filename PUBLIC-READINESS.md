# Public Readiness

This document tracks the remaining work before this repository can become the
public `aeon` implementation surface.

## Already true

- TypeScript, Python, and Rust implementations are verified in the split repo layout.
- The TypeScript workspace is source-first rather than checked-in `dist` first.
- Shared sibling path resolution is centralized under `scripts/repo-paths.mjs` and `scripts/repo_paths.py`.
- The current implementation baseline is `0.9.0`.

## Remaining work

- decide whether the current script classification in `scripts/README.md` is final
- decide whether `stress-tests/` stays entirely in `aeon` or is partly reduced further as public-facing implementation hardening material
- keep replacing remaining private-oriented naming in env vars and docs where neutral names are preferable
- add public release framing, versioning guidance, and contributor-facing repo documentation for the future `aeon` repo
- verify that all sibling references use stable authority surfaces:
  - `aeonite-org/aeonite-specs`
  - `aeonite-org/aeonite-cts`
  - future public `aeon-tooling`
  - future public `aeon-examples`

## Current recommendation

Treat this repository as the source candidate for public `aeon`, but do not
publish it unchanged. Finish the public framing and support-material decisions
first, then promote from this cleaned baseline.
