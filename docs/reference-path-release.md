# Structural-path release preparation

Local candidates: SANSA 0.15.0-rc.1 and AEON TypeScript 0.17.0-rc.1. No registry publication has occurred. The supported SANSA parsing cursor, AEON structural lowering and permanent fixtures are the adopted scope; native reference ports and SANSA identity selectors follow separately.

## Release order

1. Review/merge SANSA's supported parsing API and its normal tests/CTS/version metadata. Publish the RC through its release workflow using the `next` dist-tag.
2. Download the exact registry tarball, verify its version/exports/content/integrity against the reviewed candidate, and regenerate or confirm AEON's lockfile using that actual registry artifact. The current lock integrity is from the exact local candidate tarball exercised by clean consumers, not a claim of registry availability. Stop on a mismatch; never remove integrity or weaken frozen-lock checks.
3. Run AEON's frozen registry install, build, normal tests, released relevant CTS, runtime/installed-package checks and final unchanged-budget matrix. Publish the AEON RC using `next` only after reviewed registry dependency verification.
4. Stable publication requires its own approved version/tag and the same artifact checks. Node 20/22/24 and local tarball success do not prove Linux CI or a registry install of an unpublished RC.

`node scripts/test-installed-reference-paths.mjs --sansa /path/to/sansa` packs actual artifacts, installs them in a fresh offline consumer and tests runtime semantics/declarations. Without `--sansa`, CI packs the already installed SANSA dependency after its frozen registry installation. It exercises the local shared JSON vectors under `test-fixtures/` without importing implementation code from the worktree into the consumer. Temporary artifact/consumer directories are retained for review and recorded in the report; use `--report path.json` for a durable record.

Index changes deliberately reject malformed/truncated/rounded legacy forms; see [the contract](reference-paths.md). Existing numeric value syntax and quoted numeric member names remain. Coordinate these rules and fixtures with native ports; do not claim their conformance before running them. No generic engine/session/replay API or identity reference step is included.
