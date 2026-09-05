import {
  compile,
  compileToTelex,
  encodeTelex,
  formatPath,
  parseTelex,
  validateTelex,
  type CompileOptions,
  type CompileResult,
  type CompileToTelexOptions,
  type CompileToTelexResult,
  type ParsedTelex,
  type PortableAesEvent,
  type TelexEncodeOptions,
  type TelexRecord,
  type TelexLimitOptions,
  type TelexValidationOptions,
  type TelexValidationResult,
} from '@altopelago/aeon-core';
import { finalizeJson, type FinalizeJsonResult, type FinalizeOptions } from '@altopelago/aeon-finalize';
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
}

export function readAeon(input: string, options: ReadAeonOptions = {}): ReadAeonResult {
  const compileResult = compile(input, {
    ...(options.compile ?? {}),
  });

  const finalized = finalizeJson(compileResult.events, {
    mode: 'strict',
    ...(options.finalize ?? {}),
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
export function readTelex(input: string, options: TelexValidationOptions = {}): ReadTelexResult {
  const parsed = parseTelex(input, options);
  const validation = validateTelex(parsed, {
    ...options,
    profile: parsed.profile,
    projection: parsed.projection,
  });
  return { parsed, records: parsed.records, validation };
}

/** Decode Telex and throw when its default or declared AES profile is invalid. */
export function readTelexChecked(input: string, options: TelexValidationOptions = {}): ReadTelexResult {
  const result = readTelex(input, options);
  if (!result.validation.valid) {
    const summary = result.validation.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('\n');
    throw new Error(`Telex validation failed with ${result.validation.diagnostics.length} error(s):\n${summary}`);
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
  options: CompileToTelexOptions = {},
): CompileToTelexResult {
  return compileToTelex(input, options);
}

export { formatPath };

export type {
  CompileOptions,
  CompileResult,
  FinalizeOptions,
  FinalizeJsonResult,
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
