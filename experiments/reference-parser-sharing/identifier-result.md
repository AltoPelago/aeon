# Narrow SANSA structural-path candidate — 19 October 2026

**FAIL: remaining cost gates are open. Adoption remains undecided.**

## Implementation and scope

Separate ordinary AEON/SANSA worktrees at `worktrees/{aeon,sansa}/reference-path-only`,
on `spike/reference-path-only`, preserve the original broader experiment intact.
Baselines remain AEON `8cd3900e2941658d677d161f3c2bb02007c3a652` and
SANSA `4f05ea935a684ada91a8cd6f8f75367730c1430f`.

SANSA owns shared dot/position step grammar and original-spelling index validation.
AEON's token cursor retains quoted-name/trivia decoding, host diagnostics/spans,
legacy effective-document-root spellings and direct structural AST projection.
Default positional indexes are unsigned decimal 0..999999, without leading zeroes.
Bounds/spelling are checked before numeric conversion; no truncation or rounding.
Standalone SANSA retains its existing explicit larger-bound support and nonportable
warning. No new AEON bound option is introduced. Quoted numeric names and ordinary
AEON numeric literals preserve baseline semantics.

The narrower candidate has no reference-engine option, singleton contract registry,
program handles, sessions, authored selection AST, normalizer or replay codec.
Core retains baseline structural validation, reference ordering and evaluation;
canonicalization retains authored/emitted parsing and reference validation.
Caller events with any defined `selection` payload fail reference validation even
under recovery, and fail portable projection instead of using a cached path.
Existing identity metadata/duplicate checks remain valid. Identity reference steps,
recursive selectors, contextual roots, local-space escape, qualifiers and space
endpoints remain excluded. SANSA exactness is unchanged. Shared grammar does not
promise automatic admission of future non-exact selectors; future exact steps need
engine-owned structural lowering and compatible host namespace support.

Independent parser lazy scratch allocation, cleanup, compact retained arrays and
scalar/dispatch improvements are retained. Canonical rendering shares a stateless
frozen formatter and a private identifier regex without global/sticky state. The follow-up joins the terminal newline in one operation,
removing an extra string concatenation while preserving empty/nonempty bytes under
both ordering contracts. It adds no target/session/output cache.

Runtime-source ownership versus the pinned baselines changes **6 AEON /3 SANSA
files**, compared with **15 /12** for the preserved broader experiment. This count
includes untracked new runtime modules and excludes tests/build outputs/manifests;
[complete line/file accounting](runtime-accounting.json) is separate from performance.
The token adapter/root spelling/diagnostic work remains; sharing is not zero-cost.

## Correctness and reviewed compatibility exception

- AEON `pnpm test:unit:ci`: **2166 pass, 5 existing skips (2171 total), zero failures**.
- **45 narrow contract tests**: approved index cases/host spans; rejected selectors;
  literal/member separation; source/target limits; missing/forward/self references;
  canonical idempotence, structural/portable targets and evaluated values; forged
  selection payload rejection; public declarations; output-byte parity; identity
  metadata compatibility.
- SANSA **258 pass/75 existing skips**; CTS **85 value, 32 address, 37 Resolve,
  226 Query pass; 13 Query skips**.
- Core **24 baseline/acceptance parity cases**, with **four inherited exact
  diagnostic-list gaps**. This is not a full Core CTS certification.
- Every parser repetition preserves **396 corpus cases: 356 unchanged and exactly
  40 approved numeric deltas**, plus **68 whole-document comparisons with zero
  differences**. The five formerly accepted index spellings are `[1000000]`,
  `[1_000]`, `[1.5]`, `[-0]`, `[9007199254740992]`, in both wrappers and four host
  positions. `[01]` already fails baseline lexing and its eight cases are unchanged.
  All thirteen default-bound expectations also have explicit narrow fixtures.

The initial draft adjudicator incorrectly anticipated 48 deltas and null documents
on parser errors. Baseline lexer/recovery evidence corrected that draft to the
exact 40 names and native diagnostic rejection while preserving subsequent-binding
recovery. Initial draft artifacts remain retained. No source expectation was
changed to admit malformed indexes or unrelated drift. An initial contract test
incorrectly accepted ordinary hex values and compared rendered source spans as
semantic values; it now requires baseline literal parity and compares semantic
values without spans, alongside explicit unchanged path/portable-target assertions.
An initial SANSA invocation lacked `AEONITE_CTS_ROOT`; final logs use the existing
normative checkout. All initial logs remain available.

## Cost verification

| Narrow artifact | Worst latency | Worst retained-result heap |
| --- | ---: | ---: |
| Parser, four runs | 1.085009× | 1.000388× |
| Core/canonical legacy pipeline, two runs | 1.065701× | 1.214975× |

Current short-reference canonical heap ratios: 1.189165× / 1.191682×.
The ceilings remain **1.15× latency /1.20× retained-result heap**, without rounding
or waivers. Parser workload/corpus/measurement files are byte-identical to the
original protocol. Three standard runs and one reversed run retain the same scale,
1000 warmups, 11 alternating batches and 1000 retained parser results. Pipeline
retains original sources, 100 warmups, 11 rotating batches, adaptive calibration
and 200 retained results in isolated forced-GC processes. Lex+parse timings remain
reported diagnostics under the original gate definition. These measurements do not
measure allocation rate or peak/service memory.

The third pipeline variant is explicitly the retained broader profile control;
its metrics are reported separately and do not certify narrow profile support or
re-certify the broader artifact. Original identity-alias workloads cannot execute
against a contract that excludes identity expressions. Their unchanged tests,
workloads, budgets and accepted source-specific evidence remain in the broader
worktree; they are not silently skipped or counted as a narrow pass. The previous
67 positive semantic-profile/session/replay checks are preserved there, rather
than deleted and relabeled as this candidate's 45 contract tests.

The first narrow matrix **failed** short-reference canonical retained heap:
1.2064038105318868× >1.20× in repetition 2 (repetition 1 was 1.1994966776308529×).
All other narrow gates passed. Its complete results, hashes, runtime archive and
raw corpus differences remain in `initial-failed-results.json`, `results.json`,
`initial-failed-runtime.tar.gz`, `source-before.json`, `source-after.json` and the
`candidate-b-path-only-*` / `path-only-pipeline-*` series. The single-join follow-up also failed one short canonical heap measurement:
1.2023327464788733× >1.20× in repetition 1. Its full `flat-results.json`,
`flat-source-*` hashes, raw matrix and `flat-failed-runtime.tar.gz` remain retained.
The current regex-hoist matrix passes compatibility, parser latency/heap and
pipeline latency, and short-reference canonical heap passes both repetitions.
It still **fails** reference-free canonical heap in repetition 2:
**1.2149751389295116× >1.20×**. The broader profile control in that case is
1.2247733255337818×; it is separately scoped diagnostic evidence, not a narrow
feature and not a new broader cost certificate. No failure is waived, classified
as noise or hidden by a favorable subset. NARROW-08 remains open before adoption.

Exact SANSA source variants are preserved in `initial-failed-sansa.tar.gz` and
`flat-failed-sansa.tar.gz`; both failed AEON archives match all their source/build
hashes. The final bounded change hoists the two identical member-name regex tests
in reference formatting into one private stateless regex, avoiding per-segment
regex allocations. Independent public result/error-array ownership remains
unchanged. Each changed-source follow-up reruns the complete narrow matrix, not a
favorable subset. These trials do not establish a VM-level heap cause.

## API, packaging and port/release prerequisites

Eight offline `npm pack --dry-run --ignore-scripts` audits include declared
exports/imports; the private SANSA dependency matches all **four** source files.
Root parser/Core/canonical APIs have baseline structural shapes; the SANSA cursor
subpath is an experimental parser-sharing seam. No stable API was withdrawn:
the two artifacts are unadopted experiments. The private patched SANSA package
still carries the old dependency version, so this is **not** released-package
installation proof. Coordinated dependency/version release, clean installed
packages, supported Node/browser runtimes and native-port fixtures remain release
prerequisites. No native Python/PHP/Go/Rust implementation or conformance claim is
made; the narrower porting requirement is shared structural grammar/index policy
and existing target/order semantics, without profile/session/replay machinery.

Before/after runtime source/build hashes match (1152 recorded files across
candidate, baseline and broader controls). All **422** previously accepted broader
source/build hashes, **19** original protocol files and **100** baseline package
files match their pinned manifests. Primary repositories remain untouched.
The roadmap checklist records completed implementation/measurement separately from
failed cost acceptance and adoption.
No merge, publication or syntax adoption is implied. The narrower candidate is
reviewable; its performance gate is not cleared.

## Evidence and reproduction

- [Current acceptance metrics](identifier-results.json), [initial failed matrix](initial-failed-results.json),
  [source/control verification](verification.json), [original-control checks](control-verification.json).
- [Contract fixtures](structural-path.test.mjs), [approved deltas](approved-deltas.json),
  [Core fixture results](cts.results.json), [package audit](package-audit.results.json).
- [Matrix runner](run-identifier-matrix.mjs), [unchanged parser measurement](compare.mjs),
  [explicit-control pipeline measurement](pipeline-timing.mjs), [evaluator](summarize-identifier.mjs).
- Final build/regression/contract/matrix logs use the `identifier-*` prefix; SANSA
  tests/CTS use `flat-sansa-*` (SANSA source is unchanged by the regex hoist). Raw
  final cost series use `candidate-b-path-only-identifier-*` /
  `path-only-identifier-pipeline-*`.
- Run builds/tests/measurements **serially**. Use the private dependency copier
  before building. Set `AEONITE_CTS_ROOT` to the existing normative CTS tree for
  SANSA tests. No dependency installation or primary-checkout mutation is required.

The copied original parser result `method` metadata describes historical anomaly
preservation; this report and the explicit raw differences document the authorized
numeric bug-fix exception. Measurement logic remains unchanged.
