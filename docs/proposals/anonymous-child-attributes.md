# Anonymous Child Attributes Proposal

Status: implemented in TypeScript, Rust, and Python core

Main implementation docs now live in:

- [`docs/implementations/implementation-guideline.md`](../implementations/implementation-guideline.md)
- [`docs/implementations/typescript/api/core.md`](../implementations/typescript/api/core.md)

## Summary

AEON currently permits anonymous type annotations inside value containers:

```aeon
values:list = [:int32 = 3, :string = "4"]
page:node = <page(:string = "hello", :int32 = 3)>
```

This proposal extends that model so anonymous list elements, tuple elements, and node children can carry attributes using the same head syntax as named bindings.

```aeon
values:list = [@{unit:string = "cm" precision:n = 2}:n = 3]
dimensions:node = <dimensions(@{unit:string = "cm"}:int32 = 3)>
```

## Motivation

Anonymous children can already carry type information, but they cannot carry value-local metadata. This creates an asymmetry with named bindings and node heads, and makes common document-model cases awkward:

```aeon
dimensions:node = <dimensions(
  @{unit:string = "cm"}:int32 = 3
)>
```

The attribute belongs to the anonymous child, not the parent node, list, or tuple.

## Syntax

Anonymous child attributes reuse binding-head ordering:

```aeon
@{...}:type = value
@{...} = value
:type = value
```

The attribute block, when present, MUST appear before the type annotation. The type annotation remains optional when an attribute block is present.

Valid:

```aeon
a:list = [@{unit:string = "cm" precision:n = 2}:n = 3]
a:list = [@{unit:string = "cm"} = 3]
a:list = [:n = 3]
a:tuple = (@{role:string = "x"}:string = "hello")
a:node = <tag(@{role:string = "label"}:string = "hello")>
```

Invalid:

```aeon
@{unit:string = "cm"} = 3
a = @{unit:string = "cm"} = 3
a:object = { @{unit:string = "cm"}:n = 3 }
a:list = [@{unit:string = "cm"}@{precision:n = 2}:n = 3]
a:list = [:n = :n = 3]
```

## Single Attribute Block Rule

AEON heads have one attribute block slot. The following MUST fail:

```aeon
a@{unit:n = 3}@{precision:n = 2}:n = 3
node:node = <tag@{a:n = 1}@{b:n = 2}:node>
a:list = [@{unit:n = 3}@{precision:n = 2}:n = 3]
```

Multiple entries belong inside the one attribute block:

```aeon
a@{unit:n = 3 precision:n = 2}:n = 3
a:list = [@{unit:n = 3 precision:n = 2}:n = 3]
```

## Semantics

Anonymous child attributes attach to the child's canonical path:

```aeon
values:list = [@{unit:string = "cm"}:n = 3]
```

The attribute belongs to `$.values[0]`.

For node children, canonical addressing uses the same indexed path form as other
ordered child slots:

```aeon
page:node = <page({a:n = 1, b:n = 2})>
```

The anonymous object child is addressed as:

```text
$.page[0]
$.page[0].a
$.page[0].b
```

This keeps ordered child addressing uniform across lists, tuples, and node
children. Node children remain structurally distinct in the value model, but
their canonical path form uses bracket indices rather than a separate node-child
path sigil.

Default JSON finalization SHOULD preserve the payload shape and emit:

```json
{ "values": [3] }
```

Tools that need metadata SHOULD read it from AES events or a finalized map/materialized metadata view rather than requiring default JSON payloads to wrap scalar children.

## Implementation Notes

Implementations may represent this as a new wrapper value, for example:

```text
AnnotatedValue {
  attributes,
  datatype?,
  value
}
```

Existing anonymous typed values can remain as `TypedValue` initially, but parsers and downstream consumers need helper functions equivalent to:

```text
valueDatatype(value)
valueAttributes(value)
unwrapAnonymousHead(value)
```

This keeps list, tuple, and node child flattening aligned with existing synthetic binding events.

## Follow-up Notes

- Python AEOS currently trails the TypeScript and Rust implementations in datatype-rule coverage and behavior. Before anonymous child attributes are relied on for cross-implementation schema validation, Python AEOS should be brought to datatype-rule parity.
- Indexed node-child AES events now emit in TypeScript, Rust, and Python using bracket addressing such as `$.page[0]` and `$.page[0].a`.
- AEOS coverage should explicitly validate indexed node-child paths so anonymous child metadata and datatypes participate in schema checks consistently across implementations.
