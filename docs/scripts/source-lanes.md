# CTS Source Lanes

Primary script:

- `scripts/cts-source-lane-runner.mjs`

## Purpose

Run CTS source lanes against a CLI SUT (`inspect --json` envelope) with normalization so comparisons remain stable across implementations.

## Command contract

```bash
node ./scripts/cts-source-lane-runner.mjs \
  --sut <path-to-cli-or-js-entrypoint> \
  --cts <path-to-cts-manifest> \
  --lane <core|aes|canonical|finalize-json|finalize-map|inspect-json>
```

Required flags:

- `--sut`: executable binary or JS entrypoint.
- `--cts`: CTS manifest path.
- `--lane`: lane selector.

## Lane intent

- `core`: AEON Core structural/source checks.
- `aes`: AEON Semantic (AES) source-event checks.
- `canonical`: canonical formatting/source behavior checks.
- `inspect-json`: JSON envelope validation for `inspect`.
- `finalize-json`: finalize JSON projection checks.
- `finalize-map`: finalize map projection checks.

## Normalization behavior

The runner normalizes path and diagnostic representations so lane expectations are comparable:

- identifier path shorthand normalization (for example quoted-vs-bare segments)
- numeric index normalization
- diagnostic shape normalization (`code`, `path`, `phase`, `span`)

This is an implementation-conformance aid, not language authority.

## Failure semantics

- exit `0`: all cases passed
- non-zero: one or more lane failures, malformed SUT output, or bad invocation
- detailed mismatch lines are printed per failing case

## Recommended usage

Use through the repo-path wrapper when possible:

```bash
node ./scripts/run-with-repo-paths.mjs \
  node ./scripts/cts-source-lane-runner.mjs \
  --sut ./implementations/typescript/packages/cli/dist/main.js \
  --cts ./cts/core/v1/core-cts.v1.json \
  --lane core
```
