import { compile, formatPath, type CompileOptions, type CompileResult } from '@aeon/core';
import { finalizeJson, type FinalizeJsonResult, type FinalizeOptions } from '@aeon/finalize';
import { emitFromObject, type EmitObjectOptions, type EmitResult } from '@aeon/canonical';

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

export { formatPath };

export type {
  CompileOptions,
  CompileResult,
  FinalizeOptions,
  FinalizeJsonResult,
  EmitObjectOptions,
  EmitResult,
};
