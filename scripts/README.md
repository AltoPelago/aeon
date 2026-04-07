# Implementation Scripts

Implementation-owned support scripts live in this directory.

This page is the operational index for:

- CTS lane orchestration helpers
- canonical and diagnostic parity checks
- stress and hardening harnesses
- local safety and benchmarking utilities

## Shared prerequisites

- Run commands from repo root unless noted.
- Build TypeScript first for most script workflows:
  - `cd implementations/typescript && pnpm install && pnpm build`
- Many cross-repo scripts expect sibling checkouts:
  - `aeonite-org/aeonite-cts`
  - `aeonite-org/aeonite-specs`
- Shared env overrides:
  - `AEONITE_CTS_ROOT`
  - `AEON_TOOLING_ROOT`
  - `AEON_TOOLING_PRIVATE_ROOT` (legacy alias)
  - `AEONITE_SPECS_ROOT`

## Script index

### Public workflow helpers

| Script | Purpose | Typical invocation |
| --- | --- | --- |
| `check-no-local-paths.sh` | Fails if tracked files contain machine-local filesystem paths. | `bash ./scripts/check-no-local-paths.sh` |
| `pre-commit-check.sh` | Runs pre-commit safety checks (currently local-path scan). | `bash ./scripts/pre-commit-check.sh` |
| `repo-paths.mjs` | Node resolver for CTS/spec/tooling sibling roots and env defaults. | imported by other scripts |
| `repo_paths.py` | Python resolver for CTS/spec/tooling sibling roots and env defaults. | imported by other scripts |
| `run-with-repo-paths.mjs` | Runs a command with repo-path env defaults and normalized `--cts` argument. | `node ./scripts/run-with-repo-paths.mjs node ... --cts ...` |
| `ensure-typescript-build.mjs` | Verifies required TypeScript dist artifacts exist before CTS/test runs. | `node ./scripts/ensure-typescript-build.mjs` |
| `cts-source-lane-runner.mjs` | Shared runner for source lanes (`core`, `aes`, `canonical`) via CLI `inspect --json`. | `node ./scripts/cts-source-lane-runner.mjs --sut ... --cts ... --lane core` |
| `canonical-cts.sh` | Canonical conformance composite runner (TS + Rust + cross-implementation parity). | `bash ./scripts/canonical-cts.sh --mode all --brief` |
| `compare-canonical-implementations.py` | Compares TypeScript and Python canonical `fmt` output across fixture corpora. | `python3 ./scripts/compare-canonical-implementations.py` |

### Implementation and hardening helpers

| Script | Purpose | Typical invocation |
| --- | --- | --- |
| `stress-smoke.sh` | Fast cross-implementation smoke run over selected stress fixtures. | `bash ./scripts/stress-smoke.sh --impl all` |
| `stress-fixtures.py` | Runs curated fixture matrix against TS/Python/Rust CLIs and checks exit/output expectations. | `python3 ./scripts/stress-fixtures.py --impl all` |
| `stress-positive-snippets.py` | Executes positive snippet corpora by mode (`transport`, `strict`, `custom`). | `python3 ./scripts/stress-positive-snippets.py --mode strict` |
| `stress-negative-snippets.py` | Executes negative snippet corpora and checks reject behavior. | `python3 ./scripts/stress-negative-snippets.py --mode strict` |
| `stress-canonical-snippets.py` | Canonical parity check for snippet corpora across implementations. | `python3 ./scripts/stress-canonical-snippets.py --mode all` |
| `stress-diagnostic-snippets.py` | Diagnostic parity checks for curated syntax/error corpus. | `python3 ./scripts/stress-diagnostic-snippets.py --brief` |
| `stress-whitespace-mutations.py` | Whitespace mutation fuzzer for canonical and diagnostic consistency checks. | `python3 ./scripts/stress-whitespace-mutations.py` |
| `stress-combinations.py` | Generates matrix-driven snippet combinations and validates expected outcomes. | `python3 ./scripts/stress-combinations.py` |

### Bench and local maintenance helpers

| Script | Purpose | Typical invocation |
| --- | --- | --- |
| `bench-cli.py` | Repeatable local benchmark wrapper for CLI commands. | `python3 ./scripts/bench-cli.py --cwd implementations/rust -- ./target/release/aeon-rust check /tmp/file.aeon` |

## Notes on authority boundaries

- These scripts are implementation workflows, not language specification authority.
- Normative behavior authority remains in `aeonite-org/aeonite-specs`.
- Cross-implementation conformance authority remains in `aeonite-org/aeonite-cts`.
