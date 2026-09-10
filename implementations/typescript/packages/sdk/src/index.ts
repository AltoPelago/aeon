import {
  compile,
  compileToTelex,
  aeonCompileLimits,
  encodeTelex,
  effectiveTelexConfiguration,
  formatPath,
  parseTelex,
  validateTelex,
  type CompileOptions,
  type CompileResult,
  type CompileToTelexOptions,
  type CompileToTelexResult,
  type AeonicLimitsV1,
  type EffectiveTelexConfiguration,
  type FinalizationLimits,
  type ParsedTelex,
  type PortableAesEvent,
  type TelexEncodeOptions,
  type TelexRecord,
  type TelexLimitOptions,
  type TelexValidationOptions,
  type TelexValidationResult,
} from '@altopelago/aeon-core';
import {
  finalizeJson,
  finalizePortableJson,
  type FinalizeJsonResult,
  type FinalizeOptions,
  type FinalizePortableJsonOptions,
} from '@altopelago/aeon-finalize';
import { emitFromObject, type EmitObjectOptions, type EmitResult } from '@altopelago/aeon-canonical';

export interface ReadAeonOptions {
  readonly compile?: CompileOptions;
  readonly finalize?: FinalizeOptions;
}

export interface ReadAeonResult {
  readonly compile: CompileResult;
  readonly finalized: FinalizeJsonResult;
}

export interface ReadAeonCheckedResult extends ReadAeonResult {
  readonly eventsByPath: ReadonlyMap<string, CompileResult['events'][number]>;
}

export interface ReadTelexResult {
  readonly parsed: ParsedTelex;
  readonly records: ParsedTelex['records'];
  readonly validation: TelexValidationResult;
  readonly effectiveLimits?: EffectiveTelexConfiguration;
}

export interface ReadTelexOptions extends TelexValidationOptions {
  /** Trusted, consumer-selected common limits document. */
  readonly aeonicLimits?: AeonicLimitsV1;
}

export interface ReadTelexDocumentOptions {
  readonly telex?: TelexValidationOptions;
  readonly finalize?: Omit<FinalizePortableJsonOptions, 'profile' | 'projection'>;
  /** Trusted, consumer-selected common limits document. */
  readonly aeonicLimits?: AeonicLimitsV1;
}

export interface ReadTelexDocumentResult extends ReadTelexResult {
  readonly finalized: FinalizeJsonResult;
}

export interface AeonToTelexOptions extends CompileToTelexOptions {
  /** Trusted, consumer-selected common limits document. */
  readonly aeonicLimits?: AeonicLimitsV1;
}

export interface AeonToTelexResult extends CompileToTelexResult {
  readonly effectiveLimits?: EffectiveTelexConfiguration;
}

export function readAeon(input: string, options: ReadAeonOptions = {}): ReadAeonResult {
  const compileResult = compile(input, {
    ...(options.compile ?? {}),
  });

  const finalized = finalizeJson(compileResult.events, {
    mode: 'strict',
    ...(options.finalize ?? {}),
    ...(compileResult.header ? { header: compileResult.header } : {}),
  });

  return {
    compile: compileResult,
    finalized,
  };
}

export function indexEventsByPath(events: readonly CompileResult['events'][number][]): ReadonlyMap<string, CompileResult['events'][number]> {
  return new Map(events.map((event) => [formatPath(event.path), event]));
}

export function readAeonChecked(input: string, options: ReadAeonOptions = {}): ReadAeonCheckedResult {
  const result = readAeon(input, options);
  if (result.compile.errors.length > 0) {
    const summary = result.compile.errors.map((error) => `${error.code}: ${error.message}`).join('\n');
    throw new Error(`AEON compile failed with ${result.compile.errors.length} error(s):\n${summary}`);
  }

  const finalizeErrors = result.finalized.meta?.errors ?? [];
  if (finalizeErrors.length > 0) {
    const summary = finalizeErrors.map((error) => error.message).join('\n');
    throw new Error(`AEON finalize failed with ${finalizeErrors.length} error(s):\n${summary}`);
  }

  return {
    ...result,
    eventsByPath: indexEventsByPath(result.compile.events),
  };
}

export function readAeonStrictCustom(input: string): ReadAeonCheckedResult {
  return readAeonChecked(input, {
    compile: { datatypePolicy: 'allow_custom' },
    finalize: { mode: 'strict' },
  });
}

export function writeAeon(
  object: Readonly<Record<string, unknown>>,
  options: EmitObjectOptions = {}
): EmitResult {
  return emitFromObject(object, options);
}

/** Decode and validate an interoperable Telex stream. */
export function readTelex(input: string, options: ReadTelexOptions = {}): ReadTelexResult {
  const { aeonicLimits, ...explicit } = options;
  const effectiveLimits = resolveEffectiveTelexConfiguration(aeonicLimits, explicit);
  const codecOptions = effectiveLimits ? { ...effectiveLimits.telex, ...explicit } : explicit;
  const parsed = parseTelex(input, codecOptions);
  const validation = validateTelex(parsed, {
    ...codecOptions,
    profile: parsed.profile,
    projection: parsed.projection,
  });
  return { parsed, records: parsed.records, validation, ...(effectiveLimits ? { effectiveLimits } : {}) };
}

/** Decode Telex and throw when its default or declared AES profile is invalid. */
export function readTelexChecked(input: string, options: ReadTelexOptions = {}): ReadTelexResult {
  const result = readTelex(input, options);
  if (!result.validation.valid) {
    const summary = result.validation.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new Error(`Telex validation failed with ${result.validation.diagnostics.length} error(s):\n${summary}`);
  }
  return result;
}

/** Decode, validate, and materialize a complete Telex stream as JSON. */
export function readTelexDocument(
  input: string,
  options: ReadTelexDocumentOptions = {},
): ReadTelexDocumentResult {
  const effectiveLimits = resolveEffectiveTelexConfiguration(
    options.aeonicLimits,
    options.telex,
    options.finalize,
  );
  const result = readTelex(input, effectiveLimits
    ? { ...effectiveLimits.telex, ...(options.telex ?? {}) }
    : options.telex);
  const finalized = finalizePortableJson(result.records, {
    ...(effectiveLimits?.finalization ?? {}),
    ...(options.finalize ?? {}),
    profile: result.parsed.profile,
    projection: result.parsed.projection,
  });
  return {
    ...result,
    finalized,
    ...(effectiveLimits ? { effectiveLimits } : {}),
  };
}

/** Decode and materialize Telex, throwing on AES or finalization errors. */
export function readTelexDocumentChecked(
  input: string,
  options: ReadTelexDocumentOptions = {},
): ReadTelexDocumentResult {
  const result = readTelexDocument(input, options);
  if (!result.validation.valid) {
    const summary = result.validation.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new Error(`Telex validation failed with ${result.validation.diagnostics.length} error(s):\n${summary}`);
  }
  const finalizeErrors = result.finalized.meta?.errors ?? [];
  if (finalizeErrors.length > 0) {
    const summary = finalizeErrors.map((diagnostic) => `${diagnostic.code ?? 'FINALIZE_ERROR'}: ${diagnostic.message}`).join('\n');
    throw new Error(`Telex finalization failed with ${finalizeErrors.length} error(s):\n${summary}`);
  }
  return result;
}

/** Encode portable AES records as a Telex stream. */
export function writeTelex(
  records: readonly (TelexRecord | PortableAesEvent)[],
  options: TelexEncodeOptions = {},
): string {
  return encodeTelex(records, options);
}

/** Compile AEON source and export its portable event stream as Telex. */
export function aeonToTelex(
  input: string,
  options: AeonToTelexOptions = {},
): AeonToTelexResult {
  const { aeonicLimits, ...explicit } = options;
  if (!aeonicLimits) return compileToTelex(input, explicit);

  const effectiveLimits = resolveEffectiveTelexConfiguration(aeonicLimits, explicit.telex);
  const result = compileToTelex(input, {
    ...explicit,
    compile: { ...aeonCompileLimits(aeonicLimits), ...(explicit.compile ?? {}) },
    telex: { ...effectiveLimits?.telex, ...(explicit.telex ?? {}) },
  });
  return { ...result, effectiveLimits: effectiveLimits! };
}

function resolveEffectiveTelexConfiguration(
  limits: AeonicLimitsV1 | undefined,
  telexOverrides: TelexLimitOptions | undefined,
  finalizationOverrides: FinalizationLimits | undefined = undefined,
): EffectiveTelexConfiguration | undefined {
  if (!limits) return undefined;
  const selected = effectiveTelexConfiguration(limits);
  const telex = { ...selected.telex };
  const finalization = { ...selected.finalization };
  let overridesApplied = false;

  for (const key of Object.keys(telex) as (keyof typeof telex)[]) {
    const override = telexOverrides?.[key];
    if (override !== undefined && override !== telex[key]) {
      telex[key] = override;
      overridesApplied = true;
    }
  }
  for (const key of ['maxReferenceDepth', 'maxMaterializedWeight'] as const) {
    const override = finalizationOverrides?.[key];
    if (override !== undefined && override !== finalization[key]) {
      finalization[key] = override;
      overridesApplied = true;
    }
  }

  return { ...selected, telex, finalization, overridesApplied };
}

export { formatPath };

export type {
  CompileOptions,
  CompileResult,
  FinalizeOptions,
  FinalizeJsonResult,
  FinalizePortableJsonOptions,
  EmitObjectOptions,
  EmitResult,
  CompileToTelexOptions,
  CompileToTelexResult,
  ParsedTelex,
  PortableAesEvent,
  TelexEncodeOptions,
  TelexLimitOptions,
  TelexRecord,
  TelexValidationOptions,
  TelexValidationResult,
};
