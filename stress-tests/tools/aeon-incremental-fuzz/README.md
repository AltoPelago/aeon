# AEON Incremental Fuzz Wrapper

Stress-surface entrypoint for the TypeScript `incremental-fuzz` lane.

This tool lives under `stress-tests/tools/` so it is discoverable alongside the
other implementation hardening harnesses, but it delegates to the canonical
engine in `implementations/typescript/tools/phase-fuzz`.

## Usage

```bash
cd stress-tests/tools/aeon-incremental-fuzz
npm run incremental
npm run incremental:interactions
npm run incremental:oracle
npm run incremental:oracle-only
npm run incremental:review
npm run incremental:valid
npm run incremental:json
npm run minimize -- --group interactions --source 'a = <x@{class = "hero"}(1, [2, 3)>'
```

Pass through additional flags to the underlying lane:

```bash
cd stress-tests/tools/aeon-incremental-fuzz
node ./run-incremental-fuzz.js --group nodes --budget 80 --report-top 5
node ./run-incremental-fuzz.js --group interactions --oracle-seeds 12 --report-top 5
node ./run-incremental-fuzz.js --group interactions --oracle-only --oracle-seeds 24 --report-top 5
node ./run-incremental-fuzz.js --group interactions --oracle-only --oracle-seeds 24 --report-new-only --report-top 10
node ./run-incremental-fuzz.js --group interactions --oracle-only --oracle-seeds 24 --report-valid-only --report-top 10
node ./run-incremental-fuzz.js --group interactions --report-file /tmp/incremental-fuzz-report.json
node ./run-minimize.js --group numbers --source 'a = 1..2'
```

## Notes

- the wrapper rebuilds `implementations/typescript/tools/phase-fuzz` before each run
- the actual corpus, scoring, reporting, and promotion logic remain in the TypeScript `phase-fuzz` tool
- oracle-guided valid seed generation can be enabled or tuned with `--oracle-seeds <n>`
- `--oracle-only` is useful when you want to evaluate oracle-guided generation without the curated corpus dominating the run
- `--report-new-only` narrows the output to oracle-derived failing candidates that look new enough to review for promotion
- `--report-valid-only` shows only accepted oracle seed inputs, which is the safest list to try in the playground
- the standalone minimizer is also delegated to the TypeScript `phase-fuzz` tool
- use `node ../../../implementations/typescript/tools/phase-fuzz/dist/promote.js ...` or the `phase-fuzz` package directly to promote retained cases
