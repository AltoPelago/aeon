# Releasing

This repository is not publishing to npm yet, but the TypeScript workspace is prepared for a workspace-aware release flow when that decision is made.

For cross-repo branching and per-implementation release strategy, see
[`docs/release-strategy.md`](./docs/release-strategy.md).

## Scope

The intended first npm release wave is the application-facing TypeScript implementation surface:

- `@aeon/lexer`
- `@aeon/parser`
- `@aeon/aes`
- `@aeon/annotation-stream`
- `@aeon/core`
- `@aeon/finalize`
- `@aeon/canonical`
- `@aeon/runtime`
- `@aeos/core`

Tooling, CTS helpers, fuzzing, and internal support packages should not be published as part of the first wave.

## Why Publish From The Workspace Root

Several packages depend on one another using `workspace:*`.
The release flow should therefore run from the TypeScript workspace root so pnpm can:

- publish packages in dependency order
- rewrite internal `workspace:*` dependencies to the released version
- use the already-defined workspace build scripts

Avoid ad hoc folder-by-folder `npm publish`.

## Preconditions

From `implementations/typescript/`:

1. Install dependencies.
2. Build the workspace.
3. Run the relevant CTS and package tests.
4. Confirm package tarballs are clean.

Recommended commands:

```bash
pnpm install
pnpm build
pnpm test:cts:all
pnpm test
```

Optional dry-run pack verification for the first wave:

```bash
for pkg in lexer parser aes annotation-stream core finalize canonical runtime aeos; do
  (cd packages/$pkg && npm pack --dry-run --json)
done
```

The expected tarballs should:

- include built `dist/`
- include `README.md`
- exclude compiled `*.test.*` artifacts

## Publish Flow

Run the publish from `implementations/typescript/`:

```bash
pnpm -r \
  --filter @aeon/lexer \
  --filter @aeon/parser \
  --filter @aeon/aes \
  --filter @aeon/annotation-stream \
  --filter @aeon/core \
  --filter @aeon/finalize \
  --filter @aeon/canonical \
  --filter @aeon/runtime \
  --filter @aeos/core \
  publish --access public --no-git-checks
```

## Notes

- If version bumps are needed, do them before the build and dry-run pass.
- If public package names or the first-wave package set changes, update this document first.
- Specs and CTS remain authoritative in sibling repos:
  - [aeonite-specs](https://github.com/aeonite-org/aeonite-specs)
  - [aeonite-cts](https://github.com/aeonite-org/aeonite-cts)
