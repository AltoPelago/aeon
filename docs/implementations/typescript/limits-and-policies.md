# Limits and Policies

Informative status: implementation-defined behavior in the TypeScript stack.

This page describes processor controls exposed by the current implementation. These are not part of AEON document syntax.

## Aeonic limits file

The Core package exports `loadAeonicLimits(...)` and `aeonCompileLimits(...)`
for the closed `altopelago.aeonic-limits.v1` contract. The loader applies the
fixed bootstrap limits before accepting the file. `aeon inspect` accepts the
same file through `--limits-file <path>`; an explicit CLI limit overrides the
loaded value.

The published policy and contract live in the AES repository:

- `policies/altopelago.aeonic-limits.v1.aeon`
- `notes/altopelago-aeonic-limits-v1.md`

## Current controls

Core exposes independent counters for attribute depth, clarifier values,
generic depth, generic arguments, total datatype components, logical value
nesting, canonical/reference paths, decoded strings and keys, collection
lengths, numeric lexemes, structured comments, input bytes, and projected
events.

`maxClarifierValues` is the canonical name for the former
`maxSeparatorDepth`. `maxValueNestingDepth` is the canonical name for the
former `maxNestingDepth`. The old names remain compatibility aliases and do
not create additional limits.

Other processor controls include:

- `datatypePolicy`: `reserved_only` or `allow_custom`;
- `recovery`, default `false`;
- `emitAnnotations`, default `true`.

## Meaning

- structural and format counters are defensive processing limits;
- `datatypePolicy` governs strict-mode acceptance of reserved-only vs custom datatypes.
- `maxInputBytes` measures the exact UTF-8 input before normalization.
- `recovery` allows partial processing for tooling workflows.
- `emitAnnotations` controls whether structured comment/annotation records are emitted alongside events.

## Spec boundary

The AEON v1 spec defines language behavior and conformance expectations. These controls define how the TypeScript implementation applies or constrains that behavior at runtime.

Examples:

- `datatypePolicy` is grounded in spec-level strict-mode concepts, but the API knob itself is implementation-defined.
- depth limits are processor controls, even when they support compliance and security goals.
- `recovery` is a tooling/runtime behavior, not a language feature.

## Recommended interpretation

- Treat `specs/` as authoritative for AEON language meaning.
- Treat these controls as processor configuration for this implementation.
- Prefer fail-closed defaults in production and boundary-facing systems.
