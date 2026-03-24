# AEON 52-Cards Spec Alignment Review

Status: open  
Scope: align the `aeon-52-cards` harness with the official AEON v1 surface in `specs/04-official/v1/`.

## Current Assessment

The harness is already useful as a stress and bug-finding tool. It is not yet a spec-aligned conformance stress suite.

The main gap is scope mixing:
- some checks are labeled as language/core invariants but currently include downstream SDK/finalize behavior;
- some official v1 requirements are not modeled at all;
- some implementation-permissive behaviors are currently treated as normative expected-pass cases.

## Findings

### 1. Core parsing is mixed with finalize behavior

Current `parsing-stability` uses `readAeon()` and fails when either:
- `compile.errors.length > 0`, or
- `finalized.meta.errors.length > 0`

Implication:
- the harness can report a language failure even when Core succeeded and the failure happened in downstream projection/finalization.

Affected file:
- `src/evaluation/invariants.js`

Required change:
- split this into separate invariants:
  - `core-parse-stability`
  - `sdk-finalize-stability` (optional, non-core)

### 2. Canonical invariant overclaims and masks coverage gaps

Current `canonicalization-consistency` only proves:
- canonicalization is idempotent on the cases it can process

It does not prove:
- equivalent syntactic variants canonicalize to the same output

It also silently skips valid documents when canonicalization errors, for example multi-separator forms.

Affected file:
- `src/evaluation/invariants.js`

Required change:
- rename current invariant to `canonical-idempotency`, or
- expand it into two invariants:
  - `canonical-idempotency`
  - `canonical-equivalence`
- treat unsupported valid v1 canonical cases as uncovered or failing, not silent success

### 3. Official v1 requirements are missing from the feature model

Not currently modeled:
- root-qualified references: `~$.a`
- mixed quoted traversal: `~a.["b.c"]`
- quoted attribute selectors: `~a@["x.y"]`
- local ZRUT convention: `...&Local`
- invalid numeric underscore forms
- malformed quoted-key escapes
- host comments: `//!`
- reserved line channels: `//{`, `//[`, `//(`
- invalid separator chars: `,`, `;`, `[`, `]`
- explicit datatype mismatch in transport mode, for example `state:switch = true`

Affected files:
- `src/model/features.js`
- `src/generators/boundary.js`

Required change:
- add missing positive and negative features
- add boundary cases where the requirement is floor-based rather than syntax-based

### 4. Boundary lane does not hit published conformance floors

Current boundary coverage includes:
- nesting depth: `64`
- key length: `1024`

But it does not exercise official floors for:
- list/tuple element count: `65,536`
- string literal length: `1,048,576`
- numeric lexical length: `1,024`
- path length: `8,192`
- structured comment payload length: `1,048,576`

Affected file:
- `src/generators/boundary.js`

Required change:
- either upgrade to real floor tests, or
- explicitly relabel current boundary lane as lightweight smoke boundaries

### 5. Some expected-pass cases are implementation-behavior, not clearly locked normative v1 syntax

Current examples marked `expectPass: true` include:
- trailing attribute separator: `@{x:number=1,}`
- trailing list comma: `[1, 2, 3,]`

The attribute case is currently documented as accepted parser behavior.
The list trailing-comma case is not clearly locked as a normative v1 requirement.

Affected file:
- `src/model/features.js`

Required change:
- move such cases into an implementation-behavior class, or
- explicitly lock them in the official spec before treating them as normative

### 6. Annotation non-influence check is too weak

Current `annotation-isolation` compares only event-path strings.

This can miss changes to:
- values
- datatypes
- ordering
- other emitted event structure

Affected file:
- `src/evaluation/invariants.js`

Required change:
- compare a stronger projection of the event stream, not just path strings

## Implementation Plan

### Phase 1: Scope correction

1. Update README wording so the harness is described as:
   - stress harness first
   - partial spec-alignment work in progress
2. Add a coverage ledger that maps official v1 requirements to:
   - modeled
   - partially modeled
   - uncovered

### Phase 2: Invariant split

1. Replace `parsing-stability` with:
   - `core-parse-stability`
   - optional `sdk-finalize-stability`
2. Replace or rename `canonicalization-consistency`:
   - `canonical-idempotency`
   - future `canonical-equivalence`
3. Strengthen `annotation-isolation` into a real non-influence check

### Phase 3: Feature-model completion

Add missing features for:
- mixed addressing
- quoted attribute selectors
- root-qualified references
- local ZRUT
- numeric underscore negatives
- quoted-key escape negatives
- host/reserved line channels
- separator invalid-char negatives
- transport explicit datatype mismatch negatives

### Phase 4: Boundary-floor alignment

Add explicit floor cases for:
- long strings
- long numeric lexemes
- long paths
- large containers
- large structured comment payloads

### Phase 5: Reporting

Add summary sections for:
- official requirements covered
- official requirements uncovered
- implementation-behavior-only cases

## Recommended Positioning

Until Phases 2-4 are complete, the harness should be described as:
- a systematic AEON stress harness
- useful for regression and bug finding
- partially aligned to AEON v1
- not yet a complete v1 conformance stress suite
