# AEON Phase Fuzz

Deterministic hostile-input fuzz lanes for `@altopelago/aeon-lexer` and `@altopelago/aeon-parser`.

## Commands

```bash
pnpm --filter @altopelago/aeon-phase-fuzz test
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:lexer
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:parser
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:parser:duplicates
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:parser:duplicate-attributes
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:nightly
pnpm --filter @altopelago/aeon-phase-fuzz fuzz:promote -- --lane lexer --id lexer-example --note "short note" --source-file /tmp/case.aeon
node ./dist/index.js --lane parser-duplicates --profile ci --seed 1337 --verbose
node ./dist/index.js --lane parser-duplicates --profile ci --seed 1337 --dup-steps 50,40,10 --verbose
node ./dist/index.js --lane parser-duplicate-attributes --profile ci --seed 1337 --verbose
node ./dist/index.js --lane parser-duplicate-attributes --profile ci --seed 1337 --focused-family attribute --verbose
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

## Verbose Output

- `--verbose`
  - print each executed case id and source in execution order
  - useful for seeing fixed regressions and generated `generated-N` cases during a run
  - verbose lines also include a family label such as `pollution-generated` or `focused-attribute`

## Duplicate Mutation Weights

- `--dup-steps <one,two,three>`
  - controls parser-duplicates mutation depth distribution in percentages
  - values must be non-negative and sum to `100`
  - default is `50,40,10`

  ## Duplicate Lanes

  - `parser-duplicates`
    - pollution-oriented lane with chained mutations and occasional lexical jitter
  - `parser-duplicate-attributes`
    - focused lane with legal bindings plus one targeted mutation family at a time
    - generated focused families currently include:
      - `focused-attribute`
      - `focused-type`
      - `focused-container`
      - `focused-scalar`

  ### Focused Family Details

  Each focused family generates semantically valid AEON bindings with exactly one targeted duplication, enabling deterministic failure attribution:

  - `focused-attribute`: Tests duplicate attribute block syntax (e.g., `a @{ a = 2 } @{ a = 2 } = 2`)
  - `focused-type`: Tests duplicate type annotations with valid type-value pairs (6 types: string, number, boolean, date, time, datetime)
  - `focused-container`: Tests duplicate separators/delimiters in lists, tuples, and objects (e.g., `a = [,, 1, 2]`)
  - `focused-scalar`: Tests duplicate scalar values (e.g., `a = "hello" "hello"`)

  ## Focused Family Selector

  - `--focused-family <attribute|type|container|scalar>`
    - optional filter for `parser-duplicate-attributes`
    - when provided, generated focused cases come from only that family

## Regression Corpus

- named regression cases are replayed on every run before generated cases
- new failures should be promoted into `src/regressions.ts` with a stable id and short note
- seed replay remains useful, but regressions become the permanent memory of discovered bugs

### Promotion Helper

- `fuzz:promote` prints a ready-to-paste regression entry
- required:
  - `--lane lexer|parser`
  - `--id <stable-id>`
  - `--note <short-note>`
- source input:
  - `--source-file <path>`
  - or `--source <inline-text>`
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

### Parser Duplicate Rejections
- no crashes while probing malformed duplicate grammar
- deterministic rejection diagnostics
- duplicated assignment, attribute, value, and datatype structures must emit at least one lexer or parser error
- repeated reference sigils, container separators, and container delimiters are also probed as fail-closed cases
