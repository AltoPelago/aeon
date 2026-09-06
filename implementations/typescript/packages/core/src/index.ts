/**
 * @altopelago/aeon-core - AEON Core Package
 * 
 * The canonical, safe entry point for AEON processing.
 * 
 * Usage:
 * ```ts
 * import { compile } from '@altopelago/aeon-core';
 * 
 * const result = compile('key = "value"');
 * if (result.errors.length === 0) {
 *   console.log(result.events);
 * }
 * ```
 */

import { tokenize, TokenType, type LexerError } from '@altopelago/aeon-lexer';
import { parse, SyntaxError as ParserSyntaxError, type ParserError, type Document, type Value, type Binding } from '@altopelago/aeon-parser';
import {
    resolvePaths,
    emitEvents,
    validateReferences,
    enforceMode,
    formatPath,
    EventEmissionError,
    AEON_DOCUMENT_PROJECTION,
    encodeTelex,
    projectPortableEvents,
    type AssignmentEvent,
    type PortableAesEvent,
    type TelexEncodeOptions,
    type TelexRecord,
    type PathResolutionError,
    type ReferenceValidationError,
    type ModeEnforcementError,
    type DatatypePolicy,
    type Mode,
} from '@altopelago/aeon-aes';
import { buildAnnotationStreamFromSourceAndSpans, type AnnotationRecord } from '@altopelago/aeon-annotation-stream';
export { inspectFilePreamble, type FilePreambleInfo, type HostDirective, type HostDirectiveKind } from './preamble.js';
export * from './limits.js';

// =============================================================================
// PUBLIC API
// =============================================================================

export const VERSION = '0.12.1';

/**
 * Union of all possible AEON errors
 */
export type AEONError =
    | LexerError
    | ParserError
    | PathResolutionError
    | EventEmissionError
    | ReferenceValidationError
    | ModeEnforcementError
    | InputSizeExceededError
    | EventCountExceededError
    | ResourceLimitExceededError;

export interface AEONWarning {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    readonly observed?: number;
    readonly portableFloor?: number;
    readonly policy?: string;
}

export class InputSizeExceededError extends Error {
    readonly code = 'INPUT_SIZE_EXCEEDED';
    readonly actualBytes: number;
    readonly maxBytes: number;

    constructor(actualBytes: number, maxBytes: number) {
        super(`Input size ${actualBytes} bytes exceeds configured limit of ${maxBytes} bytes`);
        this.name = 'InputSizeExceededError';
        this.actualBytes = actualBytes;
        this.maxBytes = maxBytes;
    }
}

export class EventCountExceededError extends Error {
    readonly code = 'EVENT_COUNT_EXCEEDED';
    readonly actualEvents: number;
    readonly maxEvents: number;

    constructor(actualEvents: number, maxEvents: number) {
        super(`Event count ${actualEvents} exceeds configured limit of ${maxEvents}`);
        this.name = 'EventCountExceededError';
        this.actualEvents = actualEvents;
        this.maxEvents = maxEvents;
    }
}

export class ResourceLimitExceededError extends Error {
    readonly code: string;
    readonly counter: string;
    readonly observed: number;
    readonly limit: number;
    readonly span: Document['span'];

    constructor(counter: string, observed: number, limit: number) {
        super(`${counter} observed value ${observed} exceeds configured limit ${limit}`);
        this.name = 'ResourceLimitExceededError';
        this.code = `${counter.replaceAll(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()}_EXCEEDED`;
        this.counter = counter;
        this.observed = observed;
        this.limit = limit;
        const position = { line: 1, column: 1, offset: 0 };
        this.span = { start: position, end: position };
    }
}

/**
 * Compilation result
 */
export interface CompileResult {
    /** Assignment events (empty if any errors occurred unless recovery mode) */
    readonly events: readonly AssignmentEvent[];
    /** All errors from all phases */
    readonly errors: readonly AEONError[];
    /** Non-fatal portability and policy warnings */
    readonly warnings: readonly AEONWarning[];
    /** Parsed header metadata for downstream projection/finalization. */
    readonly header?: {
        readonly fields: ReadonlyMap<string, Value>;
        readonly span: Document['span'];
        readonly form: 'structured' | 'shorthand';
    };
    /** Structured comment records emitted in parallel when enabled */
    readonly annotations?: readonly AnnotationRecord[];
}

/**
 * Compilation options
 */
export interface CompileOptions {
    /** 
     * Enable recovery mode: emit partial events even if errors exist.
     * Default: false (fail-closed - no events on any error)
     * 
     * WARNING: Recovery mode should only be used for tooling (e.g., IDE support).
     * For production processing, always use fail-closed (default).
     */
    readonly recovery?: boolean;
    /** Maximum number of attribute segments in a reference path (default: 1). */
    readonly maxAttributeDepth?: number;
    /** Maximum clarifier values on one datatype descriptor (default: 1). */
    readonly maxClarifierValues?: number;
    /** @deprecated Use maxClarifierValues. */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for nested generic type annotations (default: 1). */
    readonly maxGenericDepth?: number;
    /** Maximum generic arguments on one datatype descriptor (default: 32). */
    readonly maxGenericArguments?: number;
    /** Maximum aggregate components in one recursive datatype (default: 64). */
    readonly maxDatatypeComponents?: number;
    /** Maximum container nesting depth for objects, lists, tuples, and nodes (default: 256). */
    readonly maxValueNestingDepth?: number;
    /** @deprecated Use maxValueNestingDepth. */
    readonly maxNestingDepth?: number;
    /** Maximum canonical address structural-step depth (default: 1024). */
    readonly maxPathDepth?: number;
    /** Maximum decoded string length in Unicode code points (default: 1048576). */
    readonly maxStringCodepoints?: number;
    /** Maximum decoded key segment length in Unicode code points (default: 1024). */
    readonly maxKeySegmentCodepoints?: number;
    /** Maximum direct items in one list (default: 65536). */
    readonly maxListItems?: number;
    /** Maximum direct items in one tuple (default: 65536). */
    readonly maxTupleItems?: number;
    /** Maximum canonical/reference path length in Unicode code points (default: 8192). */
    readonly maxPathCharacters?: number;
    /** Maximum raw AEON numeric literal length (default: 1024). */
    readonly maxNumericLiteralCharacters?: number;
    /** Maximum structured-comment payload length (default: 1048576). */
    readonly maxStructuredCommentCharacters?: number;
    /** Emit structured annotation stream records. Default: true. */
    readonly emitAnnotations?: boolean;
    /** Datatype policy in strict mode. Default: reserved_only */
    readonly datatypePolicy?: DatatypePolicy;
    /**
     * Consumer-selected effective mode. When omitted, Core honors aeon:mode
     * declared in the document for backwards-compatible authoring flows.
     */
    readonly mode?: Mode;
    /** Maximum UTF-8 input size in bytes. Fail-closed when exceeded. */
    readonly maxInputBytes?: number;
    /** Maximum number of AES events Core may emit. Fail-closed when exceeded. */
    readonly maxEvents?: number;
}

export interface CompileToTelexOptions {
    /** Options for the existing AEON compilation pipeline. */
    readonly compile?: CompileOptions;
    /** Telex encoding and resource-limit options. */
    readonly telex?: TelexEncodeOptions;
    /** Include AEON document headers in the explicit header plane. Default: false. */
    readonly includeHeaders?: boolean;
}

export interface ExportTelexOptions extends TelexEncodeOptions {
    /** Include AEON document headers in the explicit header plane. Default: false. */
    readonly includeHeaders?: boolean;
}

export interface CompileToTelexResult {
    /** The unchanged Core compilation result. */
    readonly compile: CompileResult;
    /** Portable AES records in source event order. */
    readonly records: readonly (TelexRecord | PortableAesEvent)[];
    /** Encoded Telex, or null when compilation failed. */
    readonly telex: string | null;
}

/**
 * Compile an AEON document into Assignment Events
 * 
 * This is the canonical, safe entry point for AEON processing.
 * It runs all phases (lex → parse → resolve → emit → validate → enforce)
 * and returns a deterministic result.
 * 
 * **Fail-closed behavior**: If ANY error occurs in ANY phase,
 * the returned events array will be empty. Errors are always collected
 * and returned for diagnostics.
 * 
 * @param input - AEON document source text
 * @param options - Optional compilation settings
 * @returns Compilation result with events and errors
 * 
 * @example
 * ```ts
 * const result = compile('config = { port = 8080 }');
 * if (result.errors.length === 0) {
 *   for (const event of result.events) {
 *     console.log(event.path, event.value);
 *   }
 * }
 * ```
 */
export function compile(input: string, options: CompileOptions = {}): CompileResult {
    const allErrors: AEONError[] = [];
    const recovery = options.recovery ?? false;
    const maxAttributeDepth = options.maxAttributeDepth ?? 1;
    const maxClarifierValues = options.maxClarifierValues ?? options.maxSeparatorDepth ?? 1;
    const maxGenericDepth = options.maxGenericDepth ?? 1;
    const maxGenericArguments = options.maxGenericArguments ?? 32;
    const maxDatatypeComponents = options.maxDatatypeComponents ?? 64;
    const maxValueNestingDepth = options.maxValueNestingDepth ?? options.maxNestingDepth ?? 256;
    const maxPathDepth = options.maxPathDepth ?? 1024;
    const maxStringCodepoints = options.maxStringCodepoints ?? 1_048_576;
    const maxKeySegmentCodepoints = options.maxKeySegmentCodepoints ?? 1024;
    const maxListItems = options.maxListItems ?? 65_536;
    const maxTupleItems = options.maxTupleItems ?? 65_536;
    const maxPathCharacters = options.maxPathCharacters ?? 8192;
    const maxNumericLiteralCharacters = options.maxNumericLiteralCharacters ?? 1024;
    const maxStructuredCommentCharacters = options.maxStructuredCommentCharacters ?? 1_048_576;
    const emitAnnotations = options.emitAnnotations ?? true;
    const datatypePolicy = options.datatypePolicy;
    const maxInputBytes = options.maxInputBytes;
    const maxEvents = options.maxEvents;
    const warnings = compilePortabilityWarnings(options);

    if (maxInputBytes !== undefined) {
        const actualBytes = Buffer.byteLength(input, 'utf8');
        if (actualBytes > maxInputBytes) {
            allErrors.push(new InputSizeExceededError(actualBytes, maxInputBytes));
            return { events: [], errors: allErrors, warnings };
        }
    }

    input = stripLeadingBom(input);

    // Phase 1: Lexing
    const lexResult = tokenize(input, { includeComments: false });
    allErrors.push(...normalizeLexerErrors(input, lexResult.errors));
    if (lexResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors, warnings };
    }

    // Phase 2: Parsing
    const parseResult = parse(lexResult.tokens, {
        maxAttributeDepth,
        maxClarifierValues,
        maxGenericDepth,
        maxGenericArguments,
        maxDatatypeComponents,
        maxValueNestingDepth,
    });
    allErrors.push(...parseResult.errors);
    if (parseResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors, warnings };
    }
    if (!parseResult.document) {
        return { events: [], errors: allErrors, warnings };
    }

    const structureError = validateSourceStructure(parseResult.document, {
        maxStringCodepoints,
        maxKeySegmentCodepoints,
        maxListItems,
        maxTupleItems,
        maxNumericLiteralCharacters,
        maxPathDepth,
        maxPathCharacters,
    });
    if (structureError) {
        allErrors.push(structureError);
        return { events: [], errors: allErrors, warnings };
    }
    const structuredCommentError = validateStructuredComments(input, maxStructuredCommentCharacters);
    if (structuredCommentError) {
        allErrors.push(structuredCommentError);
        return { events: [], errors: allErrors, warnings };
    }

    // Phase 3: Path Resolution
    const resolveResult = resolvePaths(parseResult.document, { indexedPaths: true });
    allErrors.push(...resolveResult.errors);
    if (resolveResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors, warnings };
    }
    for (const binding of resolveResult.bindings) {
        const depth = Math.max(0, binding.path.segments.length - 1);
        if (depth > maxPathDepth) {
            allErrors.push(new ResourceLimitExceededError('max_path_depth', depth, maxPathDepth));
            return { events: [], errors: allErrors, warnings };
        }
        const characters = [...formatPath(binding.path)].length;
        if (characters > maxPathCharacters) {
            allErrors.push(new ResourceLimitExceededError('max_path_characters', characters, maxPathCharacters));
            return { events: [], errors: allErrors, warnings };
        }
    }

    // Phase 4: Event Emission
    const emitResult = emitEvents(resolveResult, { recovery });
    for (const err of emitResult.errors) {
        if (err instanceof EventEmissionError) {
            allErrors.push(err);
        }
    }
    if (emitResult.errors.length > 0 && !recovery && emitResult.events.length === 0) {
        return { events: [], errors: allErrors, warnings };
    }
    if (maxEvents !== undefined && emitResult.events.length > maxEvents) {
        allErrors.push(new EventCountExceededError(emitResult.events.length, maxEvents));
        return { events: [], errors: allErrors, warnings };
    }

    // Phase 5: Reference Validation
    const refResult = validateReferences(emitResult.events, { recovery, maxAttributeDepth });
    allErrors.push(...refResult.errors);
    if (refResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors, warnings };
    }

    // Phase 6: Mode Enforcement
    const modeResult = enforceMode(refResult.events, parseResult.document.header, {
        recovery,
        ...(options.mode ? { mode: options.mode } : {}),
        ...(datatypePolicy ? { datatypePolicy } : {}),
    });
    allErrors.push(...modeResult.errors);
    if (modeResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors, warnings };
    }

    const result: CompileResult = {
        events: modeResult.events,
        errors: allErrors,
        warnings,
        ...(parseResult.document.header
            ? {
                header: {
                    fields: parseResult.document.header.fields,
                    span: parseResult.document.header.span,
                    form: parseResult.document.header.form,
                },
            }
            : {}),
    };

    if (emitAnnotations) {
        const spanTargets = collectSpanTargets(parseResult.document);
        (result as { annotations: readonly AnnotationRecord[] }).annotations =
            buildAnnotationStreamFromSourceAndSpans(input, modeResult.events, spanTargets);
    }

    return result;
}

/**
 * Compile AEON source and export its portable AES event stream as Telex.
 *
 * This is an additive boundary API: `compile()` remains the native in-memory
 * workflow, while this helper produces an interoperable stream for another
 * process or implementation.
 */
export function compileToTelex(
    input: string,
    options: CompileToTelexOptions = {},
): CompileToTelexResult {
    const compileResult = compile(input, options.compile);
    if (compileResult.errors.length > 0) {
        return { compile: compileResult, records: [], telex: null };
    }

    const records = projectAssignmentEventsToTelex(compileResult.events, options.includeHeaders ?? false);
    const telexOptions: ExportTelexOptions = {
        ...options.telex,
        ...(options.includeHeaders !== undefined ? { includeHeaders: options.includeHeaders } : {}),
    };

    return {
        compile: compileResult,
        records,
        telex: exportTelex(compileResult.events, telexOptions),
    };
}

/** Export existing Core assignment events without recompiling their source. */
export function exportTelex(
    events: readonly AssignmentEvent[],
    options: ExportTelexOptions = {},
): string {
    const includeHeaders = options.includeHeaders ?? false;
    const { includeHeaders: _includeHeaders, ...encodeOptions } = options;
    return encodeTelex(projectAssignmentEventsToTelex(events, includeHeaders), includeHeaders
        ? { ...encodeOptions, projection: AEON_DOCUMENT_PROJECTION }
        : encodeOptions);
}

function projectAssignmentEventsToTelex(
    events: readonly AssignmentEvent[],
    includeHeaders: boolean,
): readonly (TelexRecord | PortableAesEvent)[] {
    const isHeaderEvent = (event: AssignmentEvent): boolean => {
        const first = event.path.segments[1];
        return first?.type === 'member' && first.key.startsWith('aeon:');
    };
    const bodyRecords = projectPortableEvents(events.filter((event) => !isHeaderEvent(event)));
    const headerRecords: TelexRecord[] = includeHeaders
        ? projectPortableEvents(events.filter(isHeaderEvent)).map((record: PortableAesEvent) => {
            const { path, ...fields } = record;
            return { header: path, ...fields };
        })
        : [];
    return [...headerRecords, ...bodyRecords];
}

function compilePortabilityWarnings(options: {
    readonly maxAttributeDepth?: number;
    readonly maxClarifierValues?: number;
    readonly maxSeparatorDepth?: number;
    readonly maxGenericDepth?: number;
    readonly maxGenericArguments?: number;
    readonly maxDatatypeComponents?: number;
    readonly maxValueNestingDepth?: number;
    readonly maxNestingDepth?: number;
    readonly maxEvents?: number;
}): AEONWarning[] {
    const warnings: AEONWarning[] = [];
    if (options.maxAttributeDepth !== undefined) {
        warnIfAbove(warnings, 'AEON_NON_PORTABLE_POLICY_DEPTH', 'maxAttributeDepth', options.maxAttributeDepth, 8);
    }
    const maxClarifierValues = options.maxClarifierValues ?? options.maxSeparatorDepth;
    if (maxClarifierValues !== undefined) {
        warnIfAbove(warnings, 'AEON_NON_PORTABLE_CLARIFIER_VALUES', 'maxClarifierValues', maxClarifierValues, 8);
    }
    if (options.maxGenericDepth !== undefined) {
        warnIfAbove(warnings, 'AEON_NON_PORTABLE_POLICY_DEPTH', 'maxGenericDepth', options.maxGenericDepth, 8);
    }
    const maxValueNestingDepth = options.maxValueNestingDepth ?? options.maxNestingDepth;
    if (maxValueNestingDepth !== undefined) {
        warnIfAbove(warnings, 'AEON_NON_PORTABLE_CONTAINER_NESTING_DEPTH', 'maxValueNestingDepth', maxValueNestingDepth, 64);
    }
    if (options.maxEvents !== undefined) {
        warnIfAbove(warnings, 'AEON_NON_PORTABLE_EVENT_BUDGET', 'maxEvents', options.maxEvents, 100_000);
    }
    return warnings;
}

function warnIfAbove(
    warnings: AEONWarning[],
    code: string,
    policy: string,
    observed: number,
    portableFloor: number,
): void {
    if (observed <= portableFloor) return;
    warnings.push({
        code,
        path: '$',
        policy,
        observed,
        portableFloor,
        message: `${policy} ${observed} exceeds the AEON v1 portable floor ${portableFloor}`,
    });
}

interface SourceStructureLimits {
    readonly maxStringCodepoints: number;
    readonly maxKeySegmentCodepoints: number;
    readonly maxListItems: number;
    readonly maxTupleItems: number;
    readonly maxNumericLiteralCharacters: number;
    readonly maxPathDepth: number;
    readonly maxPathCharacters: number;
}

function validateSourceStructure(document: Document, limits: SourceStructureLimits): ResourceLimitExceededError | null {
    const checkKey = (key: string): ResourceLimitExceededError | null => {
        const observed = [...key].length;
        return observed > limits.maxKeySegmentCodepoints
            ? new ResourceLimitExceededError('max_key_segment_codepoints', observed, limits.maxKeySegmentCodepoints)
            : null;
    };
    const checkDatatype = (datatype: Binding['datatype']): ResourceLimitExceededError | null => {
        if (!datatype) return null;
        for (const clarifier of datatype.clarifiers) {
            if (typeof clarifier === 'string') {
                const observed = [...clarifier].length;
                if (observed > limits.maxStringCodepoints) {
                    return new ResourceLimitExceededError('max_string_codepoints', observed, limits.maxStringCodepoints);
                }
            }
        }
        return null;
    };
    const checkAttributes = (attributes: Binding['attributes']): ResourceLimitExceededError | null => {
        for (const attribute of attributes) {
            for (const [key, entry] of attribute.entries) {
                const error = checkKey(key) ?? checkDatatype(entry.datatype) ?? checkAttributes(entry.attributes) ?? checkValue(entry.value);
                if (error) return error;
            }
        }
        return null;
    };
    const checkReference = (value: Extract<Value, { type: 'CloneReference' | 'PointerReference' }>): ResourceLimitExceededError | null => {
        const depth = value.path.length;
        if (depth > limits.maxPathDepth) return new ResourceLimitExceededError('max_path_depth', depth, limits.maxPathDepth);
        let rendered = '$';
        for (const segment of value.path) {
            if (typeof segment === 'number') rendered += `[${segment}]`;
            else if (typeof segment === 'string') rendered += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) ? `.${segment}` : `.[${JSON.stringify(segment)}]`;
            else rendered += /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment.key) ? `.@.${segment.key}` : `.@.[${JSON.stringify(segment.key)}]`;
        }
        const characters = [...rendered].length;
        return characters > limits.maxPathCharacters
            ? new ResourceLimitExceededError('max_path_characters', characters, limits.maxPathCharacters)
            : null;
    };
    const checkValue = (value: Value): ResourceLimitExceededError | null => {
        switch (value.type) {
            case 'StringLiteral': {
                const observed = [...value.value].length;
                return observed > limits.maxStringCodepoints
                    ? new ResourceLimitExceededError('max_string_codepoints', observed, limits.maxStringCodepoints)
                    : null;
            }
            case 'NumberLiteral': {
                const observed = [...value.raw].length;
                return observed > limits.maxNumericLiteralCharacters
                    ? new ResourceLimitExceededError('max_numeric_literal_characters', observed, limits.maxNumericLiteralCharacters)
                    : null;
            }
            case 'ListNode':
                if (value.elements.length > limits.maxListItems) return new ResourceLimitExceededError('max_list_items', value.elements.length, limits.maxListItems);
                for (const item of value.elements) { const error = checkValue(item); if (error) return error; }
                return checkAttributes(value.attributes);
            case 'TupleLiteral':
                if (value.elements.length > limits.maxTupleItems) return new ResourceLimitExceededError('max_tuple_items', value.elements.length, limits.maxTupleItems);
                for (const item of value.elements) { const error = checkValue(item); if (error) return error; }
                return checkAttributes(value.attributes);
            case 'ObjectNode':
                for (const binding of value.bindings) { const error = checkBinding(binding); if (error) return error; }
                return checkAttributes(value.attributes);
            case 'NodeLiteral': {
                const tagError = checkKey(value.tag);
                if (tagError) return tagError;
                for (const child of value.children) { const error = checkValue(child); if (error) return error; }
                return checkDatatype(value.datatype) ?? checkAttributes(value.attributes);
            }
            case 'TypedValue':
                return checkDatatype(value.datatype) ?? checkAttributes(value.attributes) ?? checkValue(value.value);
            case 'CloneReference':
            case 'PointerReference':
                return checkReference(value);
            default:
                return null;
        }
    };
    const checkBinding = (binding: Binding): ResourceLimitExceededError | null =>
        checkKey(binding.key) ?? checkDatatype(binding.datatype) ?? checkAttributes(binding.attributes) ?? checkValue(binding.value);

    if (document.header) {
        for (const binding of document.header.bindings) { const error = checkBinding(binding); if (error) return error; }
    }
    for (const binding of document.bindings) { const error = checkBinding(binding); if (error) return error; }
    return null;
}

function validateStructuredComments(input: string, limit: number): ResourceLimitExceededError | null {
    const lexed = tokenize(input, { includeComments: true });
    for (const token of lexed.tokens) {
        if (token.type !== TokenType.LineComment && token.type !== TokenType.BlockComment) continue;
        const marker = token.type === TokenType.LineComment ? token.value[2] : token.value[1];
        if (!marker || !'#@?!{[('.includes(marker)) continue;
        const payload = token.type === TokenType.LineComment ? token.value.slice(3) : token.value.slice(2, -2);
        const observed = [...payload].length;
        if (observed > limit) return new ResourceLimitExceededError('max_structured_comment_characters', observed, limit);
    }
    return null;
}

function normalizeLexerErrors(input: string, errors: readonly LexerError[]): readonly AEONError[] {
    return errors.map((error) => {
        if (error.code === 'INVALID_NUMBER') {
            const raw = input.slice(error.span.start.offset, error.span.end.offset);
            if (raw.startsWith('#') || raw.startsWith('$') || raw.startsWith('&')) {
                return new ParserSyntaxError(
                    `Invalid literal spelling: '${raw}'`,
                    error.span,
                    null,
                    raw
                );
            }
        }
        return error;
    });
}

// =============================================================================
// RE-EXPORTED TYPES - For consumer convenience
// =============================================================================

// Core types consumers need to work with compile() result
export type {
    AssignmentEvent,
    CanonicalPath,
    PortableAesEvent,
    TelexRecord,
    ParsedTelex,
    TelexEncodeOptions,
    TelexCompletenessResult,
    TelexLimitOptions,
    TelexValidationOptions,
    TelexValidationResult,
} from '@altopelago/aeon-aes';
export type { AnnotationRecord } from '@altopelago/aeon-annotation-stream';
export type { Span, Position } from '@altopelago/aeon-lexer';

// Utility for formatting paths (commonly needed)
export {
    formatPath,
    parseTelex,
    encodeTelex,
    canonicalizeTelex,
    checkTelexCompleteness,
    validateTelex,
    validateTelexRecords,
    projectPortableEvents,
} from '@altopelago/aeon-aes';

function stripLeadingBom(input: string): string {
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
}

function collectSpanTargets(document: Document): readonly { readonly start: { readonly line: number; readonly column: number; readonly offset: number }; readonly end: { readonly line: number; readonly column: number; readonly offset: number } }[] {
    const spans: Array<{ readonly start: { readonly line: number; readonly column: number; readonly offset: number }; readonly end: { readonly line: number; readonly column: number; readonly offset: number } }> = [];
    const seen = new Set<string>();

    const addSpan = (span: { readonly start: { readonly line: number; readonly column: number; readonly offset: number }; readonly end: { readonly line: number; readonly column: number; readonly offset: number } }): void => {
        const key = `${span.start.offset}:${span.end.offset}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        spans.push(span);
    };

    const visitValue = (value: Value): void => {
        addSpan(value.span);
        switch (value.type) {
            case 'TypedValue':
                if (value.datatype) {
                    addSpan(value.datatype.span);
                }
                for (const attribute of value.attributes) {
                    addSpan(attribute.span);
                    for (const [, entry] of attribute.entries) {
                        for (const nestedAttribute of entry.attributes) {
                            addSpan(nestedAttribute.span);
                            for (const [, nestedEntry] of nestedAttribute.entries) {
                                addSpan(nestedEntry.value.span);
                                if (nestedEntry.datatype) {
                                    addSpan(nestedEntry.datatype.span);
                                }
                            }
                        }
                        addSpan(entry.value.span);
                        if (entry.datatype) {
                            addSpan(entry.datatype.span);
                        }
                    }
                }
                visitValue(value.value);
                break;
            case 'ObjectNode':
                for (const attribute of value.attributes) {
                    addSpan(attribute.span);
                    for (const [, entry] of attribute.entries) {
                        for (const nestedAttribute of entry.attributes) {
                            addSpan(nestedAttribute.span);
                            for (const [, nestedEntry] of nestedAttribute.entries) {
                                addSpan(nestedEntry.value.span);
                                if (nestedEntry.datatype) {
                                    addSpan(nestedEntry.datatype.span);
                                }
                            }
                        }
                        addSpan(entry.value.span);
                        if (entry.datatype) {
                            addSpan(entry.datatype.span);
                        }
                    }
                }
                for (const binding of value.bindings) {
                    visitBinding(binding);
                }
                break;
            case 'ListNode':
                for (const attribute of value.attributes) {
                    addSpan(attribute.span);
                    for (const [, entry] of attribute.entries) {
                        for (const nestedAttribute of entry.attributes) {
                            addSpan(nestedAttribute.span);
                            for (const [, nestedEntry] of nestedAttribute.entries) {
                                addSpan(nestedEntry.value.span);
                                if (nestedEntry.datatype) {
                                    addSpan(nestedEntry.datatype.span);
                                }
                            }
                        }
                        addSpan(entry.value.span);
                        if (entry.datatype) {
                            addSpan(entry.datatype.span);
                        }
                    }
                }
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'TupleLiteral':
                for (const attribute of value.attributes) {
                    addSpan(attribute.span);
                    for (const [, entry] of attribute.entries) {
                        for (const nestedAttribute of entry.attributes) {
                            addSpan(nestedAttribute.span);
                            for (const [, nestedEntry] of nestedAttribute.entries) {
                                addSpan(nestedEntry.value.span);
                                if (nestedEntry.datatype) {
                                    addSpan(nestedEntry.datatype.span);
                                }
                            }
                        }
                        addSpan(entry.value.span);
                        if (entry.datatype) {
                            addSpan(entry.datatype.span);
                        }
                    }
                }
                for (const element of value.elements) {
                    visitValue(element);
                }
                break;
            case 'NodeLiteral':
                for (const attribute of value.attributes) {
                    addSpan(attribute.span);
                for (const [, entry] of attribute.entries) {
                    for (const nestedAttribute of entry.attributes) {
                        addSpan(nestedAttribute.span);
                        for (const [, nestedEntry] of nestedAttribute.entries) {
                            addSpan(nestedEntry.value.span);
                            if (nestedEntry.datatype) {
                                addSpan(nestedEntry.datatype.span);
                            }
                        }
                    }
                    addSpan(entry.value.span);
                    if (entry.datatype) {
                        addSpan(entry.datatype.span);
                        }
                    }
                }
                if (value.datatype) {
                    addSpan(value.datatype.span);
                }
                for (const child of value.children) {
                    visitValue(child);
                }
                break;
            default:
                break;
        }
    };

    const visitBinding = (binding: Binding): void => {
        addSpan(binding.span);
        if (binding.datatype) {
            addSpan(binding.datatype.span);
        }
        for (const attribute of binding.attributes) {
            addSpan(attribute.span);
            for (const [, entry] of attribute.entries) {
                addSpan(entry.value.span);
                if (entry.datatype) {
                    addSpan(entry.datatype.span);
                }
            }
        }
        visitValue(binding.value);
    };

    if (document.header) {
        addSpan(document.header.span);
        for (const binding of document.header.bindings) {
            visitBinding(binding);
        }
    }

    for (const binding of document.bindings) {
        visitBinding(binding);
    }

    if (document.envelope) {
        addSpan(document.envelope.span);
        for (const [, value] of document.envelope.fields) {
            visitValue(value);
        }
    }

    return spans;
}
