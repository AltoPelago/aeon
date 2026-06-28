# Profiles API

Informative status: implementation documentation for `@altopelago/aeon-profiles`.

## Package

- Module: `@altopelago/aeon-profiles`
- Entry point: [`implementations/typescript/packages/profiles/src/index.ts`](../../../../implementations/typescript/packages/profiles/src/index.ts)

## Primary entry point

```ts
compile(input, options)
```

Profiles provide a compile boundary that emits AES using a selected profile and optional registry. If no profile is selected, `core` is used.

## Options

```ts
interface CompileOptions {
  readonly profile?: ProfileRef;
  readonly registry?: ProfileRegistry;
  readonly mode?: 'strict' | 'loose';
  readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
  readonly maxInputBytes?: number;
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
  readonly maxGenericDepth?: number;
}
```

## Related types

- `Profile`
- `ProfileRef`
- `ProfileRegistry`
- `Processor`
- `CompileCtx`
- `ProcessorCtx`

## Behavior

- `profile` selects the compiler profile.
- `registry` provides profile lookup when `profile` is a string id.
- `mode`, `datatypePolicy`, and depth controls are forwarded into compilation context.
- Profiles may define processors, although higher-level runtime flows may intentionally skip them to preserve phase ordering.
- Profiles may expose contract metadata such as `modeDefault`, `datatypePolicyDefault`, `collections`, `containers`, and `capabilities`.

## Built-in exports

- `createRegistry()`
- `createDefaultRegistry()`
- `coreProfile`
- `aeonGpCoreProfile` (`aeon.gp.profile.v1`, with GP collection semantics for `list`/`tuple`, container semantics for `object`/`node`, and required processor capabilities)
- `jsonProfile`

## Example

```ts
import { compile, createDefaultRegistry } from '@altopelago/aeon-profiles';

const result = compile(source, {
  profile: 'core',
  registry: createDefaultRegistry(),
  mode: 'strict',
});
```
