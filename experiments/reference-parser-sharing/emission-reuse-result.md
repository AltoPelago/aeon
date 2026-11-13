# Narrow canonicalization heap follow-up — 19 October 2026

**PASS: all five applicable narrow-artifact gates clear. Adoption remains a separate decision.**

## Change and diagnostic evidence

Canonical ordering reuses the operation's already validated authored AES events,
instead of resolving/emitting that same parsed document again. This is a
call-local reuse of immutable input, with no cache or data shared between calls.
Both authored Core validation and fresh rendered parsing/path resolution/Core
validation remain unconditional. All dependency/edge limits, payload/source-plane
rules and reference-target semantics remain unchanged. Direct ordering calls
without a supplied event stream retain path resolution/emission/error checks.
The optional event argument is an internal ordering-module seam, not a new root
package API or an admission mechanism for reference expressions.

Relative to the prior failed `identifier-*` checkpoint, only canonical
`src/index.ts` and `src/ordering.ts` (and their generated artifacts) change.
Parser/index policy, SANSA source, scalar/dispatch/scratch cleanup, stateless
formatter/private regex, single-join rendering, portable rejection guards and
public result/error-array ownership stay unchanged. Identity steps remain
excluded; no engine/session/program/replay machinery returns.

The starting restricted retained-result data graphs are **237136 bytes/612 nodes**
for baseline and **236848 bytes/602 nodes** for candidate. Both include 200 output
strings of 1104 self bytes, 200 result objects and independent error arrays.
No extra retained AST/token data appears in those traversed data edges. This
excludes prototype/metadata edges and is **not** a retained-size oracle or proof
of the VM-level cause. Diagnostic CPU samples include indexing/path mapping, but
also module loading/snapshot work. Snapshot/profile flags perturb the process;
none of those diagnostic runs count toward acceptance. The concrete optimization
removes duplicate source resolution/emission identified by source inspection.

## Unchanged compatibility and target checks

- Fresh build; **2166 unit tests pass, 5 existing skips (2171 total)**.
- **55 contract checks pass**: all 45 prior narrow checks plus ten reuse fixtures.
  New cases compare exact ordering plans with fresh versus frozen validated
  event streams, including attributes, positional/node paths, partial/exact header
  collisions and node-head metadata. Stream contents remain unchanged; dependency
  edge-budget and illegal-reference checks remain fail-closed.
- SANSA **258 pass/75 existing skips**; CTS **85 value /32 address /37 Resolve /
  226 Query pass**, 13 Query skips. SANSA source is unchanged.
- Core **24 baseline/acceptance parity cases**, retaining four inherited exact
  diagnostic-list gaps; no full Core CTS claim.
- Each of four parser repetitions retains **396 cases: 356 identical + exactly
  40 approved numeric corrections**, and **68 whole-document comparisons with
  zero differences**. The earlier SANSA index bug-fix exception is unchanged;
  every unrelated difference still fails the evaluator.

## Full serial cost matrix

| Narrow candidate | Worst latency ratio | Worst retained-result heap ratio |
| --- | ---: | ---: |
| Parser (three standard + one reversed run) | 1.100622× | 1.000404× |
| Core/canonical pipeline (two runs) | 1.012740× | 1.145985× |

Reference-free canonical heap: 0.865344× / 0.963483×.
Short-reference canonical heap: 1.145985× / 1.125340×.
The reference-free starting failure was **1.2149751389295116×**; no prior failure
has been waived or discarded. Current failures: `[]`.

Ceilings remain **1.15× latency /1.20× retained-result heap**. Parser and pipeline
measurement files, source workloads, warming, 11-batch medians, retention counts
(1000 parser /200 pipeline), baseline calibration and reversed-order protocol are
unchanged. New runners/evaluators change only output prefixes. Lex+parse remains
an additional diagnostic under the original gate definition. Retained-result
heap is not an allocation-rate, peak-RSS or service-memory guarantee.

The third pipeline variant remains an explicitly labeled broader profile control;
0 control metric(s) exceed its original numeric ceilings in this
measurement context (recorded in `emission-reuse-verification.json`). These are
retained diagnostics, not narrow support or a new broader acceptance certificate.
Original identity-alias workloads and the 67 semantic profile/session/replay
checks remain intact with their original broader artifact/evidence. They cannot
be counted as tests or performance passes for narrow unsupported expressions.

## Integrity, packaging and scope

Before/after hashes match for **1152 source/build/control/baseline files**.
The previously accepted broader source's **422** runtime/build files, original
**19** protocol files and **100** baseline package files retain their pinned hashes.
Eight offline npm payload dry-runs pass, with four SANSA private-dependency source
files matching the retained SANSA worktree. Both primary checkouts remain clean.

No result/output/target cache, mutable shared state or changed result ownership is
introduced. Both authored and rendered checks remain, with fresh rendered target
validation. Existing canonical concrete-path/portable/evaluated-value, collision
and ordering checks are unchanged; no comparator/selector/namespace rule changes.

The original three failed matrices, exact runtime/SANSA archives and reports remain
retained. There is no unchanged-source acceptance retry. Release still needs
coordinated SANSA version/export/dependency changes, clean installed-package and
supported-runtime checks, plus native-port evidence. This is bounded TypeScript
candidate verification, not adoption, publication, merge or native conformance.

## Evidence

- [Acceptance metrics](emission-reuse-results.json), [source/control verification](emission-reuse-verification.json).
- [Reuse fixtures](emission-reuse.test.mjs), [existing contract fixtures](structural-path.test.mjs),
  [package audit](emission-reuse-package-audit.results.json), [Core checks](cts.results.json).
- [Data graph accounting](no-reference-graphs.txt), [CPU summary](no-reference-candidate-cpu-summary.json),
  [diagnostic runner](no-reference-heap-diagnostic.mjs); snapshots/profiles remain
  locally under ignored `.results/`.
- [Serial runner](run-emission-reuse-matrix.mjs), [unchanged measurement](pipeline-timing.mjs),
  [acceptance evaluator](summarize-emission-reuse.mjs).
- Fresh logs/raw cost data use `emission-reuse-*`,
  `candidate-b-path-only-emission-reuse-*` and `path-only-emission-reuse-pipeline-*`.
