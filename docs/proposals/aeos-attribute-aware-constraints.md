# AEOS Attribute-Aware Constraints

Status: implemented in TypeScript, Rust, and Python AEOS

Main implementation docs now live in:

- [`docs/implementations/implementation-guideline.md`](../implementations/implementation-guideline.md)
- [`docs/implementations/typescript/api/aeos.md`](../implementations/typescript/api/aeos.md)
- [`implementations/typescript/packages/aeos/README.md`](../../implementations/typescript/packages/aeos/README.md)

## Summary

AEOS should be able to validate attribute entries carried on AES events, not just the event value itself.

Today AEOS can validate:

- whether `$.values[0]` exists
- the value type at `$.values[0]`
- the datatype at `$.values[0]`
- reference and container constraints at `$.values[0]`

It cannot yet validate the contents of:

```aeon
values:list = [@{unit:string = "cm" precision:n = 2}:n = 3]
```

Specifically, it cannot express:

- `unit` must exist
- `unit` must be a string
- `precision` must be an `n`
- extra attribute keys are forbidden

This proposal adds attribute-aware constraints to AEOS while keeping them clearly separate from ordinary value constraints.

## Goals

- Reuse the existing AEOS constraint vocabulary where practical.
- Validate attribute entries without inventing a separate attribute event stream.
- Keep ordinary path-based rule matching intact.
- Preserve fail-closed validation behavior.
- Support anonymous child attributes and ordinary binding attributes equally.

## Non-Goals

- Reinterpreting attributes as ordinary child bindings.
- Allowing AEOS to mutate, normalize, or materialize attribute values.
- Adding attribute-aware finalization semantics.
- Adding arbitrary selector languages beyond the current path model plus annotation keys.

## Current AES Shape

AES events already carry attributes as metadata:

```ts
interface AssignmentEvent {
  path: CanonicalPath;
  key: string;
  value: Value;
  datatype?: string;
  annotations?: ReadonlyMap<string, AttributeEntry>;
}

interface AttributeEntry {
  value: Value;
  datatype?: string;
  annotations?: ReadonlyMap<string, AttributeEntry>;
}
```

This is enough to validate attribute payload contents without changing AES transport immediately.

Note:

- current AES implementation fields may still use the internal name `annotations`
- AEOS schema and user-facing docs should prefer `attributes` to avoid confusion with the comment annotation stream

## Proposed Schema Extension

Extend `ConstraintsV1` with an `attributes` object:

```ts
interface AnnotationConstraintsV1 extends ConstraintsV1 {
  readonly attributes?: Readonly<Record<string, AnnotationConstraintsV1>>;
  readonly closed_attributes?: boolean;
}

interface ConstraintsV1 {
  readonly required?: boolean;
  readonly type?: string;
  readonly reference?: 'allow' | 'forbid' | 'require';
  readonly reference_kind?: 'clone' | 'pointer' | 'either';
  readonly type_is?: 'list' | 'tuple';
  readonly length_exact?: number;
  readonly sign?: 'signed' | 'unsigned';
  readonly min_digits?: number;
  readonly max_digits?: number;
  readonly min_value?: string;
  readonly max_value?: string;
  readonly min_length?: number;
  readonly max_length?: number;
  readonly pattern?: string;
  readonly datatype?: string;
  readonly attributes?: Readonly<Record<string, AnnotationConstraintsV1>>;
  readonly closed_attributes?: boolean;
}
```

Design intent:

- `attributes` defines constraints for named attribute entries.
- `closed_attributes` applies only to the current attribute object, not the whole document.
- `AnnotationConstraintsV1` reuses the same core constraint vocabulary recursively.

## Examples

### Example 1: Require `unit`

```json
{
  "rules": [
    {
      "path": "$.values[0]",
      "constraints": {
        "type": "NumberLiteral",
        "attributes": {
          "unit": {
            "required": true,
            "type": "StringLiteral",
            "datatype": "string"
          }
        }
      }
    }
  ]
}
```

### Example 2: Closed attribute object

```json
{
  "rules": [
    {
      "path": "$.values[0]",
      "constraints": {
        "attributes": {
          "unit": { "required": true, "type": "StringLiteral" },
          "precision": { "type": "NumberLiteral", "datatype": "n" }
        },
        "closed_attributes": true
      }
    }
  ]
}
```

This rejects extra attribute keys on `$.values[0]`.

### Example 3: Nested attributes

If AEON permits nested annotation entries like:

```aeon
a@{meta@{label:string = "x"} = {}} = 1
```

AEOS should be able to express:

```json
{
  "rules": [
    {
      "path": "$.a",
      "constraints": {
        "attributes": {
          "meta": {
            "attributes": {
              "label": {
                "type": "StringLiteral",
                "datatype": "string"
              }
            }
          }
        }
      }
    }
  ]
}
```

## Semantics

For a rule:

```json
{
  "path": "$.values[0]",
  "constraints": {
    "annotations": {
      "unit": { "required": true, "type": "StringLiteral" }
    }
  }
}
```

AEOS should:

1. Find the event at `$.values[0]`.
2. Read its `annotations` map, if any.
3. Evaluate the `unit` entry against the nested constraints.

### Constraint interpretation

- `required`
  The attribute entry must exist.
- `type`
  The attribute entry value must have the expected AEON literal/container kind.
- `datatype`
  The attribute entry must carry the expected datatype annotation.
- `pattern`, `min_length`, `max_length`
  Apply to string-valued attribute entries.
- `sign`, `min_digits`, `max_digits`, `min_value`, `max_value`
  Apply to numeric attribute entries.
- `reference`, `reference_kind`
  Apply if attribute entry values are references.
- `attributes`
  Recurse into nested attribute metadata on the entry.
- `closed_attributes`
  Reject unknown attribute keys at that attribute-object level.

## Diagnostic Model

The initial implementation should reuse existing value diagnostics wherever possible.

Recommended path format for attribute diagnostics:

- `$.values[0].@.unit`
- `$.page[0].@.unit`
- `$.value.@.meta.@.label`

Recommended initial behavior:

- Missing attribute entry:
  `missing_required_field`
- Wrong attribute value kind:
  `type_mismatch`
- Wrong attribute datatype:
  existing datatype mismatch diagnostic where applicable
- Unknown attribute entry under `closed_attributes: true`:
  new diagnostic code, recommended: `unexpected_attribute_entry`

This keeps diagnostics locally understandable without pretending attribute entries are ordinary member paths.

## Wildcards and Matching

Ordinary path matching remains unchanged:

```json
{
  "path": "$.items[*]",
  "constraints": {
    "annotations": {
      "unit": { "type": "StringLiteral" }
    }
  }
}
```

This means:

- wildcard matching selects the event(s)
- annotation constraints are evaluated after the event match

No separate wildcard syntax is needed inside `attributes`.

## Closed-World Interaction

Schema `world: "closed"` continues to govern AES event paths.

Attribute closure should be explicit and local through `closed_attributes: true`.

This means:

- document/world closure does not automatically reject unknown attribute entries
- attribute entry closure is opt-in per constraint object through `closed_attributes`

That keeps attribute policy from surprising existing schemas.

## Why `attributes` inside `constraints`

This is preferable to a separate top-level rule family because:

- attribute validation remains attached to the event it qualifies
- wildcard and ordinary path selection can be reused
- implementations do not need a second rule-dispatch surface
- users can reason about one path rule at a time

## Minimal Implementation Plan

### Phase 1

- Extend schema types with:
  - `attributes`
  - `closed_attributes`
- Extend schema-key validation.
- Add recursive attribute constraint evaluator in TypeScript AEOS.
- Add focused tests for:
  - required attribute entry
  - attribute type mismatch
  - attribute datatype match/mismatch
  - closed attribute object with extra entry
  - nested attribute recursion

### Phase 2

- Port the same behavior to Rust AEOS.
- Port the same behavior to Python AEOS.
- Add CTS payload coverage.

### Phase 3

- Datatype-wide rules should also apply to attribute entries automatically when those entries carry matching datatypes, with explicit `attributes` constraints taking precedence.

## Open Questions

1. Should attribute diagnostics always use `@` path notation, or should they remain attached to the parent path with richer messages?
2. Should attribute diagnostics always use `@` path notation, or should they remain attached to the parent path with richer messages?

## Recommendation

Proceed with:

- `constraints.attributes`
- local `closed_attributes: true` for attribute entry closure
- recursive reuse of `ConstraintsV1`
- automatic `datatype_rules` inheritance for datatyped attribute entries, with explicit attribute constraints overriding inherited datatype defaults
- `@`-qualified diagnostic paths

This is the smallest addition that makes anonymous child attributes and ordinary binding attributes meaningfully schema-validatable without distorting the current AEOS model.
