# @aeon/aeon-lsp

AEON language server for editor integrations.

## Current Surface

- diagnostics backed by `@aeon/core`
- hover for datatype annotations and reference targets
- basic completion for header fields, keys, and reference paths

## Build

```bash
pnpm --filter @aeon/aeon-lsp build
```

## Run

The package exposes the `aeon-lsp` binary after build:

```bash
pnpm --filter @aeon/aeon-lsp build
node implementations/typescript/tools/aeon-lsp/dist/server.js
```

## Notes

- This is an MVP server surface, not a fully documented editor extension package.
- Validation can read optional `aeon.validation` workspace configuration when the client supports workspace configuration.
