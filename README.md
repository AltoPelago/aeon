# AEON

AEON implementations for TypeScript, Rust, and Python, with libraries and
command-line tools for parsing, validation, canonical formatting, and AES/Telex
interchange.

License: MIT. See [LICENSE](./LICENSE).

Public language guide and user-facing documentation: [AltoPelago/aeon wiki](https://github.com/AltoPelago/aeon/wiki).
Implementation website: [aeon.altopelago.com](https://aeon.altopelago.com).
Specification website: [aeonite.org](https://aeonite.org).

AltoPelago owns this implementation workspace. Aeonite publishes the
specification and CTS surfaces this implementation follows.

## Implementations

| Language / runtime | Package and entry point | Documentation |
| --- | --- | --- |
| TypeScript / JavaScript | `@altopelago/aeon-runtime` on npm; lower-level packages for individual pipeline stages | [TypeScript workspace](./implementations/typescript/README.md) |
| Rust | `altopelago-aeon` crate; import as `altopelago_aeon` | [Rust SDK](./implementations/rust/crates/aeon-sdk/README.md) and [workspace / CLI](./implementations/rust/README.md) |
| Python (native) | `altopelago-aeon` distribution; import as `altopelago.aeon`; backed by Rust | [Native Python API](./implementations/rust/crates/aeon-python/README.md) |
| Python (reference) | Dependency-free implementation in `implementations/python/`; source package `aeon-python` | [Pure-Python implementation](./implementations/python/README.md) |

The native Python package and the pure-Python reference implementation are
separate APIs. The native package does not fall back to the reference implementation.
Supported features and CLI commands vary by implementation; see each guide for
its scope. Implementation/package versions are separate from language and CTS
versions; see [VERSIONING.md](./VERSIONING.md).

### TypeScript / JavaScript

The TypeScript implementation is published on npm as public packages under the
`@altopelago` scope. Start with the runtime when you want the full AEON pipeline:

```bash
npm install @altopelago/aeon-runtime
```

Use lower-level packages when you need a narrower integration surface:

- `@altopelago/aeon-core` - lexer, parser, path resolution, AES emission
- `@altopelago/aeos-core` - AEOS schema validation
- `@altopelago/aeon-canonical` - canonical representation
- `@altopelago/aeon-cli` - command-line tools
- `@altopelago/aeon-wasm` - WebAssembly package for browser/runtime alignment work

### Rust

Add the public facade crate to your Rust project:

```bash
cargo add altopelago-aeon
```

The SDK combines compilation, AEOS validation, document loading, and portable
AES/Telex interchange. See the [Rust SDK guide](./implementations/rust/crates/aeon-sdk/README.md)
for API usage and optional SANSA integration.

### Python

Install the native Rust-backed package for CPython 3.12–3.14:

```bash
python -m pip install altopelago-aeon
```

```python
import altopelago.aeon as aeon

loaded = aeon.load_text('greeting:string = "Hello"').require_ok()
print(loaded.document)
```

For the independent dependency-free implementation and its source CLI, see the
[pure-Python guide](./implementations/python/README.md).

## Repository layout and development

This repository contains:

- `implementations/` - TypeScript, Rust, and pure-Python workspaces; native Python bindings live in the Rust workspace
- `docs/implementations/` - implementation guides and design notes
- `scripts/` - shared verification and maintenance tools
- `stress-tests/` - shared stress and parity fixtures

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
- pull requests reject unexpected TypeScript lifecycle scripts outside the reviewed allowlist
- GitHub Actions are pinned to immutable commit SHAs rather than moving version tags
- CODEOWNERS covers workflow, manifest, lockfile, and package publish-surface changes
- TypeScript workspace installs prefer exact versions and frozen lockfile behavior
- Dependabot is configured for GitHub Actions, TypeScript npm dependencies, and Rust cargo dependencies
- Rust CI performs both RustSec advisory scanning (`cargo audit`) and policy checks (`cargo deny`)
- central TypeScript publish-control changes and non-first-wave publish metadata changes are blocked by a dedicated PR guardrail
- the Python implementation is currently dependency-free, so its main hardening goal is to preserve that small trust surface

This repository contains the maintained AEON implementation surface.

Implementation references to specs, CTS, and contracts should continue to point at their proper authority surfaces rather than relying on mixed staging-era repo layout assumptions.

Related authority surfaces:

- [aeon.altopelago.com](https://aeon.altopelago.com): implementation website
- [aeonite.org](https://aeonite.org): specification website
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

Release workflow notes for npm, Rust crates, and native Python packages are tracked in [RELEASING.md](./RELEASING.md).
Package changes are tracked in [CHANGELOG.md](./CHANGELOG.md).
Branching and implementation-specific release strategy are tracked in [docs/release-strategy.md](./docs/release-strategy.md).
Version separation across spec, CTS, and implementation packages is tracked in [VERSIONING.md](./VERSIONING.md).
Implementation CTS snapshot claims are tracked in [conformance/cts-claims.json](./conformance/cts-claims.json).
