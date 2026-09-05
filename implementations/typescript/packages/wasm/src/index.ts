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
}

interface GeneratedAeonWasmModule {
  default: (initInput?: unknown) => Promise<unknown>;
  process_aeon(source: string, optionsJson: string): string;
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
  };
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
