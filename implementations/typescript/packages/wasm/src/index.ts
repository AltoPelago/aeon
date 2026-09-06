export interface ProcessOptions {
  validationMode?: 'strict' | 'custom' | 'loose' | 'none';
  maxClarifierValues?: number;
  /** @deprecated Use maxClarifierValues. */
  maxSeparatorDepth?: number;
  maxAttributeDepth?: number;
  maxGenericDepth?: number;
  maxGenericArguments?: number;
  maxDatatypeComponents?: number;
  materializationMode?: 'all' | 'projected';
  finalizeScope?: 'payload' | 'header' | 'full';
  includePaths?: string[];
}

export interface TelexOptions {
  registeredFields?: string[];
  maxInputBytes?: number;
  maxLineBytes?: number;
  maxFieldsPerEvent?: number;
  maxEvents?: number;
  maxDecodedPayloadBytes?: number;
  maxPathDepth?: number;
  maxPathCharacters?: number;
  maxGenericDepth?: number;
  maxGenericArguments?: number;
  maxClarifierValues?: number;
  maxDatatypeComponents?: number;
}

export interface TelexDiagnostic {
  code: string;
  message: string;
  record: number | null;
  path: string | null;
  field: string | null;
  firstRecord: number | null;
  requiredPath: string | null;
  counter: string | null;
  observed: number | null;
  limit: number | null;
}

export interface TelexValidationResult {
  valid: boolean;
  profile: string;
  diagnostics: TelexDiagnostic[];
}

export interface MissingTelexPath {
  field?: 'header';
  path: string;
  requiredBy: string;
}

export interface TelexCompletenessResult {
  complete: boolean;
  missing: MissingTelexPath[];
}

export class TelexWasmError extends Error {
  readonly code: string;
  readonly line: number | null;
  readonly counter: string | null;
  readonly observed: number | null;
  readonly limit: number | null;

  constructor(details: {
    code?: string;
    line?: number | null;
    message?: string;
    counter?: string | null;
    observed?: number | null;
    limit?: number | null;
  }) {
    super(details.message ?? 'Telex WASM operation failed');
    this.name = 'TelexWasmError';
    this.code = details.code ?? 'TELEX_WASM_ERROR';
    this.line = details.line ?? null;
    this.counter = details.counter ?? null;
    this.observed = details.observed ?? null;
    this.limit = details.limit ?? null;
  }
}

export interface Position {
  line: number;
  column: number;
  offset: number;
}

export interface Span {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  code: string;
  path: string | null;
  span: Span | null;
  phase: string;
  message: string;
}

export interface AnnotationTarget {
  kind: 'path' | 'unbound';
  path?: string;
  reason?: string;
}

export interface AnnotationRecord {
  kind: string;
  form: string;
  subtype: string | null;
  raw: string;
  span: Span;
  target: AnnotationTarget;
  placement: { after?: string; before?: string } | null;
}

export interface EventSummary {
  path: string;
  key: string;
  datatype: string | null;
  valueType: string;
}

export interface NormalizedCanonical {
  text: string;
}

export interface NormalizedFinalized {
  document: unknown | null;
}

export interface NormalizedDiagnostics {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export interface ProcessResult {
  engine: 'rust-wasm';
  ok: boolean;
  canonical: NormalizedCanonical;
  finalized: NormalizedFinalized;
  annotations: AnnotationRecord[];
  events: EventSummary[];
  diagnostics: NormalizedDiagnostics;
  /** Convenience alias for diagnostics.errors. */
  errors: Diagnostic[];
  /** Convenience alias for diagnostics.warnings. */
  warnings: Diagnostic[];
}

interface RustWasmProcessResult {
  canonical: string;
  finalized: unknown | null;
  annotations: AnnotationRecord[];
  events: EventSummary[];
  warnings: Diagnostic[];
  errors: Diagnostic[];
}

export interface AeonWasmRuntime {
  processAeon(source: string, options?: ProcessOptions): ProcessResult;
  validateTelex(source: string, options?: TelexOptions): TelexValidationResult;
  canonicalizeTelex(source: string, options?: TelexOptions): string;
  checkTelexCompleteness(source: string, options?: TelexOptions): TelexCompletenessResult;
}

interface GeneratedAeonWasmModule {
  default: (initInput?: unknown) => Promise<unknown>;
  process_aeon(source: string, optionsJson: string): string;
  validate_telex(source: string, optionsJson: string): string;
  canonicalize_telex(source: string, optionsJson: string): string;
  check_telex_completeness(source: string, optionsJson: string): string;
}

let runtimePromise: Promise<AeonWasmRuntime> | undefined;

export async function loadAeonWasm(initInput?: unknown): Promise<AeonWasmRuntime> {
  runtimePromise ??= loadGeneratedModule(initInput);
  return runtimePromise;
}

export async function processAeon(
  source: string,
  options: ProcessOptions = {},
): Promise<ProcessResult> {
  const runtime = await loadAeonWasm();
  return runtime.processAeon(source, options);
}

export async function validateTelex(
  source: string,
  options: TelexOptions = {},
): Promise<TelexValidationResult> {
  const runtime = await loadAeonWasm();
  return runtime.validateTelex(source, options);
}

export async function canonicalizeTelex(
  source: string,
  options: TelexOptions = {},
): Promise<string> {
  const runtime = await loadAeonWasm();
  return runtime.canonicalizeTelex(source, options);
}

export async function checkTelexCompleteness(
  source: string,
  options: TelexOptions = {},
): Promise<TelexCompletenessResult> {
  const runtime = await loadAeonWasm();
  return runtime.checkTelexCompleteness(source, options);
}

async function loadGeneratedModule(initInput: unknown): Promise<AeonWasmRuntime> {
  let module: GeneratedAeonWasmModule;

  try {
    module = await import('../pkg/aeon_wasm.js') as GeneratedAeonWasmModule;
  } catch (error) {
    throw new Error(
      'AEON WASM package has not been built. Run `pnpm --filter @altopelago/aeon-wasm build:wasm` first.',
      { cause: error },
    );
  }

  await module.default({
    module_or_path: initInput ?? new URL('../pkg/aeon_wasm_bg.wasm', import.meta.url),
  });

  return {
    processAeon(source: string, options: ProcessOptions = {}): ProcessResult {
      return parseProcessResult(module.process_aeon(source, JSON.stringify(options)));
    },
    validateTelex(source: string, options: TelexOptions = {}): TelexValidationResult {
      return parseTelexResult<TelexValidationResult>(
        invokeTelex(() => module.validate_telex(source, JSON.stringify(options))),
      );
    },
    canonicalizeTelex(source: string, options: TelexOptions = {}): string {
      return invokeTelex(() => module.canonicalize_telex(source, JSON.stringify(options)));
    },
    checkTelexCompleteness(source: string, options: TelexOptions = {}): TelexCompletenessResult {
      return parseTelexResult<TelexCompletenessResult>(
        invokeTelex(() => module.check_telex_completeness(source, JSON.stringify(options))),
      );
    },
  };
}

function invokeTelex(operation: () => string): string {
  try {
    return operation();
  } catch (error) {
    const message = typeof error === 'string'
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
    try {
      throw new TelexWasmError(JSON.parse(message) as ConstructorParameters<typeof TelexWasmError>[0]);
    } catch (parseError) {
      if (parseError instanceof TelexWasmError) throw parseError;
      throw new TelexWasmError({ message });
    }
  }
}

function parseTelexResult<Result>(json: string): Result {
  return JSON.parse(json) as Result;
}

function parseProcessResult(json: string): ProcessResult {
  return normalizeProcessResult(JSON.parse(json) as RustWasmProcessResult);
}

function normalizeProcessResult(raw: RustWasmProcessResult): ProcessResult {
  const errors = raw.errors.map(normalizeDiagnostic);
  const warnings = raw.warnings.map(normalizeDiagnostic);

  return {
    engine: 'rust-wasm',
    ok: errors.length === 0,
    canonical: { text: raw.canonical },
    finalized: { document: raw.finalized },
    annotations: raw.annotations.map(normalizeAnnotation),
    events: raw.events.map(normalizeEvent),
    diagnostics: { errors, warnings },
    errors,
    warnings,
  };
}

function normalizeDiagnostic(diagnostic: Diagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    path: diagnostic.path ?? null,
    span: diagnostic.span ?? null,
    phase: diagnostic.phase,
    message: diagnostic.message,
  };
}

function normalizeAnnotation(annotation: AnnotationRecord): AnnotationRecord {
  return {
    kind: annotation.kind,
    form: annotation.form,
    subtype: annotation.subtype ?? null,
    raw: annotation.raw,
    span: annotation.span,
    target: annotation.target,
    placement: annotation.placement ?? null,
  };
}

function normalizeEvent(event: EventSummary): EventSummary {
  return {
    path: event.path,
    key: event.key,
    datatype: event.datatype ?? null,
    valueType: event.valueType,
  };
}
