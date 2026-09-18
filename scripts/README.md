# Implementation Scripts

Implementation-owned support scripts live in this directory.

This page is the operational index for:

- CTS lane orchestration helpers
- canonical and diagnostic parity checks
- stress and hardening harnesses
- local safety and benchmarking utilities

For deeper runbooks (contracts, lane semantics, and troubleshooting), see
[`docs/scripts/README.md`](../docs/scripts/README.md).

## Implementation versioning

`version.mjs` atomically checks, updates, and recovers the independent
TypeScript, Rust, and Python implementation version tracks. Run it through the
root package scripts documented in [`VERSIONING.md`](../VERSIONING.md). It does
keep each track's CTS claim implementation version aligned. It does not edit
changelog prose or create Git commits and tags.

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
| `check-typescript-lockfile.sh` | Fails when TypeScript dependency manifests change without a matching `pnpm-lock.yaml` update. | `bash ./scripts/check-typescript-lockfile.sh <base-sha> <head-sha>` |
| `check-typescript-lifecycle-scripts.mjs` | Fails when TypeScript packages add unexpected lifecycle scripts outside the explicit reviewed allowlist. | `node ./scripts/check-typescript-lifecycle-scripts.mjs` |
| `check-typescript-publish-surface.mjs` | Blocks high-risk TypeScript publish-control changes and non-first-wave manifest publish metadata changes in PRs. | `node ./scripts/check-typescript-publish-surface.mjs <base-sha> <head-sha>` |
| `repo-paths.mjs` | Node resolver for CTS/spec/tooling sibling roots and env defaults. | imported by other scripts |
| `repo_paths.py` | Python resolver for CTS/spec/tooling sibling roots and env defaults. | imported by other scripts |
| `run-with-repo-paths.mjs` | Runs a command with repo-path env defaults and normalized `--cts` argument. | `node ./scripts/run-with-repo-paths.mjs node ... --cts ...` |
| `ensure-typescript-build.mjs` | Verifies required TypeScript dist artifacts exist before CTS/test runs. | `node ./scripts/ensure-typescript-build.mjs` |
| `cts-source-lane-runner.mjs` | Shared CLI runner for source, finalization, SANSA-address, and AES path-translation lanes. | `node ./scripts/cts-source-lane-runner.mjs --sut ... --cts ... --lane core` |
| `aes-path-translation-cts.sh` | Runs recursive AES source/event path translation and synthetic-head rejection vectors across TypeScript, Rust, Python, and PHP. | `bash ./scripts/aes-path-translation-cts.sh` |
| `canonical-cts.sh` | Canonical conformance composite runner (TS + Rust + cross-implementation parity). | `bash ./scripts/canonical-cts.sh --mode all --brief` |
| `compare-canonical-implementations.py` | Compares TypeScript and Python canonical `fmt` output across fixture corpora. | `python3 ./scripts/compare-canonical-implementations.py` |

### Implementation and hardening helpers

| Script | Purpose | Typical invocation |
| --- | --- | --- |
| `stress-smoke.sh` | Fast cross-implementation smoke run over selected stress fixtures. | `bash ./scripts/stress-smoke.sh --impl all` |
| `stress-fixtures.py` | Runs curated fixture matrix against TS/Python/Rust CLIs and checks exit/output expectations. | `python3 ./scripts/stress-fixtures.py --impl all` |
| `stress-fuzz-artifacts.py` | Runs Rust fuzz artifacts through TS/Python/Rust `inspect --json` flows and highlights implementation disagreement. | `python3 ./scripts/stress-fuzz-artifacts.py --only-interesting` |
| `stress-promote-artifact.py` | Copies a chosen fuzz artifact into the stress-test inbox with triage metadata and review notes. | `python3 ./scripts/stress-promote-artifact.py --artifact ... --slug ...` |
| `stress-positive-snippets.py` | Executes positive snippet corpora by mode (`transport`, `strict`, `custom`). | `python3 ./scripts/stress-positive-snippets.py --mode strict` |
| `stress-negative-snippets.py` | Executes negative snippet corpora and checks reject behavior. | `python3 ./scripts/stress-negative-snippets.py --mode strict` |
| `stress-canonical-snippets.py` | Canonical parity check for snippet corpora across implementations. | `python3 ./scripts/stress-canonical-snippets.py --mode all` |
| `stress-diagnostic-snippets.py` | Diagnostic parity checks for curated syntax/error corpus. | `python3 ./scripts/stress-diagnostic-snippets.py --brief` |
| `stress-whitespace-mutations.py` | Whitespace mutation fuzzer for canonical and diagnostic consistency checks. | `python3 ./scripts/stress-whitespace-mutations.py` |
| `stress-comment-injection.py` | Compact grammar-rich source, inject structured comments at legal trivia slots, then compare canonical and annotation summaries. | `python3 ./scripts/stress-comment-injection.py` |
| `stress-combinations.py` | Generates matrix-driven snippet combinations and validates expected outcomes. | `python3 ./scripts/stress-combinations.py` |

### Bench and local maintenance helpers

| Script | Purpose | Typical invocation |
| --- | --- | --- |
| `bench-cli.py` | Repeatable local benchmark wrapper for CLI commands. | `python3 ./scripts/bench-cli.py --cwd implementations/rust -- ./target/release/aeon-rust check /tmp/file.aeon` |
| `generate-sofia-corpus.py` | Generates the deterministic large and adversarial fixtures named by the Sofia corpus manifest. | `python3 ./scripts/generate-sofia-corpus.py /tmp/aeon-sofia-corpus --json` |
| `check-sofia-parser-differential.py` | Regenerates and hash-verifies the frozen Sofia corpus, then compares complete strict/recovery parser results and downstream compile results between the internal Baseline and Sofia selectors. | `npm run test:sofia:differential` |
| `bench-sofia-baseline.py` | Captures native Rust and pure-Python in-process Sofia baselines with repository, environment, corpus-hash, percentile, throughput, Rust phase timings, and isolated Python parse/path/event-construction timings. | `python3 ./scripts/bench-sofia-baseline.py --implementation native --profile full --output /tmp/sofia-baseline.json` |
| `bench-sofia-python.py` | Measures an installed exact or `abi3-py312` native Python wheel against matching native Rust, separating native-envelope work, cached Python conversion, ergonomic compilation, and encoded Telex. | `python3 ./scripts/bench-sofia-python.py --variant exact --wheel /tmp/wheel.whl --output /tmp/python-boundary.json` |
| `compare-sofia-python-abi.py` | Aggregates repeated installed-wheel captures and applies the predeclared 3% geometric-mean and 5% large-case ABI policy. | `python3 ./scripts/compare-sofia-python-abi.py --exact /tmp/exact.json --abi3 /tmp/abi3.json` |
| `bench-sofia-memory.py` | Captures fresh-process native peak RSS, an RSS-based allocation-pressure proxy, hostile-input behavior, and the supported nesting-depth matrix. | `python3 ./scripts/bench-sofia-memory.py --output /tmp/sofia-memory.json` |
| `bench-sofia-wasm.mjs` | Separately captures WASM initialization, Rust/WASM processing, raw JSON-envelope calls, estimated serialization/string-return cost, JavaScript wrapper adaptation, and linear-memory growth for one Sofia corpus fixture. | `node ./scripts/bench-sofia-wasm.mjs --iterations 10 --warmup 2 /tmp/aeon-sofia-corpus/large-flat-50000.aeon` |
| `bench-sofia-wasm-stream.mjs` | Measures bounded Sofia WASM streaming across batch capacities, separating input processing, batch serialization/return, JavaScript JSON parsing, event adaptation, terminal work, boundary crossings, and final linear memory. | `node ./scripts/bench-sofia-wasm-stream.mjs --iterations 10 --warmup 2 /tmp/aeon-sofia-corpus/large-flat-50000.aeon` |
| `measure-peak-rss.py` | Runs one command in a fresh child process and reports normalized `ru_maxrss` plus process resource counters. | `python3 ./scripts/measure-peak-rss.py --parse-json -- ./command --json` |
| `bench-telex-vs-json.mjs` | Compares raw and structurally validated compact JSON, limits-aware TypeScript Telex, and end-to-end Rust/WASM bulk-operation throughput over 100 to 100,000 portable events. The limit-scale case selects an explicit workload-sized list limit rather than weakening runtime defaults. | `cd implementations/typescript && pnpm bench:telex` |

## Notes on authority boundaries

- These scripts are implementation workflows, not language specification authority.
- Normative behavior authority remains in `aeonite-org/aeonite-specs`.
- Cross-implementation conformance authority remains in `aeonite-org/aeonite-cts`.
