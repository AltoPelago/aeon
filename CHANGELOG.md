# Changelog

All notable implementation package changes are tracked here.

This changelog covers the implementation/package line. The AEON language,
specification, and CTS lines are versioned separately in their authority
repositories.

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
