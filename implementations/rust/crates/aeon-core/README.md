# AltoPelago AEON Core

`altopelago-aeon-core` provides the Sofia parser, compiler data model, limits,
and portable AES/Telex export primitives for AEON.

Most applications should depend on the `altopelago-aeon` facade instead.

## Experimental property addresses

Property-bearing Addressing delegates to the pinned standalone SANSA parser.
`SansaSelector::PropertyFilter` and the reexported `SansaPropertyName` represent
these predicates. Structural references and property-free parsing retain their
existing admission rules. The legacy reduced Core Resolve namespace has no
authoritative property facet and returns `UnsupportedPropertyScope`; applications
needing evaluation should use the SDK document namespace.

For newly admitted property addresses, qualifier `parameter_groups` is the
authoritative owned tree and `parameters` is empty. Duplicating both owned trees
would grow exponentially with nesting. Existing property-free ASTs retain their
legacy convenience field. Rendering handles the authoritative groups iteratively;
`QualifierTerm` cloning and destruction are iterative too. Its `Drop` implementation
means callers extracting owned fields must use borrowing or `std::mem::take`
instead of moving a field out directly. Derived `Debug`/equality are not bounded
serialization APIs for deeply nested caller data.

Rust source consumers must handle the new selector variant and initialize the
optional `SansaParseError::{limit_kind, limit, observed}` fields in struct literals.
Existing property-free diagnostics omit absent limit details in `Debug` output.
These are development API changes, not an official release.
