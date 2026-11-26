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
- Profiles may expose contract metadata such as `modeDefault`, `datatypePolicyDefault`, `collections`, `containers`, `datatypeSemantics`, and `capabilities`.
- `aeon.gp.profile.v1` allows generics on custom labels and the reserved
  datatypes `list`, `tuple`, `triple`, `object`, `node`, `null`, `nan`,
  `infinity`, and `symbol`. Strict GP accepts `duration:symbol<time> = |1min|`. Binding annotations on `node` accept `node` or
  custom arguments. On node heads, only `node` may carry generic arguments.
  Disallowed generic claims raise `PROFILE_DATATYPE_GENERIC_NOT_ALLOWED`.
  GP rejects clarifiers on node heads and on `symbol` annotations. When the
  effective datatype policy admits custom labels, GP requires a parameterized
  custom value to bind a list or tuple.
- `set.to.eleven.v1` is an opt-in test profile that accepts generic arguments
  and clarifiers together on any Core-valid datatype annotation, including
  `duration:symbol<time>["minutes"] = |1min|`. Configure the usual Core
  limits for tests that need deeper generics or multiple clarifier values.
- `aeon.gp.profile.v1` validates datatype clarifiers against its declared datatype semantics: undeclared datatype clarifiers fail, `none` entries reject explicit clarifiers, `radix_base` requires exactly one integral numeric value from `2` through `64`, `separator_chars` requires string values, and `encoding_name` requires exactly one string value.

## Built-in exports

- `createRegistry()`
- `createDefaultRegistry()`
- `coreProfile`
- `aeonGpCoreProfile` (`aeon.gp.profile.v1`, with GP collection semantics for `list`/`tuple`, container semantics for `object`/`node`, closed datatype clarifier validation for radix, separator, and encoding families, and required processor capabilities)
- `setToElevenProfile` (`set.to.eleven.v1`)
- `jsonProfile`

## Load a profile contract

The caller reads a trusted `.aeon` artifact and supplies its source text to
`loadProfileContract()`. The loader validates the Core v1 contract fields and
returns an immutable `ProfilePolicy`. It requires a `generic_admission` record
and reports malformed artifacts and unsupported rule fields as errors.
`createProfile()` makes an executable profile from the policy. The same policy
or profile can be reused across compilation calls.

```ts
import { compile, createProfile, loadProfileContract } from '@altopelago/aeon-profiles';

const policy = loadProfileContract(trustedProfileSource);
const profile = createProfile(policy);
const result = compile(source, { profile });
```

The official `aeon.gp.profile.v1` artifact version `1.1.0` is supported.
Loaded policies supply generic and clarifier rules and expose contract metadata
such as default mode, collection semantics, and capabilities. The usual Core
mode, datatype policy, and resource options still govern each compilation.

Run `pnpm test:cts:gp:next` from `implementations/typescript` to test the
official artifact alongside the built-in TypeScript and WASM profiles against
the same draft cases. `AEONITE_SPECS_ROOT` and `AEONITE_CTS_ROOT` can select the
local specs checkout and CTS manifest directory. The runner verifies the
artifact against the specs registry before loading it.

## Example

```ts
import { compile, createDefaultRegistry } from '@altopelago/aeon-profiles';

const result = compile(source, {
  profile: 'core',
  registry: createDefaultRegistry(),
  mode: 'strict',
});
```
