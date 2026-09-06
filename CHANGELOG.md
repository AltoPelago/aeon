# Changelog

All notable implementation package changes are tracked here.

This changelog covers the implementation/package line. The AEON language,
specification, and CTS lines are versioned separately in their authority
repositories.

## 0.12.1 - 2026-09-05

### Added

- Added explicit portable AES projections for TypeScript, Rust, and Python,
  including value-less `NodeLiteral` containers, indexed `NodeHead` events,
  recursively flattened attributes and descendants, and structure-aware
  reference-target translation.
- Added portable AES inspect output and contract tests across the TypeScript,
  Rust, and Python CLI surfaces.

### Changed

- Standardized portable AES `kind` values on the normative AEON representation
  names, including `StringLiteral`, `ObjectNode`, `NodeLiteral`, `NodeHead`,
  `CloneReference`, and `WTCDateTimeLiteral`.
- Updated TypeScript SANSA consumers to require the prepared
  `@altopelago/sansa@0.10.1` patch release.

### Fixed

- Preserved structural identities across node and attribute AST surfaces,
  matter resolution, debug and JSON projections, and clone materialization.
- Kept identity as occurrence metadata rather than path identity.
- Aligned AEOS Telex adaptation across TypeScript, Rust, and Python: flat
  attributes now participate in owner constraints, Python validates the
  adapted stream instead of an empty normalization result, and Rust preserves
  portable numeric indexes for list, tuple, and node paths.
- Added AEOS adapter regressions for decomposed datatypes, explicit node heads,
  node-content cardinality, WTC kinds, nested attributes, and structural
  identity metadata.
- Enforced exact lowercase `local` for the reserved WTC resolver-local
  reference while preserving authored case for named references.
- Aligned datatype-clarifier parsing across the implementation surfaces.

## 0.12.0 - 2026-08-10

### Breaking

- Renamed the WTC datatype surface from `zrut` to `wtc` and the public literal
  kind from `ZRUTDateTimeLiteral` to `WTCDateTimeLiteral` across the
  implementation line.

### Added

- Added `triple<A,B,C>` as a reserved alias for `tuple<A,B,C>`.
- Added `decimal` as a reserved alias for `radix[10]`, including AEOS numeric
  form enforcement for declared radix constraints.
- Added WTC temporal-reference support for geographic coordinate payloads such
  as `2035-01-01T09:00&-36.7590183/144.2826718`.
- Added structural identity parsing, validation, canonical preservation, and AES
  metadata support to the Rust, Python, and PHP implementations, with shared CTS
  coverage for named and anonymous heads, invalid forms, and duplicates.

### Fixed

- Applied explicit Rust CLI transport/strict mode overrides during Core datatype
  validation, including fail-closed rejection of the retired `zrut` datatype in
  strict mode.

## 0.11.0 - 2026-07-24

### Added

- Added TypeScript support for embedded SANSA address literals as the reserved
  `sansa` value type.
- Added SANSA address literal coverage for contextual roots, parent traversal,
  position ranges, qualifier forms, name patterns, semantic filters,
  representation filters, comment boundaries, and container boundaries.
- Added AEOS schema source support for native `path:sansa` and
  `selector:sansa` rule targets.
- Added SANSA selector expansion in AEOS validation, including direct expansion,
  recursive expansion, semantic datatype filters, representation kind filters,
  name patterns, and explicit attribute-space traversal.
- Added the TypeScript SANSA Resolve CTS runner.
- Added Tonic materialization support for SANSA-addressable matter graphs.

### Changed

- TypeScript packages that consume SANSA now depend on the published
  `@altopelago/sansa@0.9.0` package instead of a local repository path.
- AEOS schema printing now emits native `path:sansa` and `selector:sansa`
  fields for rule targets.
- Rust and Python implementation/package lines now track this cycle as
  `0.11.0`.

### Fixed

- Rejected legacy `[*]` wildcard selectors in AEOS schema surfaces in favor of
  SANSA expansion selectors such as `.*`.
- Preserved SANSA address literals as canonical string values during JSON
  finalization.

## 0.10.0 - 2026-07-14

### Breaking

- Changed encoding-family literal syntax from `$payload` to `&payload` across
  the implementation surface. This applies to `encoding`, `base64`, `embed`,
  and `inline` literals.

### Changed

- Reserved `$payload` syntax for the forthcoming SANSA address literal work.
- Updated TypeScript, Rust, Python, and PHP-aligned stress fixtures so
  canonical and diagnostic parity use the new `&payload` encoding form.
- Rebuilt the TypeScript stress test path so the Rust smoke binary is refreshed
  before cross-implementation stress checks run.

## 0.9.6 - 2026-06-29

### Security

- Rejected prototype-polluting reserved keys during implementation processing.
- Hardened the TypeScript release and publish path by moving the workspace and
  GitHub Actions `pnpm` runtime to patched `10.34.4`.

### Changed

- Added profile collection semantics and defaults to the TypeScript release
  surface.
- Added container semantics to built-in profiles.
- Added profile capabilities metadata and renamed profile node-ordering
  semantics for clearer public behavior.

### Fixed

- Restricted encoding literals to base64url and preserved padding behavior
  across the implementation surface.

## 0.9.5 - 2026-06-07

### Changed

- Preserved parameterized `null<T>`, `nan<T>`, and `infinity<T>` datatype
  claims across the TypeScript, Rust, and Python implementation surfaces.
- Added attribute-addressed annotation targeting so structured comments inside
  attribute blocks bind to paths such as `$.a.@.b` instead of the owning value.
- Added placement landmarks for node heads and attribute entries, improving
  annotation placement around node tags, parameters, attribute keys, datatypes,
  separators, equals signs, and values.

### Fixed

- Kept comments in binding and node heads attached to the container path instead
  of drifting onto the first descendant binding or child value.
- Ignored `@` markers inside structured comments while scanning Python
  annotation landmarks.
- Aligned Python attribute path formatting with TypeScript and Rust by using
  ASCII-only bare attribute identifiers.
- Avoided unnecessary annotation-stream work for documents with no structured
  comments and cached Rust offset-to-position lookups for denser annotation
  streams.

## 0.9.4 - 2026-06-02

### Changed

- Extended reserved structural generic datatype claims to include
  `object<T>` and `node<T>` alongside `list<T>` and `tuple<T...>`.
- Allowed `node<T>` on node heads as a preserved child-content claim while
  keeping non-`node` generic node-head datatypes invalid.
- Added CTS/spec coverage for parameterized object and node claims and updated
  TypeScript, Rust, and Python parser/Core behavior to preserve the new
  claims without Core-level child/member enforcement.

## 0.9.3 - 2026-06-01

### Security

- Hardened mode authority by separating document-declared `aeon:mode` from the
  processor-selected effective mode. External processor/runtime policy now wins
  when supplied, so untrusted document metadata cannot force strict, transport,
  or custom behavior.
- Added CTS coverage for declared-mode/effective-mode disagreement in both
  directions: declared strict with effective transport, and declared transport
  with effective strict.
- Updated release guidance and npm publish automation to use signed,
  implementation-specific tags and require signed annotated tags before publish.

### Changed

- Updated AEON v1 spec-aligned behavior for mode resolution: absent declared
  mode defaults to transport, declared mode is honored only when no external
  effective mode is provided, and explicit effective mode overrides declared
  mode.
- Updated TypeScript CLI `check`, `inspect`, and `finalize` so `--strict` and
  `--transport` are treated as external effective-mode selections rather than
  document metadata edits.
- Updated CTS source-lane runner support for explicit `options.effective_mode`
  so legacy `input.mode` metadata is not confused with processor authority.

### Fixed

- Treated structured header metadata under `aeon:*` as control-plane data
  during typed-mode enforcement, matching shorthand header behavior and
  preventing strict-mode payload typing diagnostics from firing on header
  metadata.

## 0.9.2 - 2026-05-30

### Security

- Added AEOS portable pattern-profile enforcement for `pattern` and
  `reference_target_pattern`, rejecting host-specific or high-risk regex
  constructs such as lookaround, backreferences, named groups, Unicode property
  escapes, unsupported alphabetic escapes, overlong patterns, and nested
  quantified groups.
- Added regression coverage for portable pattern enforcement across
  TypeScript and Rust implementation surfaces.
- Added AEOS `resource_policy` budget enforcement across TypeScript, Rust,
  and Python for event counts, rule counts, alternatives, schema depth, path
  length, reference-resolution steps, selector expansion, and default container
  child counts.
- Added Core `max_events` budget enforcement across TypeScript, Rust, and Python
  so consumers can fail closed before returning oversized AES event streams.

### Fixed

- Fixed TypeScript and Rust CLI default contract registry discovery after the
  aeonite-specs contracts reorganization, and taught the Rust CLI to load the
  current `aeos:schema` contract artifact shape.

## 0.9.1 - 2026-05-27

### Added

- Added AEOS `.aeos` schema loading and contract metadata support.
- Added `any_of` schema alternatives, wildcard rule expansion, and schema
  policy handling.
- Added annotation placement metadata, including binding-head annotations and
  comments bound between `=` and the value.
- Added structured comment parsing in the annotation stream, node-internal
  comment binding, and structured header trivia exposure.
- Added `max_input_bytes` enforcement for bounded input processing.
- Added AEOS support for nullable values, NaN and Infinity options, toggle
  constraints, cardinality, literal widening, radix constraints, and multiple
  `null_values`.
- Added support for literal words as keys in key positions.

### Changed

- Renamed the boolean-like literal family from `switch` to `toggle` across
  APIs and docs, while canonicalizing legacy `switch` spelling to `toggle`.
- Changed the default profile to `core`.
- Renamed the separator-literal reserved datatype from `set` to `kadot`.
  `sep` remains the canonical/general separator datatype, and Core only
  enforces the separator-literal family for `kadot`, not dot-number shape.
- Tightened strict/custom mode typing so attribute entries, including node-head
  attributes, require explicit datatypes when they carry values.
- Updated separator fixtures and stress coverage so bracketed separator specs
  use `sep[...]`, while `kadot` examples use unparameterized dot-number-like
  payloads.

### Fixed

- Added duplicate object member key validation in Rust recovery/validation
  paths for CTS alignment.
- Fixed AEOS event serialization drift after the Rust toolchain update.
- Fixed TypeScript typegen runtime import output.

### Tooling

- Added the Rust `aeon-wasm` crate and re-scoped TypeScript packages under
  `@altopelago`.
- Updated the Rust toolchain baseline and documented TypeScript/Node dependency
  baselines.
- Added npm trusted-publishing workflow support, publish preflight checks, and
  dry-run handling for already-published package versions.

## 0.9.0 - 2026-05-16

Initial public npm release of the TypeScript AEON implementation packages under
the `@altopelago` scope.

### Published

- `@altopelago/aeon-aes`
- `@altopelago/aeon-annotation-stream`
- `@altopelago/aeon-canonical`
- `@altopelago/aeon-cli`
- `@altopelago/aeon-core`
- `@altopelago/aeon-finalize`
- `@altopelago/aeon-integrity`
- `@altopelago/aeon-lexer`
- `@altopelago/aeon-parser`
- `@altopelago/aeon-profiles`
- `@altopelago/aeon-runtime`
- `@altopelago/aeon-sdk`
- `@altopelago/aeon-tonic`
- `@altopelago/aeon-transport`
- `@altopelago/aeon-typegen`
- `@altopelago/aeon-wasm`
- `@altopelago/aeos-core`

### Notes

- Added public package metadata for npm discovery and package health scanners.
- Added npm publish preflight checks for packed manifests and entry points.
- Added GitHub Actions npm publishing workflow for future trusted-publishing
  releases with provenance.
- Added dry-run handling for already-published package versions.
