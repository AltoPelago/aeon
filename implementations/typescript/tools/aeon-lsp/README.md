# @altopelago/aeon-lsp

AEON language server for editor integrations.

## Current Surface

- diagnostics backed by `@altopelago/aeon-core`
- hover for datatype annotations and reference targets
- basic completion for header fields, keys, and reference paths

## Build

```bash
pnpm --filter @altopelago/aeon-lsp build
```

## Run

The package exposes the `aeon-lsp` binary after build:

```bash
pnpm --filter @altopelago/aeon-lsp build
node implementations/typescript/tools/aeon-lsp/dist/server.js
```

## Notes

- This is an MVP server surface, not a fully documented editor extension package.
- Validation can read optional `aeon.validation` workspace configuration when the client supports workspace configuration.

The child identity candidate adds descriptive hovers for lexer-recognised
structural identity annotations and SANSA address literals. It does not resolve
them, perform global identity completion or admit identity clone/pointer targets.
Compiler diagnostics and trusted-schema validation retain existing authority;
reference completion remains structural. Rebuild/bundle against the coordinated
candidate dependency graph to use these features; a released/stale server does
not gain support from the editor grammar alone.
