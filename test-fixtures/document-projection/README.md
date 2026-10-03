# AEON document-projection fixture contract

This directory contains a local, non-authoritative implementation contract for
projecting successful AEON compilation output into a host-neutral document
namespace. It is the Stage 0 precursor to the shared Rust document graph and a
candidate source for a future external CTS suite.

The contract deliberately does not define AEON syntax, AES, Telex, SANSA, or
AEOS behavior. Those remain owned by their specifications and CTS suites. It
records the information that an AEON adapter must expose consistently so Rust,
Python, TypeScript, and SANSA-facing views do not develop incompatible trees.

## Address domains

AEON source paths and portable AES event paths are different domains. Every
binding has a document-scoped `namespace` address. Event-backed bindings also
retain their portable `aes-event` address, while bindings projected directly
from source retain an `aeon-source` address where one exists. Synthetic
`NodeHead` bindings have no source address, and every indexed source child
beneath a node gains the head index in its portable address. Synthetic
document and plane roots have namespace addresses without pretending to be AES
events.

For event-backed bindings, the future SANSA adapter derives namespace addresses
from `aes-event` addresses by default so source and complete-Telex ingestion
expose the same namespace. Pytonic may offer source-oriented navigation without
pretending that a synthetic node head has a source spelling.

The binding snapshots use the `aes-event` domain and the complete portable node
topology. The TypeScript adapter first projects native assignment events into
that shape, retaining distinct binding, node-head, and content occurrences.
`portableTopologyCases` separately locks the underlying source-to-event path
translation.

`namespaceProjectionFields` describes the SANSA-facing snapshots.
`documentGraphRequiredFields` is the target graph contract and includes
structured datatype, provenance, transport, and lineage data that the legacy
namespace surface did not expose. The current TypeScript namespace exposes the
portable topology, structured datatype components, origin, and span; transport
and lineage remain document-graph capabilities rather than SANSA binding fields.

## Snapshot shape

Each scope is represented as a preorder list of bindings. A binding records
its canonical address, parent address, ordered child addresses, attribute-space
link, and applicable AEON metadata. Omitted optional fields mean that the input
did not supply that projection value; implementations must not invent one.

Scalar values use JSON-safe representations. Finite AEON numbers remain exact
strings. Non-finite values use a tagged object:

```json
{ "$nonFinite": "nan" }
```

The allowed tags are `nan`, `positive-infinity`, and `negative-infinity`.
References and SANSA-address literals retain their tagged portable object
shape.

Attribute spaces appear immediately after their owner and after the owner's
ordinary children. This traversal order is only the fixture encoding; the
`children` and `attributeSpace` fields carry the actual topology.

## Capability vocabulary

Capabilities are independent. In particular, a Telex-origin document may have
`provenance.origin` and `provenance.span` without having `source.bytes` or
`source.authored-lexemes`.

A document reports each capability using one of:

- `complete`: available for every applicable record;
- `partial`: available for some applicable records;
- `not-supplied`: the input did not carry it;
- `not-collected`: the implementation or selected ingestion mode discarded it;
- `not-applicable`: the capability has no meaning for that route or profile.

`not-supplied` and `not-collected` must remain distinguishable. This contract
does not allow a consumer to infer one capability from another.

`capabilityScenarios` are consistency examples, not promises that every input
route has those exact states. They specifically demonstrate that transported
origin and spans can be complete while source bytes and authored lexemes were
not supplied.

## Updating the fixture

Changes require review against the current AEON event model and TypeScript
SANSA adapter. Do not regenerate expected output blindly: inspect changes to
addresses, topology, value families, identity, attributes, datatype metadata,
and source plane individually.
