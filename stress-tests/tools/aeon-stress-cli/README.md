# AEON Stress CLI

Node console stress harness for targeted runtime and pipeline checks.

Lanes:
- `stress`
  - strict-mode datatype enforcement
  - built-in vs custom datatype policy (`reserved_only` vs `allow_custom`)
  - switch literals
  - hex/radix/encoding/separator literals
  - date/datetime/ZRUT
  - tuples
  - separator depth gating (`maxSeparatorDepth`)
  - attribute ordering and typed attributes
  - annotation emission on/off
- `stress-advanced`
  - reference/finalize boundary behavior
  - missing-reference fail-closed behavior
  - attribute reference depth policy
  - canonical determinism
  - node introducer canonical determinism
  - invalid non-introducer node syntax rejection
  - recovery vs fail-closed behavior
  - deep nesting and larger document smoke tests
  - separator literal escape stress
  - reference path explosion
  - wide clone/pointer fanout
  - comment channel density
  - wide duplicate-key collisions
  - projection path stress
  - canonical quoted-key sort pressure
  - trimtick indentation stress
  - alternating container nesting
  - input-size guard checks
  - algorithmic DoS guards for recursion, huge integers, nested generic depth, and deep no-crash generic canaries
- `phase-timing`
  - end-to-end phase timings for representative workloads
  - annotation on/off comparisons
  - generated CSV output

## Install

```bash
cd stress-tests/tools/aeon-stress-cli
npm i --cache .npm-cache --no-audit
```

## Run

```bash
npm run stress
npm run stress-advanced
npm run phase-timing
```

Current baseline:
- `stress`: `21/21` pass
- `stress-advanced`: `29/29` pass
- `phase-timing`: `8/8` pass

Notable current policy assumptions:
- strict mode defaults to `datatypePolicy: reserved_only`
- custom datatype pass cases explicitly opt into `allow_custom`
- separator chars `,`, `;`, `[` and `]` are invalid
- nested object smoke cases use `:object`, not `:node`

Findings docs:
- `specs/01-proposals/r7/strict-literal-custom-type-findings.md`
- `specs/01-proposals/r7/advanced-stress-findings.md`
