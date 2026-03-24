# Profiles API

Informative status: implementation documentation for `@aeon/profiles`.

## Package

- Module: `@aeon/profiles`
- Entry point: [`implementations/typescript/packages/profiles/src/index.ts`](../../../../implementations/typescript/packages/profiles/src/index.ts)

## Primary entry point

```ts
compile(input, options)
```

Profiles provide a compile boundary that emits AES using a selected profile and optional registry.

## Options

```ts
interface CompileOptions {
  readonly profile: ProfileRef;
  readonly registry?: ProfileRegistry;
  readonly mode?: 'strict' | 'loose';
  readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
  readonly maxInputBytes?: number;
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
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

## Built-in exports

- `createRegistry()`
- `createDefaultRegistry()`
- `altopelagoCoreProfile`
- `aeonGpCoreProfile`
- `jsonProfile`

## Example

```ts
import { compile, createDefaultRegistry } from '@aeon/profiles';

const result = compile(source, {
  profile: 'altopelago.core.v1',
  registry: createDefaultRegistry(),
  mode: 'strict',
});
```
