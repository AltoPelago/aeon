# Script Operations Guide

This directory contains deeper operational documentation for implementation-owned scripts under `scripts/`.

Use this alongside the quick index in [`scripts/README.md`](../../scripts/README.md):

- [`repo-paths.md`](./repo-paths.md): repository path resolution and environment variable behavior.
- [`source-lanes.md`](./source-lanes.md): CTS source-lane runner contract and lane expectations.
- [`canonical-and-stress.md`](./canonical-and-stress.md): canonical lane and stress harness usage guidance.

Common root wrappers:

- `npm run ci`
- `npm run ci:rust`
- `npm run ci:full`
- `npm run tests:all`

## Scope boundaries

- These documents describe implementation workflows only.
- Normative AEON language behavior is owned by `aeonite-org/aeonite-specs`.
- Cross-implementation conformance truth is owned by `aeonite-org/aeonite-cts`.
