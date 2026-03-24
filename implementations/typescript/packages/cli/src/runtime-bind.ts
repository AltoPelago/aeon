import {
  compile as compileProfile,
  createDefaultRegistry,
  type Diagnostic as ProfileDiagnostic,
  type Profile,
  type ProfileRef,
  type ProfileRegistry,
} from '@aeon/profiles';
import { compile as compileCore, type AnnotationRecord } from '@aeon/core';
import { resolveRefs, type AssignmentEvent, type ResolveDiagnostic, type ResolveMeta } from '@aeon/aes';
import { materialize } from '@aeon/tonic';
import {
  finalizeJson,
  finalizeLinkedJson,
  type FinalizeHeader,
  type Diagnostic as FinalizeDiagnostic,
  type FinalizeMeta,
  type FinalizeScope,
  type JsonObject,
} from '@aeon/finalize';
import { validate, type Diag as SchemaDiagnostic, type ResultEnvelope, type SchemaV1 } from '@aeos/core';

type RuntimeMode = 'strict' | 'loose';
type RuntimeOutput = 'json' | 'linked-json';

interface RuntimeDiagnostic {
  readonly level: 'error' | 'warning';
  readonly phase: 5 | 6 | 7 | 8;
  readonly phaseLabel: 'Profile Compilation' | 'Schema Validation' | 'Reference Resolution' | 'Finalization';
  readonly message: string;
  readonly code?: string;
  readonly path?: string;
  readonly span?: unknown;
}

interface RuntimeMeta {
  readonly errors: readonly RuntimeDiagnostic[];
  readonly warnings: readonly RuntimeDiagnostic[];
  readonly profileId?: string;
  readonly version?: string;
  readonly schema?: ResultEnvelope;
  readonly resolution?: ResolveMeta;
  readonly finalization?: FinalizeMeta;
}

interface RuntimeResult {
  readonly aes: readonly AssignmentEvent[];
  readonly annotations?: readonly AnnotationRecord[];
  readonly document?: JsonObject;
  readonly meta: RuntimeMeta;
}

interface TypedRuntimeOptions<TDocument> {
  readonly mode?: RuntimeMode;
  readonly preset?: 'rich';
  readonly datatypePolicy?: 'reserved_only' | 'allow_custom';
  readonly profile?: ProfileRef;
  readonly registry?: ProfileRegistry;
  readonly schema: SchemaV1;
  readonly output?: RuntimeOutput;
  readonly materialization?: 'all' | 'projected';
  readonly includePaths?: readonly string[];
  readonly scope?: FinalizeScope;
  readonly includeAnnotations?: boolean;
  readonly maxInputBytes?: number;
  readonly maxAttributeDepth?: number;
  readonly maxSeparatorDepth?: number;
  readonly maxGenericDepth?: number;
  readonly trailingSeparatorDelimiterPolicy?: 'off' | 'warn' | 'error';
  readonly guard?: (value: unknown) => value is TDocument;
}

interface TypedRuntimeResult<TDocument> extends Omit<RuntimeResult, 'document'> {
  readonly document?: TDocument;
}

function asDiag(
  level: 'error' | 'warning',
  phase: 5 | 6 | 7 | 8,
  source: { message: string; code?: string; path?: string; span?: unknown },
): RuntimeDiagnostic {
  const phaseLabel =
    phase === 5
      ? 'Profile Compilation'
      : phase === 6
        ? 'Schema Validation'
        : phase === 7
          ? 'Reference Resolution'
          : 'Finalization';
  return {
    level,
    phase,
    phaseLabel,
    message: source.message,
    ...(source.code !== undefined ? { code: source.code } : {}),
    ...(source.path !== undefined ? { path: source.path } : {}),
    ...(source.span !== undefined ? { span: source.span } : {}),
  };
}

function resolveProfile(profile: ProfileRef | undefined, registry: ProfileRegistry): Profile | null {
  if (!profile) return registry.get('altopelago.core.v1') ?? null;
  if (typeof profile === 'string') return registry.get(profile) ?? null;
  return profile;
}

function stripProfileProcessors(profile: Profile): Profile {
  return {
    id: profile.id,
    ...(profile.version !== undefined ? { version: profile.version } : {}),
    compile: profile.compile,
  };
}

function appendProfileDiagnostics(
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
  diagnostics: readonly ProfileDiagnostic[] | undefined,
): void {
  if (!diagnostics) return;
  for (const diag of diagnostics) {
    if (diag.level === 'error') {
      errors.push(asDiag('error', 5, diag));
    } else {
      warnings.push(asDiag('warning', 5, diag));
    }
  }
}

function appendSchemaDiagnostics(
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
  diagnostics: readonly SchemaDiagnostic[],
  level: 'error' | 'warning',
): void {
  for (const diag of diagnostics) {
    const target = level === 'error' ? errors : warnings;
    target.push(asDiag(level, 6, {
      message: diag.message,
      code: diag.code,
      path: diag.path,
      span: diag.span,
    }));
  }
}

function appendResolveDiagnostics(
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
  diagnostics: readonly ResolveDiagnostic[] | undefined,
  level: 'error' | 'warning',
): void {
  if (!diagnostics) return;
  for (const diag of diagnostics) {
    const target = level === 'error' ? errors : warnings;
    target.push(asDiag(level, 7, diag));
  }
}

function appendFinalizeDiagnostics(
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
  diagnostics: readonly FinalizeDiagnostic[] | undefined,
  level: 'error' | 'warning',
): void {
  if (!diagnostics) return;
  for (const diag of diagnostics) {
    const target = level === 'error' ? errors : warnings;
    target.push(asDiag(level, 8, diag));
  }
}

function runRuntime(input: string, options: Omit<TypedRuntimeOptions<unknown>, 'guard' | 'schema'> & { schema?: SchemaV1 }): RuntimeResult {
  const mode = options.mode ?? 'strict';
  const output = options.output ?? 'json';
  const datatypePolicy = options.datatypePolicy ?? (options.preset === 'rich' ? 'allow_custom' : undefined);
  const includeAnnotations = options.includeAnnotations ?? false;
  const scope = options.scope ?? 'payload';
  const maxInputBytes = options.maxInputBytes;
  const maxAttributeDepth = options.maxAttributeDepth ?? 1;
  const maxSeparatorDepth = options.maxSeparatorDepth ?? 1;
  const maxGenericDepth = options.maxGenericDepth ?? 1;

  const errors: RuntimeDiagnostic[] = [];
  const warnings: RuntimeDiagnostic[] = [];

  const registry = options.registry ?? createDefaultRegistry();
  const profile = resolveProfile(options.profile, registry);

  if (!profile) {
    errors.push(asDiag('error', 5, {
      message: `Unknown profile: ${String(options.profile ?? 'altopelago.core.v1')}`,
      code: 'PROFILE_NOT_FOUND',
    }));
    return { aes: [], meta: { errors, warnings } };
  }

  if (profile.processors && profile.processors.length > 0) {
    warnings.push(asDiag('warning', 5, {
      message: `Profile '${profile.id}' processors were skipped to enforce phase order (schema before resolve).`,
      code: 'PROFILE_PROCESSORS_SKIPPED',
    }));
  }

  const compileResult = compileProfile(input, {
    profile: stripProfileProcessors(profile),
    registry,
    mode,
    ...(datatypePolicy ? { datatypePolicy } : {}),
    ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
    maxAttributeDepth,
    maxSeparatorDepth,
    maxGenericDepth,
  });

  const needCoreMetadata = includeAnnotations || scope !== 'payload';
  const coreResult = needCoreMetadata
    ? compileCore(input, {
        recovery: mode === 'loose',
        ...(datatypePolicy ? { datatypePolicy } : {}),
        ...(maxInputBytes !== undefined ? { maxInputBytes } : {}),
        maxAttributeDepth,
        maxSeparatorDepth,
        maxGenericDepth,
        emitAnnotations: includeAnnotations,
      })
    : null;

  const annotations = includeAnnotations ? (coreResult?.annotations ?? []) : undefined;

  appendProfileDiagnostics(errors, warnings, compileResult.meta?.errors);
  appendProfileDiagnostics(errors, warnings, compileResult.meta?.warnings);

  let aes = compileResult.aes;

  if (mode === 'strict' && errors.length > 0) {
    return {
      aes,
      ...(annotations ? { annotations } : {}),
      meta: {
        errors,
        warnings,
        ...(compileResult.meta?.profileId ? { profileId: compileResult.meta.profileId } : {}),
        ...(compileResult.meta?.version ? { version: compileResult.meta.version } : {}),
      },
    };
  }

  let schemaResult: ResultEnvelope | undefined;
  if (options.schema) {
    schemaResult = validate(aes, options.schema, {
      ...(options.trailingSeparatorDelimiterPolicy !== undefined
        ? { trailingSeparatorDelimiterPolicy: options.trailingSeparatorDelimiterPolicy }
        : {}),
    });
    appendSchemaDiagnostics(errors, warnings, schemaResult.errors, 'error');
    appendSchemaDiagnostics(errors, warnings, schemaResult.warnings, 'warning');

    if (mode === 'strict' && schemaResult.errors.length > 0) {
      return {
        aes,
        ...(annotations ? { annotations } : {}),
        meta: {
          errors,
          warnings,
          ...(compileResult.meta?.profileId ? { profileId: compileResult.meta.profileId } : {}),
          ...(compileResult.meta?.version ? { version: compileResult.meta.version } : {}),
          schema: schemaResult,
        },
      };
    }
  }

  const resolved = resolveRefs(aes, { mode });
  appendResolveDiagnostics(errors, warnings, resolved.meta?.errors, 'error');
  appendResolveDiagnostics(errors, warnings, resolved.meta?.warnings, 'warning');
  aes = resolved.aes;

  const tonicResult = materialize({
    aes,
    ...(annotations ? { annotations } : {}),
  });
  aes = tonicResult.aes;
  const materializedAnnotations = tonicResult.annotations;

  if (mode === 'strict' && resolved.meta?.errors && resolved.meta.errors.length > 0) {
    return {
      aes,
      ...(materializedAnnotations ? { annotations: materializedAnnotations } : {}),
      meta: {
        errors,
        warnings,
        ...(compileResult.meta?.profileId ? { profileId: compileResult.meta.profileId } : {}),
        ...(compileResult.meta?.version ? { version: compileResult.meta.version } : {}),
        ...(schemaResult ? { schema: schemaResult } : {}),
        ...(resolved.meta ? { resolution: resolved.meta } : {}),
      },
    };
  }

  const finalizeOptions = {
    mode,
    ...(options.materialization !== undefined ? { materialization: options.materialization } : {}),
    ...(options.includePaths !== undefined ? { includePaths: options.includePaths } : {}),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(coreResult?.header ? { header: coreResult.header as FinalizeHeader } : {}),
  };
  const finalized = output === 'linked-json'
    ? finalizeLinkedJson(aes, finalizeOptions)
    : finalizeJson(aes, finalizeOptions);
  appendFinalizeDiagnostics(errors, warnings, finalized.meta?.errors, 'error');
  appendFinalizeDiagnostics(errors, warnings, finalized.meta?.warnings, 'warning');

  return {
    aes,
    ...(materializedAnnotations ? { annotations: materializedAnnotations } : {}),
    document: finalized.document,
    meta: {
      errors,
      warnings,
      ...(compileResult.meta?.profileId ? { profileId: compileResult.meta.profileId } : {}),
      ...(compileResult.meta?.version ? { version: compileResult.meta.version } : {}),
      ...(schemaResult ? { schema: schemaResult } : {}),
      ...(resolved.meta ? { resolution: resolved.meta } : {}),
      ...(finalized.meta ? { finalization: finalized.meta } : {}),
    },
  };
}

export function runTypedRuntime<TDocument>(
  input: string,
  options: TypedRuntimeOptions<TDocument>,
): TypedRuntimeResult<TDocument> {
  const mode = options.mode ?? 'strict';
  const base = runRuntime(input, options);

  const errors: RuntimeDiagnostic[] = [...base.meta.errors];
  const warnings: RuntimeDiagnostic[] = [...base.meta.warnings];

  if (base.document === undefined) {
    return {
      aes: base.aes,
      ...(base.annotations !== undefined ? { annotations: base.annotations } : {}),
      meta: {
        ...base.meta,
        errors,
        warnings,
      },
    };
  }

  const candidate = base.document as unknown;
  if (options.guard && !options.guard(candidate)) {
    const diag = asDiag(mode === 'strict' ? 'error' : 'warning', 8, {
      message: 'Typed runtime guard rejected finalized JSON output.',
      code: 'TYPE_GUARD_FAILED',
    });

    if (mode === 'strict') {
      errors.push(diag);
      return {
        aes: base.aes,
        ...(base.annotations !== undefined ? { annotations: base.annotations } : {}),
        meta: {
          ...base.meta,
          errors,
          warnings,
        },
      };
    }

    warnings.push(diag);
  }

  return {
    aes: base.aes,
    ...(base.annotations !== undefined ? { annotations: base.annotations } : {}),
    document: candidate as TDocument,
    meta: {
      ...base.meta,
      errors,
      warnings,
    },
  };
}
