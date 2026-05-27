# Changelog

All notable implementation package changes are tracked here.

This changelog covers the implementation/package line. The AEON language,
specification, and CTS lines are versioned separately in their authority
repositories.

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
