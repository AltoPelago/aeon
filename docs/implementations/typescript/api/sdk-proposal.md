# Convenience Layer Proposal

Informative status: proposal for a public TypeScript convenience surface to replace example usage of `@aeon/sdk-internal`.

## Problem

The current TypeScript examples already converge on one application-facing helper layer, but they do so through the internal package name `@aeon/sdk-internal`.

That creates two problems:

- the examples teach consumers to depend on an internal package
- the public package story is unclear even though the convenience behavior is already established

## Current split

Today the implementation surface is roughly:

- `@aeon/core`
  - compile-only, fail-closed AEON processing
- `@aeon/runtime`
  - full orchestrated pipeline with profiles, AEOS validation, reference resolution, and finalization
- `@aeon/canonical`
  - object-to-AEON emission
- `@aeon/sdk-internal`
  - convenience helpers built on top of the above

The examples mainly rely on these `@aeon/sdk-internal` helpers:

- `readAeon(...)`
- `readAeonChecked(...)`
- `readAeonStrictCustom(...)`
- `writeAeon(...)`
- `indexEventsByPath(...)`
- `formatPath(...)`

## Recommendation

Do not fold `writeAeon(...)` into `@aeon/runtime`.

`@aeon/runtime` is the right home for read/validate/finalize orchestration, but not for object emission. `writeAeon(...)` is fundamentally a canonicalization/emission helper, so putting it into runtime would blur the package boundary.

Instead, promote the current convenience layer into a real public package:

- proposed name: `@aeon/sdk`

## Proposed package role

`@aeon/sdk` should be the app-facing convenience layer for common application tasks:

- load AEON text
- require successful compile/finalize before continuing
- optionally build indexed lookup helpers
- write plain objects back to AEON

That makes it the TypeScript counterpart to the new Python `load_text(...)` / `load_file(...)` convenience API.

## Proposed exports

Minimum first-wave exports:

```ts
readAeon(input, options?)
readAeonChecked(input, options?)
readAeonStrictCustom(input)
writeAeon(object, options?)
indexEventsByPath(events)
formatPath(path)
```

Potential future additions:

```ts
readAeonFile(path, options?)
requireNoCompileErrors(result)
requireNoFinalizeErrors(result)
```

## Boundary rules

Recommended package boundaries after promotion:

- keep in `@aeon/core`
  - low-level compile entry
- keep in `@aeon/runtime`
  - full pipeline orchestration
  - AEOS/schema-aware typed runtime helpers
- keep in `@aeon/canonical`
  - canonical object emission primitives
- move to `@aeon/sdk`
  - convenience wrappers that compose `core`, `finalize`, and `canonical`

## Example guidance

Once `@aeon/sdk` exists:

- simple application examples should prefer `@aeon/sdk`
- compile-only or infrastructure-heavy examples can still use lower-level packages directly
- `@aeon/sdk-internal` should disappear from public example READMEs and package manifests

## Migration path

1. Create public `@aeon/sdk` with the existing `sdk-internal` exports.
2. Repoint examples from `@aeon/sdk-internal` to `@aeon/sdk`.
3. Keep `@aeon/sdk-internal` as a short-lived compatibility alias only if needed.
4. Remove or archive `@aeon/sdk-internal` once examples and docs no longer depend on it.

## Why this is better than using `@aeon/runtime` alone

`@aeon/runtime` is intentionally broader and more opinionated:

- profiles
- schema validation
- output mode selection
- typed runtime guards

That is valuable, but it is not the same thing as:

- “load this AEON text and give me the checked document”
- “write this object back to AEON”

The convenience layer should stay small and obvious.

## Short conclusion

The implementation already has a useful app-facing convenience surface.
The main problem is that it is currently named and documented as internal.

The cleanest next step is:

- promote `@aeon/sdk-internal` into public `@aeon/sdk`
- keep `@aeon/runtime` focused on full-pipeline orchestration
