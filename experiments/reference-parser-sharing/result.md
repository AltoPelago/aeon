# Current release-preparation checkpoint

[Local preparation report](release-prep-result.md): adopted narrow TypeScript direction; all unchanged gates pass. Registry and hosted CI gates remain open, and native ports are next. The quoted canonical heap result has almost no margin.

The checkpoint below is the retained pre-release-preparation source.

# Narrow structural-path candidate — current verification

**All applicable narrow TypeScript compatibility and cost gates pass** for the
[operation-local emission reuse source](emission-reuse-result.md), 19 October 2026.
Adoption, release and native-port decisions remain separate.

Reference-free canonical retained heap is **0.865344× /0.963483×**, below the
unchanged **1.20×** ceiling. All latency gates pass at **1.15×**; worst parser
1.100622×, pipeline 1.012740×. Worst pipeline heap is 1.145985×.

Canonical ordering reuses the already validated authored emission. Authored and
rendered Core validation, ordering/target constraints, result ownership, SANSA
index fixes and all previous compatibility expectations remain unchanged.

- [Current report and limitations](emission-reuse-result.md)
- [Exact current metrics](emission-reuse-results.json)
- [Current source/control verification](emission-reuse-verification.json)
- [Prior failed identifier-source report](identifier-result.md),
  [metrics](identifier-results.json); earlier failed matrices/archives remain retained.

The broader experiment and its original identity/profile/replay tests remain
unchanged and are not counted as narrow functionality or narrow cost passes.
