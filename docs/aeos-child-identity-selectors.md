# AEOS child identity selectors (candidate)

AEOS selector rules may select exposed direct children by authored structural
identity. For example:

```json
{
  "resource_policy": {"max_identity_inspections": 10000},
  "rules": [{
    "selector": "$.items.\\first\\.\\label\\",
    "constraints": {"required": true, "type": "StringLiteral"}
  }]
}
```

The corresponding AEON data can be `items=[\first\={name\label\="hello"}]`.
Constraints and diagnostics apply to the actual structural target, for example
`$.items[0].name`; the selector remains non-exact. Reordering a new snapshot
changes that structural result path. Identity text is not occurrence continuity.

Only selector fields gain this capability. Identity expressions remain rejected
in schema path fields; existing unrelated legacy invalid-path behavior is not
broadened or repaired by this extension. AES/event/storage paths and AEON
clone/pointer reference targets remain structural. Quoted marker-shaped property
names remain ordinary exact keys. The scope root is excluded from child matching;
attributes need an explicit attribute-space step. Existing expansion/filter and
descendant operators may compose with child identities; no new recursive/root
matching syntax or document-global ID index is introduced.

Each validation call builds a private identity namespace from its event/attribute
metadata and owns a default 10,000 logical inspection budget. Existing schema
resource policies and consumer resource-policy options accept the new
`max_identity_inspections` non-negative safe integer. Other limits and override
precedence remain unchanged. Distinct identity selectors share the budget;
missing IDs and misses still cost inspections. Results, including failures, are
cached per identity selector for this invocation. Rule expansion and closed-world
allowance reuse the same result without rescanning. A new invocation never reuses
that cache or counter. Actual enumeration/allocation cost remains separate.

Ambiguous/malformed identity metadata, unsupported navigation or exhausted
budgets fail validation with invalid_schema_policy and empty passing guarantees.
A required miss remains missing_required_field. Expansion/result budgets remain
separate. Canonical-path presence, closed-world, constraints and reference-form
checks retain their existing precedence and behavior.

Native high-level schema loaders still require their existing schema_id and
schema_version contract metadata; direct AEOS envelopes retain their existing
schema shape. These requirements are independent of selector admission.

JavaScript/TypeScript supports direct validation plus schema JSON/AEON
normalization, printing and parsing. Rust and pure Python use their existing
schema/envelope APIs; no new schema-source codec is added. Source/portable/Telex
adapters preserve supported event, attribute and NodeHead identities. Inline
fallback elements retain declared identities; implicit parents and missing
metadata acquire none. Illustrative schema projection explicitly omits identity
selectors rather than inventing identity-bearing placeholders.

Rust AEOS adds a dependency on the existing shared SANSA runtime for the identity
selector namespace trait and bounded inspection accounting. Other selectors keep
the existing Core resolver. Core gains no public session/counter API. The typed
Rust EventValue gains optional structural_id metadata (wire spelling structuralId)
for inline fallback elements; serde defaults keep old envelopes valid. Direct
Rust struct-literal callers must initialise it, normally to None. In-workspace
SDK/CLI constructors are updated. No validation result or reference-target wire
format changes.

This is locally verified development scope. Final versions, immutable spec/CTS
contracts, published registry locks, independent review, remote CI and platform
verification remain combined-release work. Official publication is held.
Original 1.15x latency / 1.20x memory targets remain unchanged; no new performance
qualification is implied, and the existing JS heap exception remains explicitly
deferred/unqualified. Go/PHP are independent, nonblocking tracks.
