# Stress Tests

Manual AEON stress fixtures and tooling for smoke validation.
Last verified: 2026-03-10.

## Public Surface Role

This tree is kept in the implementation repo as hardening and parity material,
not as the canonical conformance authority.

Public-readiness classification:

- `canonical/`
  - implementation hardening copies of canonicalization-sensitive fixtures
  - some reduced cases are already promoted into `aeonite-cts`
- `edge/`
  - implementation hardening negatives and boundary cases
  - reduced deterministic cases may later be promoted into `aeonite-cts`
- `domain/`
  - feature-family hardening corpora used to prevent implementation drift
- `full/`
  - broad kitchen-sink implementation stress documents
- `snippets/`
  - editable parity corpora for positive/negative/canonical smoke work
- `tools/`
  - implementation-owned stress harnesses, not normative conformance tooling

Rule of thumb:

- if a fixture is normative and should gate public conformance, promote or
  reduce it into `aeonite-cts`
- if a fixture is primarily implementation hardening, keep it here

## Current Baseline

| Lane | Command | Current expectation |
|---|---|---|
| Smoke fixtures | `bash ./scripts/stress-smoke.sh` | portable repo-level smoke run across available TypeScript/Python/Rust CLIs |
| Full fixture matrix | `python3 ./scripts/stress-fixtures.py --impl rust` | broader shared fixture run with per-fixture options and known-red reporting |
| Positive snippets | `python3 ./scripts/stress-positive-snippets.py` | editable corpus of mini fixtures that must pass |
| Negative snippets | `python3 ./scripts/stress-negative-snippets.py` | editable corpus of mini fixtures that must fail |
| Combination corpora | `python3 ./scripts/stress-combinations.py --run both` | expands mode-aware combination matrices into generated positive/negative snippet corpora and can immediately run them |
| Canonical snippet parity | `python3 ./scripts/stress-canonical-snippets.py` | positive structural snippets must canonicalize identically across implementations |
| Diagnostic snippet parity | `python3 ./scripts/stress-diagnostic-snippets.py` | curated syntax diagnostics must match across implementations |
| Whitespace mutation parity | `python3 ./scripts/stress-whitespace-mutations.py` | generated whitespace/newline variants around structural tokens must not drift across implementations |
| Canonical CTS lane | `bash ./scripts/canonical-cts.sh` | canonical package tests plus cross-implementation canonical and diagnostic snippet parity |
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

- `edge/string-literal-newline.aeon`
  - Negative fixture expecting quoted strings to fail closed when a literal newline appears before the closing delimiter.

- `edge/unicode-braced-incomplete.aeon`
  - Negative fixture expecting `INVALID_ESCAPE` for an incomplete braced Unicode escape introducer.

- `edge/unicode-braced-missing-close.aeon`
  - Negative fixture expecting `INVALID_ESCAPE` for a braced Unicode escape missing its closing `}`.

- `edge/unicode-braced-nonhex.aeon`
  - Negative fixture proving a braced Unicode escape with non-hex digits fails closed.

- `edge/escaped-decoded-identity-duplicate.aeon`
  - Negative fixture proving escaped and literal equivalent keys collide at one canonical path.

- `edge/unicode-invalid-escape.aeon`
  - Negative fixture expecting `INVALID_ESCAPE` for malformed quoted escapes.

- `edge/unicode-out-of-range-escape.aeon`
  - Negative fixture expecting `INVALID_ESCAPE` for out-of-range braced Unicode escapes.

- `edge/unicode-word-joiner-structural.aeon`
  - Negative fixture expecting `UNEXPECTED_CHARACTER` for a disallowed structural word joiner.

- `edge/unicode-line-separator-structural.aeon`
  - Negative fixture expecting `UNEXPECTED_CHARACTER` for a disallowed structural line separator.

- `edge/trailing-garbage-after-number.aeon`
  - Negative fixture proving a valid numeric binding plus stray trailing text fails closed.

- `edge/trailing-garbage-after-string.aeon`
  - Negative fixture proving a valid string binding plus stray trailing text fails closed.

- `edge/trailing-garbage-after-node.aeon`
  - Negative fixture proving a valid node binding plus stray trailing text fails closed.

- `edge/trailing-garbage-after-object.aeon`
  - Negative fixture proving a valid object binding plus stray trailing text fails closed.

- `edge/trailing-garbage-after-list.aeon`
  - Negative fixture proving a valid list binding plus stray trailing text fails closed.

- `edge/trailing-garbage-after-reference.aeon`
  - Negative fixture proving a valid reference binding plus stray trailing text fails closed.

- `domain/addressing/nesting-addressing.aeon`
  - Nested list/object addressing with indexed paths.

- `domain/addressing/namespace-quoted-keys.aeon`
  - Namespace recommendation + quoted-key addressing checks.

- `domain/addressing/escaped-quoted-keys.aeon`
  - Escaping behavior for quoted keys/segments.

- `domain/addressing/escaped-decoded-identity.aeon`
  - Escaped Unicode spellings that must resolve to the same decoded key,
    selector, and node-tag identity as their literal equivalents.

- `domain/addressing/escaped-decoded-identity-pointers.aeon`
  - Escaped Unicode spellings that must resolve to the same decoded key and attribute identities for pointer references.

- `domain/addressing/escaped-decoded-identity-rooted.aeon`
  - Escaped Unicode spellings that must resolve to the same decoded identities through rooted and chained clone references.

- `domain/addressing/escaped-normalization-distinct-keys.aeon`
  - Escaped Unicode spellings that decode to NFC- and NFD-distinct keys and must remain separate canonical identities.

- `domain/literals/inline-array-literals-pass.aeon`
  - Inline array pass coverage for literal families that should delimit safely.

- `domain/literals/heterogeneous-inline-nesting.aeon`
  - Mixed inline list nesting with scalars, object literals, separator literals, and node literals.

- `domain/literals/trimticks-mixed-whitespace.aeon`
  - Mixed whitespace coverage for `trimticks`, ordinary backticks, and canonical multiline equivalence.

- `domain/literals/leading-dot-decimals.aeon`
  - Leading-dot decimal acceptance and normalization coverage.

- `domain/literals/unicode-escape-pair.aeon`
  - Quoted Unicode escape coverage for basic escapes and supplementary-codepoint surrogate pairs.

- `domain/literals/unicode-unpaired-surrogates.aeon`
  - Quoted Unicode escape coverage for lone high and low surrogate escape spellings.

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

Generate mode-aware combination corpora and optionally run them through the
existing snippet lanes:

```bash
python3 ./scripts/stress-combinations.py
python3 ./scripts/stress-combinations.py --matrix ./stress-tests/matrices/literal-mode-combinations.toml
python3 ./scripts/stress-combinations.py --run both --impl rust
python3 ./scripts/stress-combinations.py --run both --brief --failures-only
```

The matrix file is TOML. Each `[[stress]]` entry expands as a Cartesian product
across its `value` rows, then resolves mode-aware fields such as `type` and
`outcome` per mode. `type` and `outcome` may be declared as:

- a single string used for all modes
- a mode-keyed inline table such as `{ strict = ":number", custom = ":n", transport = "" }`
- an array whose positions follow top-level `mode_order`

When a mode-keyed inline table omits a mode, the generator skips that mode for
the entry. This lets a case target only the modes it cares about without adding
an explicit `modes = [...]` list. If you do provide `modes = [...]`, every
listed mode must still be defined by the entry's mode-aware fields.

Generated corpora are written under `stress-tests/snippets/generated/` as
`<matrix>.positive-<mode>.aeon-cases` and `<matrix>.negative-<mode>.aeon-cases`,
with a sidecar JSON manifest for traceability.

When `--run` is enabled, `--failures-only` suppresses `PASS` lines in the
underlying snippet harnesses so only `FAIL`, `SKIP`, and the final summary are
printed.

For Rust snippet runs, the harness now batches `.aeon-cases` corpora through
`aeon-rust inspect-cases` when that command is available. That avoids spawning
the Rust CLI once per snippet and makes large combination sweeps noticeably
faster without changing the stress command surface.

The combination runner is intentionally a local/manual tool. It is not wired
into GitHub CI, because the generated Cartesian-product sweeps are too large for
the normal deploy path. CI currently stays on the smaller smoke and advanced
stress lanes.

Run canonical parity across the positive structural snippet corpora:

```bash
python3 ./scripts/stress-canonical-snippets.py
python3 ./scripts/stress-canonical-snippets.py --mode strict
python3 ./scripts/stress-canonical-snippets.py --brief
```

Run diagnostic parity across the curated syntax corpus:

```bash
python3 ./scripts/stress-diagnostic-snippets.py
python3 ./scripts/stress-diagnostic-snippets.py --brief
```

Run generated whitespace/newline mutation parity from a curated seed corpus:

```bash
python3 ./scripts/stress-whitespace-mutations.py
python3 ./scripts/stress-whitespace-mutations.py --depth 2
python3 ./scripts/stress-whitespace-mutations.py --brief
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
- cross-implementation diagnostic snippet parity via `stress-diagnostic-snippets.py`

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
  ./stress-tests/full/full-feature-stress.aeon \
  ./stress-tests/full/scenarios.aeon
```
