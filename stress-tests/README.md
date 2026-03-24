# Stress Tests

Manual AEON stress fixtures and tooling for smoke validation.
Last verified: 2026-03-10.

## Current Baseline

| Lane | Command | Current expectation |
|---|---|---|
| Smoke fixtures | `bash ./scripts/stress-smoke.sh` | portable repo-level smoke run across available TypeScript/Python/Rust CLIs |
| Full fixture matrix | `python3 ./scripts/stress-fixtures.py --impl rust` | broader shared fixture run with per-fixture options and known-red reporting |
| Positive snippets | `python3 ./scripts/stress-positive-snippets.py` | editable corpus of mini fixtures that must pass |
| Negative snippets | `python3 ./scripts/stress-negative-snippets.py` | editable corpus of mini fixtures that must fail |
| Canonical snippet parity | `python3 ./scripts/stress-canonical-snippets.py` | positive structural snippets must canonicalize identically across implementations |
| Canonical CTS lane | `bash ./scripts/canonical-cts.sh` | canonical package tests plus cross-implementation canonical snippet parity |
| Stress CLI | `npm run stress` | `21/21` pass |
| Stress CLI advanced | `npm run stress-advanced` | `15/15` pass |
| Stress CLI phase timing | `npm run phase-timing` | `8/8` pass |
| 52-Cards summary | `npm run cards-summary` | `4367/4367` pass |

Notes:
- `aeon-stress-cli` asserts targeted runtime and policy behavior.
- `aeon-52-cards` reports normative coverage separately from implementation-only cases.
- phase timing also writes CSV output to `stress-tests/tools/aeon-stress-cli/results/phase-timing.csv`.

## Layout

- `full/`
  - Broad, kitchen-sink stress files.
- `edge/`
  - Targeted negative/edge fixtures.
- `domain/`
  - Domain-focused fixtures by feature area (for example `comments`, `addressing`).
- `domain/literals/`
  - Literal-family fixtures and inline-boundary coverage.
- `canonical/`
  - Canonicalization-focused fixtures (node introducer, separator variants, legacy rejection).
- `tools/aeon-stress-cli/`
  - Node CLI harness for strict-mode stress and phase timing.
- `tools/aeon-52-cards/`
  - Combinatorial interaction testing harness (52-Cards problem).

## Fixture Index

- `full/full-feature-stress.aeon`
  - Full-feature stress document.

- `full/comment-stress-pass.aeon`
  - Comment-heavy pass fixture.

- `domain/comments/comment-stress-slash-channels.aeon`
  - Slash-channel stress fixture (`/# #/`, `/@ @/`, `/? ?/`, `/{ }/`, `/[ ]/`, `/( )/`).

- `edge/comment-stress-unterminated.aeon`
  - Negative fixture expecting `UNTERMINATED_BLOCK_COMMENT`.

- `edge/inline-array-separator-boundaries.aeon`
  - Negative fixture documenting separator-literal greediness and separator-char collisions.

- `domain/addressing/nesting-addressing.aeon`
  - Nested list/object addressing with indexed paths.

- `domain/addressing/namespace-quoted-keys.aeon`
  - Namespace recommendation + quoted-key addressing checks.

- `domain/addressing/escaped-quoted-keys.aeon`
  - Escaping behavior for quoted keys/segments.

- `domain/literals/inline-array-literals-pass.aeon`
  - Inline array pass coverage for literal families that should delimit safely.

- `domain/literals/heterogeneous-inline-nesting.aeon`
  - Mixed inline list nesting with scalars, object literals, separator literals, and node literals.

- `domain/literals/trimticks-mixed-whitespace.aeon`
  - Mixed whitespace coverage for `trimticks`, ordinary backticks, and canonical multiline equivalence.

- `domain/literals/leading-dot-decimals.aeon`
  - Leading-dot decimal acceptance and normalization coverage.

- `canonical/node-introducer-singleline.aeon`
  - Single-line node introducer fixture.

- `canonical/node-introducer-multiline.aeon`
  - Multi-line node introducer fixture.

- `canonical/node-mixed-separators.aeon`
  - Mixed comma/newline node child separators.

- `canonical/node-trailing-separator.aeon`
  - Trailing node-child separator acceptance fixture.

- `canonical/node-legacy-reject.aeon`
  - Invalid non-introducer node fixture expected to fail.

- `domain/comments/r5-comment-notes.md`
  - r5 comment-shape notes for stress coverage.

## Smoke Runner

From repo root:

```bash
bash ./scripts/stress-smoke.sh
python3 ./scripts/stress-fixtures.py --impl rust
```

`stress-smoke.sh` stays intentionally small and fast. `stress-fixtures.py` runs the broader shared fixture
matrix, including domain fixtures and per-fixture options such as `--datatype-policy allow_custom`.
Known-red fixtures are reported separately so they stay visible without masking implementation-specific regressions.

Run the editable negative-snippet corpus:

```bash
python3 ./scripts/stress-negative-snippets.py
python3 ./scripts/stress-negative-snippets.py --impl rust
python3 ./scripts/stress-negative-snippets.py --brief
python3 ./scripts/stress-negative-snippets.py --file ./stress-tests/snippets/invalid.aeon-cases
```

Python implementation note:
- the snippet harness invokes [implementations/python/bin/aeon-python](../implementations/python/bin/aeon-python), not a direct module import;
- for ad hoc Python CLI checks, prefer that wrapper from repo root so you match the same runtime/path setup as the stress scripts.

TypeScript implementation note:
- the snippet harness invokes [main.js](../implementations/typescript/packages/cli/dist/main.js);
- for ad hoc TypeScript build/test commands, prefer running them from [implementations/typescript](../implementations/typescript), where the workspace-local `typescript` toolchain is available;
- a reliable pattern is `cd implementations/typescript && pnpm --filter @aeon/parser build` rather than invoking filtered TS builds from the repo root.

The corpus file is split on lines containing only `---`. Each snippet is expected
to fail. If any snippet unexpectedly passes for the selected implementation, the
runner prints the snippet and, unless `--brief` is set, the implementation output.

Run the editable positive-snippet corpus:

```bash
python3 ./scripts/stress-positive-snippets.py
python3 ./scripts/stress-positive-snippets.py --impl rust
python3 ./scripts/stress-positive-snippets.py --brief
python3 ./scripts/stress-positive-snippets.py --file ./stress-tests/snippets/valid.aeon-cases
```

This corpus uses the same `---` delimiter format, but every snippet is expected
to pass with empty `errors`.

Run canonical parity across the positive structural snippet corpora:

```bash
python3 ./scripts/stress-canonical-snippets.py
python3 ./scripts/stress-canonical-snippets.py --mode strict
python3 ./scripts/stress-canonical-snippets.py --brief
```

Run the full canonical conformance lane:

```bash
bash ./scripts/canonical-cts.sh
bash ./scripts/canonical-cts.sh --mode custom
bash ./scripts/canonical-cts.sh --brief
```

This lane intentionally bundles:
- TypeScript canonical package tests from the TypeScript workspace
- Rust canonical package tests from the Rust workspace
- cross-implementation canonical snippet parity via `stress-canonical-snippets.py`

Canonical parity is intentionally limited to positive structural corpora. Negative
strict/custom/transport corpora remain validation parity lanes, because `fmt` is
treated as a parse + core canonicalization tool rather than a full mode-aware validator.

Choose a single implementation explicitly:

```bash
bash ./scripts/stress-smoke.sh --impl typescript
bash ./scripts/stress-smoke.sh --impl python
bash ./scripts/stress-smoke.sh --impl rust
```

From `implementations/typescript`, manual examples:

```bash
node ./packages/cli/dist/main.js inspect ../../stress-tests/full/full-feature-stress.aeon --json --annotations
node ./packages/cli/dist/main.js inspect ../../stress-tests/domain/comments/comment-stress-slash-channels.aeon --json --annotations
node ./packages/cli/dist/main.js inspect ../../stress-tests/domain/addressing/nesting-addressing.aeon --json --annotations
node ./packages/cli/dist/main.js inspect ../../stress-tests/domain/literals/inline-array-literals-pass.aeon --json --annotations
node ./packages/cli/dist/main.js inspect ../../stress-tests/canonical/node-introducer-multiline.aeon --json --annotations
```

## Stress CLI Tool

Run targeted stress harnesses:

```bash
cd stress-tests/tools/aeon-stress-cli
npm i --cache .npm-cache --no-audit
npm run stress
npm run stress-advanced
npm run phase-timing
```

## 52-Cards Harness

Combinatorial interaction testing for AEON language features.

Generates pairwise and cross-category feature interaction documents, then evaluates them against six invariant classes: Core Parse Stability, SDK Finalize Stability, Canonical Idempotency, Annotation Isolation, Structural Integrity, and Resource Limits.

```bash
cd stress-tests/tools/aeon-52-cards
npm i --cache .npm-cache --no-audit
npm run cards            # standard run
npm run cards-summary    # summary-only output
npm run cards-verbose    # per-document details
```

See [`tools/aeon-52-cards/README.md`](tools/aeon-52-cards/README.md) for design details and feature categories.

## Cross-Implementation Canonical Parity

Run the full TypeScript and Python suites, then format the shared fixture corpus with both CLIs and compare the canonical text:

```bash
python3 ./scripts/compare-canonical-implementations.py
```

Compare only a subset of fixtures:

```bash
python3 ./scripts/compare-canonical-implementations.py \
  ./examples/aeon-1-hello-world/hello.aeon \
  ./stress-tests/full/scenarios.aeon
```
