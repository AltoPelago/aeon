# Changelog

All notable implementation package changes are tracked here.

This changelog covers the implementation/package line. The AEON language,
specification, and CTS lines are versioned separately in their authority
repositories.

## 0.9.4 - 2026-06-02

### Changed

- Extended reserved generic datatype claims to include `object<T>`, `node<T>`,
  `null<T>`, `nan<T>`, and `infinity<T>` alongside `list<T>` and
  `tuple<T...>`.
- Allowed `node<T>` on node heads as a preserved child-content claim while
  keeping non-`node` generic node-head datatypes invalid.
- Added CTS/spec coverage for parameterized object, node, null, NaN, and
  infinity claims and updated TypeScript, Rust, and Python parser/Core behavior
  to preserve the new claims without Core-level child/member enforcement.

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
