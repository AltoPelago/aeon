# @aeon/profiles

Minimal profile compiler engine for AEON.

Implementation docs:

- [`docs/implementations/typescript/api/profiles.md`](../../../../docs/implementations/typescript/api/profiles.md)

This package provides a single entry point, `compile(...)`, which emits the
Assignment Event Stream (AES) plus optional diagnostics metadata. Profiles are
registered in a registry and are responsible for emitting AES only.

## Usage

```ts
import { compile } from '@aeon/profiles';

const result = compile('key = "value"', {
  profile: 'altopelago.core.v1',
  mode: 'strict',
});

if (!result.meta?.errors?.length) {
  console.log(result.aes);
}
```

## API

- `compile(input, options)`
- `createRegistry()` / `createDefaultRegistry()`
- `altopelagoCoreProfile`
- `jsonProfile`

Type contract:

```ts
export type CompileOptions = {
  profile: ProfileRef;
  registry?: ProfileRegistry;
  mode?: 'strict' | 'loose';
  datatypePolicy?: 'reserved_only' | 'allow_custom';
  maxInputBytes?: number;
  maxAttributeDepth?: number;
  maxSeparatorDepth?: number;
};

export type CompileResult = {
  aes: readonly AssignmentEvent[];
  meta?: {
    errors?: readonly Diagnostic[];
    warnings?: readonly Diagnostic[];
    profileId?: string;
    version?: string;
  };
};
```

Processor contract:

```ts
export interface Processor {
  id: string;
  order?: number;
  apply(aes: readonly AssignmentEvent[], ctx: ProcessorCtx): readonly AssignmentEvent[];
}

export interface Profile {
  id: string;
  version?: string;
  compile(input: unknown, ctx: CompileCtx): readonly AssignmentEvent[] | void;
  processors?: readonly Processor[];
}
```

Processor ordering:
- Sorted by `order` (default `0`)
- Ties resolved by `id` (lexicographic)

Built-in processors:
- `createResolveRefsProcessor(mode?)` — resolves clone refs `~` to terminal values and
  preserves pointer refs `~>`. This is optional and not enabled by default.

Built-in profiles:
- `altopelago.core.v1` — form-only AES output
- `aeon.gp.core.v1` — AEON GP core profile
- `json` — resolves references for JSON interoperability

## Tests

Integration tests are guarded to avoid requiring local workspace installs.
Run with:

```bash
AEON_PROFILES_INTEGRATION=1 pnpm -r test
```

## Profile Discovery Policy

- Default: static, code-registered profiles via `createRegistry()` / `register()`.
- Optional: runtime registration is allowed, but the engine does not scan config
  files or perform dynamic discovery. Host apps can wire profiles explicitly.

## Notes

- AES is the only output. No interpretation or object materialization occurs here.
- Profiles are deterministic and should not perform I/O.
