# Migrating to AEON 0.15.0

This is an implementation/package release, not an AEON language version change.
The breaking changes below affect the TypeScript SDK's SANSA namespace adapter
(`@altopelago/aeon-sdk/sansa`). They do not change AEON source syntax or require
rewriting ordinary JSON-profile loader calls.

## Node heads and content addresses

The adapter now exposes the complete portable AES node topology. For:

```aeon
value = <tag("hello")>
```

`$.value` is the node-valued binding, `$.value[0]` is its `NodeHead`, and
`$.value[0][0]` is the first content value. Previously the adapter exposed that
content directly at `$.value[0]`. Update adapter-facing queries, stored binding
addresses, and child/parent traversal assumptions accordingly. Nested nodes
and node-valued attributes follow the same rule.

Binding/key metadata remains on `$.value`; tag/head metadata belongs to
`$.value[0]`. Do not merge their attributes or identities when traversing.

## Representation names

Exposed `representationKind` values now use portable names, for example
`StringLiteral`, `ObjectNode`, `ListNode`, and `NodeLiteral` instead of `string`,
`object`, `list`, and `node`. Update direct string comparisons and serialized
metadata consumers. Existing short representation-filter aliases remain
supported by the adapter; canonical filters such as `%NodeHead` are also
available. Semantic datatype labels are separate and are not renamed.

## Reference payloads

Clone and pointer values now expose their translated absolute portable target
as a string in `value.path`, rather than the previous native path-segment array.
Their `canonical` field includes the reference marker and translated target.
For example, a source reference to the first node content becomes
`~$.value[0][0]` in the payload-scoped namespace. Full-document scope adds the
`$.body` or `$.header` plane. These are namespace projections; the source
reference syntax is unchanged.

## New native APIs and existing boundaries

The Rust document facade and Python `altopelago.aeon.pytonic` views add
metadata-preserving navigation and shared SANSA Query. Experimental mutation
plans are immutable inspection objects: target validation does not authorize
application or establish schema validity, and apply remains unexposed.

SANSA 0.14.2 accepts Core's reduced-date datetime/WTC forms, authored fractional
precision, and second 60. Clock-bearing reduced-date completion sets still
conservatively compare as `incomparable`; acceptance does not imply instant
resolution or GP/schema approval. Symbols remain distinct from strings.

The existing strict/loose JSON materialization boundary is unchanged. Use
Pytonic value views when exact AEON scalar families and metadata are needed.
