# AEON Phase Fuzz

Deterministic hostile-input fuzz lanes for `@aeon/lexer` and `@aeon/parser`.

## Commands

```bash
pnpm --filter @aeon/phase-fuzz test
pnpm --filter @aeon/phase-fuzz fuzz:lexer
pnpm --filter @aeon/phase-fuzz fuzz:parser
pnpm --filter @aeon/phase-fuzz fuzz:incremental
pnpm --filter @aeon/phase-fuzz fuzz:incremental -- --group nodes --report-top 10
pnpm --filter @aeon/phase-fuzz fuzz:nightly
pnpm --filter @aeon/phase-fuzz fuzz:promote -- --lane lexer --id lexer-example --note "short note" --source-file /tmp/case.aeon
pnpm --filter @aeon/phase-fuzz fuzz:promote -- --lane incremental --group interactions --id inc-example --source-file /tmp/case.aeon
```

## Profiles

- `ci`
  - small bounded run for regular verification
- `nightly`
  - larger bounded run for scheduled hardening
  - rotates across fixed deterministic seeds by default

## Seed Control

- `--seed <n>`
  - run a single reproducible seed
- `--seeds <a,b,c>`
  - run a fixed explicit seed set
- nightly default seeds
  - `1337,7331,9001,424242`

## Regression Corpus

- named regression cases are replayed on every run before generated cases
- new failures should be promoted into `src/regressions.ts` with a stable id and short note
- seed replay remains useful, but regressions become the permanent memory of discovered bugs

### Promotion Helper

- `fuzz:promote` prints a ready-to-paste regression entry
- required:
  - `--lane lexer|parser|incremental`
  - `--id <stable-id>`
- lexer/parser also require:
  - `--note <short-note>`
- incremental also requires:
  - `--group <attributes|nodes|separators|numbers|interactions>`
- source input:
  - `--source-file <path>`
  - or `--source <inline-text>`
- optional incremental metadata:
  - `--expected valid|invalid|either`
  - `--tags comma,separated,list`
- output:
  - target array name
  - formatted object entry for `src/regressions.ts`

## Invariants

### Lexer
- no crashes
- deterministic token and error signatures
- sane spans
- EOF token integrity

### Parser
- no crashes
- deterministic parse results
- sane parse diagnostics
- valid AST shape and span nesting

### Incremental
- parser-focused corpus-guided structural growth
- seed groups for attributes, nodes, separators, numbers, and interactions
- weighted incremental mutations around structural hotspots
- rewards for new lexer/parser signatures, diagnostics, and syntax-group interactions
- extra progress credit for longer valid prefixes, deeper token progress, richer node shapes, and deeper ASTs
- compact top-case reporting prints the strongest retained cases with score reasons and source previews
