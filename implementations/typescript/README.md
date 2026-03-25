# TypeScript Implementation

Reference AEON implementation workspace.

## Start Here

If you want to:

- use AEON as a library, start with `packages/core/README.md`
- validate AES against AEOS schemas, then read `packages/aeos/README.md`
- run the full phase-ordered runtime, read `packages/runtime/README.md`
- use the CLI, read `packages/cli/OUTPUT_CONTRACT.md`

## Workspace Setup

```bash
cd implementations/typescript
pnpm install
pnpm build
```

TypeScript workspace note:
- run `pnpm` build/test/typecheck commands from this workspace root, not from the repo root;
- this workspace provides the local `typescript` toolchain used by package scripts such as `tsc -p tsconfig.json`;
- for package-specific commands, stay inside this workspace and use `pnpm --filter ...`, for example `pnpm --filter @aeon/parser build`.
- `dist/` directories are generated outputs and are expected to be recreated locally.

## Common Commands

```bash
pnpm bootstrap
pnpm build
pnpm typecheck
pnpm test
pnpm test:fuzz
pnpm test:stress
pnpm test:cts
pnpm test:cts:core
pnpm test:cts:aes
pnpm test:cts:annotations
pnpm test:cts:all
```

The CTS commands now check for the required built outputs first and will tell you to run `pnpm build` if those artifacts are missing.

Package-scoped examples from this workspace:

```bash
pnpm --filter @aeon/parser build
pnpm --filter @aeon/parser test
pnpm --filter @aeon/cli build
pnpm --filter @aeon/cli test
```

## Common Paths

- `packages/` - published libraries and the CLI
- `tools/` - implementation-specific runners and utilities
- `internal-release/` - archival `0.0.1` packaging metadata only; not current `0.9.0` release state
- `../../scripts/` - implementation-side helpers used by this workspace
- sibling `aeonite-org/aeonite-cts/cts/` - language-neutral conformance suites
- sibling `altopelago/aeon-tooling-private/scripts/` - shared CTS source-lane runner support today; this path is resolved through the repo helper layer rather than hardcoded in package scripts

Path resolution is centralized through the repo helper layer and can be overridden with:

- `AEONITE_CTS_ROOT`
- `AEON_TOOLING_ROOT`

Backward-compatible alias:

- `AEON_TOOLING_PRIVATE_ROOT`

## Typical Flows

### Parse an AEON document

Use `@aeon/core`:

```ts
import { compile } from '@aeon/core';

const result = compile('port:int32 = 8080');

if (result.errors.length === 0) {
  console.log(result.events);
}
```

### Validate against an AEOS schema

Use `@aeon/core` plus `@aeos/core`:

```ts
import { compile } from '@aeon/core';
import { validate } from '@aeos/core';

const compiled = compile('port = 8080');
if (compiled.errors.length > 0) throw new Error('compile failed');

const validation = validate(compiled.events, {
  rules: [{ path: '$.port', constraints: { type: 'IntegerLiteral' } }],
});

console.log(validation.ok);
```

### Run the end-to-end runtime

Use `@aeon/runtime` when you need phase orchestration beyond compile-only workflows:

```ts
import { runRuntime } from '@aeon/runtime';

const result = runRuntime('name = "AEON"', { output: 'json' });
console.log(result.document);
```

## Notes

- This workspace is implementation-specific.
- Language-neutral conformance sources live in the sibling `aeonite-org/aeonite-cts` repo.
