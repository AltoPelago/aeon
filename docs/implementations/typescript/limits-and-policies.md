# Limits and Policies

Informative status: implementation-defined behavior in the TypeScript stack.

This page describes processor controls exposed by the current implementation. These are not part of AEON document syntax.

## Current controls

- `maxAttributeDepth`
  Default: `1`
- `maxSeparatorDepth`
  Default: `1`
- `datatypePolicy`
  Values: `reserved_only`, `allow_custom`
- `maxInputBytes`
  Maximum accepted UTF-8 input size before processing fails closed
- `recovery`
  Default: `false`
- `emitAnnotations`
  Default: `true`

## Meaning

- `maxAttributeDepth` and `maxSeparatorDepth` are defensive processing limits.
- `datatypePolicy` governs strict-mode acceptance of reserved-only vs custom datatypes.
- `maxInputBytes` is an input-boundary DoS defense control.
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
