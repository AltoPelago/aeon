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
npm run incremental:json
```

Pass through additional flags to the underlying lane:

```bash
cd stress-tests/tools/aeon-incremental-fuzz
node ./run-incremental-fuzz.js --group nodes --budget 80 --report-top 5
node ./run-incremental-fuzz.js --group interactions --report-file /tmp/incremental-fuzz-report.json
```

## Notes

- the wrapper rebuilds `implementations/typescript/tools/phase-fuzz` before each run
- the actual corpus, scoring, reporting, and promotion logic remain in the TypeScript `phase-fuzz` tool
- use `node ../../../implementations/typescript/tools/phase-fuzz/dist/promote.js ...` or the `phase-fuzz` package directly to promote retained cases

