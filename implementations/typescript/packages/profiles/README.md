# @altopelago/aeon-profiles

Minimal profile compiler engine for AEON.

Implementation docs:

- [`docs/implementations/typescript/api/profiles.md`](../../../../docs/implementations/typescript/api/profiles.md)

This package provides a single entry point, `compile(...)`, which emits the
Assignment Event Stream (AES) plus optional diagnostics metadata. Profiles are
registered in a registry and are responsible for emitting AES only.

## Usage

```ts
import { compile } from '@altopelago/aeon-profiles';

const result = compile('key = "value"', {
  mode: 'strict',
});

if (!result.meta?.errors?.length) {
  console.log(result.aes);
}
```

## API

- `compile(input, options)`
- `createRegistry()` / `createDefaultRegistry()`
- `coreProfile`
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

Profile metadata:

```ts
export interface CollectionSemantics {
  ordered: boolean;
  heterogeneous: boolean;
  unique: boolean;
  fixedLength: boolean;
}

export interface ObjectContainerSemantics {
  ordered: boolean;
  heterogeneous: boolean;
  uniqueKeys: boolean;
}

export interface NodeContainerSemantics {
  ordered: boolean;
  heterogeneous: boolean;
  uniqueAttributes: boolean;
  mixedContent: boolean;
}

export interface ProfileCapabilities {
  references: boolean;
  clones: boolean;
}

export type DatatypeClarifierSemantics = 'none' | 'radix_base' | 'separator_chars' | 'encoding_name';

export interface DatatypeSemantics {
  literalFamily: string;
  clarifiers: DatatypeClarifierSemantics;
  aliasOf?: string;
  equivalentTo?: string;
}
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
  modeDefault?: 'strict' | 'loose';
  datatypePolicyDefault?: 'reserved_only' | 'allow_custom';
  collections?: Readonly<Record<string, CollectionSemantics>>;
  containers?: Readonly<Record<string, ObjectContainerSemantics | NodeContainerSemantics>>;
  datatypeSemantics?: Readonly<Record<string, DatatypeSemantics>>;
  capabilities?: ProfileCapabilities;
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
- `core` — form-only AES output
- `aeon.gp.profile.v1` — AEON GP profile contract, including strict/reserved-only defaults, collection semantics for `list`/`tuple`, container semantics for `object`/`node`, closed datatype clarifier validation for radix, separator, and encoding families, and required processor capabilities
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
