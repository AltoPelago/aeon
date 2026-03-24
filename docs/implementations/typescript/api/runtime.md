# Runtime API

Informative status: implementation documentation for `@aeon/runtime`.

## Package

- Module: `@aeon/runtime`
- Entry point: [`implementations/typescript/packages/runtime/src/index.ts`](../../../../implementations/typescript/packages/runtime/src/index.ts)

## Primary entry point

```ts
runRuntime(input, options?)
```

The runtime layer composes profile compilation, optional AEOS validation, reference resolution, tonic materialization, and finalization into a higher-level processing pipeline.

## Options

```ts
interface RuntimeOptions {
  readonly mode?: 'strict' | 'loose';
  readonly preset?: 'rich';
  readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
  readonly profile?: ProfileRef;
  readonly registry?: ProfileRegistry;
  readonly schema?: SchemaV1;
  readonly output?: 'json' | 'linked-json' | 'map' | 'node';
  readonly materialization?: 'all' | 'projected';
  readonly includePaths?: readonly string[];
  readonly scope?: 'payload' | 'header' | 'full';
  readonly includeAnnotations?: boolean;
  readonly maxInputBytes?: number;
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
  readonly trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
}
```

## Result shape

```ts
interface RuntimeResult {
  readonly aes: readonly AssignmentEvent[];
  readonly annotations?: readonly AnnotationRecord[];
  readonly document?: JsonObject | FinalizedMap | FinalizedNodeDocument;
  readonly meta: RuntimeMeta;
}
```

## Behavior

- `preset: 'rich'` maps to `datatypePolicy: 'allow_custom'` unless explicitly overridden.
- `schema` enables AEOS validation in the runtime flow.
- `output` selects JSON, linked JSON, map, or node finalization output.
- `includeAnnotations` adds structured annotations to the result.
- projected materialization is controlled with `materialization` and `includePaths`.
- `scope` selects payload-only, header-only, or `{ header, payload }` finalization views.
- `linked-json` is the opt-in live materialization mode for `~>` pointer aliases.

## Typed runtime variant

The package also exposes typed runtime options/results for guarded JSON output:

- `TypedRuntimeOptions<TDocument>`
- `TypedRuntimeResult<TDocument>`

## Notes

- This is a higher-level implementation API, not part of AEON Core syntax.
- It is the clearest place to document end-to-end implementation processing outside the normative spec.
