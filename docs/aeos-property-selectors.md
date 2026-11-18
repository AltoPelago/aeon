# Portable AEOS property selectors (development candidate)

The selected `aeos-properties-0.1` profile admits SANSA `key`, `tag` and `headTag`
predicates in rule **selector** fields through explicit portable AES/Telex APIs:

| Runtime | Decoded records | Telex |
| --- | --- | --- |
| TypeScript | `validateTelexRecords` (also accepts `PortableAesEvent` projections) | `validateTelex` |
| Rust | `validate_telex_records` | `validate_telex` |
| Pure Python | `validate_telex_records` | `validate_telex` |

The decoded APIs require event-locally valid portable records; Telex APIs perform
their existing transport validation first. Header records are not schema bindings.
Native Python's existing `load_telex_text(..., schema=...)` reaches the same Rust
validation path. Its finalization result remains a separate part of that API.
That loader retains its existing restricted schema-contract format and the
default inspection allowance; it does not expose resource-policy overrides.
No new native Query evaluator or WASM API is introduced.

Legacy native-event `validate`/`validate_events` and `load_text` keep their property
denial. Native event topology omits explicit heads and uses different child paths.
Project source events explicitly to portable AES before using this profile:

```js
const compiled = compile('n=<book("yes")>');
const records = projectPortableEvents(compiled.events);
const result = validateTelexRecords(records, {
  rules: [{selector: '$.n[0]&headTag("book")', constraints: {type: 'NodeHead'}}]
});
```

The head is `$.n[0]`; its first child is `$.n[0][0]`. `&tag("book")` selects the
NodeLiteral container, `&headTag("book")` selects its head, and ordinary text or a
field named `tag` supplies no tag authority. Keys come from authorized member or
attribute edges, including empty/Unicode names. Roots hide incoming keys and
positions are not keys. Results retain actual indexed event paths and identities;
no reference target is rewritten or followed implicitly. Structural `path` rules,
activation, Graph, mutation/Instruction/SO and storage/reference paths stay closed.
Existing closed-world attribute declarations remain necessary.

`resource_policy.max_property_inspections` and the host `resourcePolicy` override
share one private allowance for a validation call: default10,000, range0..1,000,000.
Integral finite numeric floats and signed zero normalize; bool, fractions, strings,
non-finite values, numeric subclasses/coercible Python objects and larger values
reject without coercion. Both schema and option policies validate, even when the
invalid schema value would otherwise be overridden. Existing identity/expansion
budgets and their domains are unchanged.

Candidates and inspected direct heads retain SANSA's charges. Distinct selector
resolutions share the remaining allowance; repeated branches inside one Resolve
retain their work. A private snapshot cache reuses each identical selector string
between repeated rules, expansion and closed-world checks. Constraints/expansion
charges still apply per rule. The cache never survives a public invocation.
New property selection stops after an earlier validation failure; no partial
guarantees are returned. Construction/order/ancestry work remains separate from
logical inspection accounting. Head iteration streams existing handles.

The shared52-case development fixture exercises decoded and Telex forms, repeated
calls, scope/kind distinctions, identity composition, numeric bounds, two-width
budgets, cache lifetime and denied consumers. The JSON-lines CTS adapters call the
real owning APIs; they implement no SANSA parsing or custom selection. The target
is experimental/excluded by default, with no stable conformance claim.

The AES Type Transpiler remains a preliminary proposal for explicit type conversion
after import (for example, a JSON string into an AEON date). No executable
transpiler exists in this slice, and it is not a0.17.0 prerequisite. Future
conversion/conflict/freshness/resource semantics require their own work.

All compatibility/target-preservation checks and1.15x latency/1.20x memory budgets
remain unchanged. Broad performance/platform/profile/registry qualification,
owning review/merges and combined-main retention remain separate gates.
Official releases, deployment and stable promotion remain held.
