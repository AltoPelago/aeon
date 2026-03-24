/**
 * @aeon/core - AEON Core Package
 * 
 * The canonical, safe entry point for AEON processing.
 * 
 * Usage:
 * ```ts
 * import { compile } from '@aeon/core';
 * 
 * const result = compile('key = "value"');
 * if (result.errors.length === 0) {
 *   console.log(result.events);
 * }
 * ```
 */

import { tokenize, type LexerError } from '@aeon/lexer';
import { parse, type ParserError, type Document, type Value, type Binding } from '@aeon/parser';
import {
    resolvePaths,
    emitEvents,
    validateReferences,
    enforceMode,
    EventEmissionError,
    type AssignmentEvent,
    type PathResolutionError,
    type ReferenceValidationError,
    type ModeEnforcementError,
    type DatatypePolicy,
} from '@aeon/aes';
import { buildAnnotationStreamFromSourceAndSpans, type AnnotationRecord } from '@aeon/annotation-stream';
export { inspectFilePreamble, type FilePreambleInfo, type HostDirective, type HostDirectiveKind } from './preamble.js';

// =============================================================================
// PUBLIC API
// =============================================================================

export const VERSION = '0.0.1';

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
    | InputSizeExceededError;

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

/**
 * Compilation result
 */
export interface CompileResult {
    /** Assignment events (empty if any errors occurred unless recovery mode) */
    readonly events: readonly AssignmentEvent[];
    /** All errors from all phases */
    readonly errors: readonly AEONError[];
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
    /** Maximum number of separator specs in a datatype annotation (default: 1). */
    readonly maxSeparatorDepth?: number;
    /** Maximum nesting depth for nested generic type annotations (default: 1). */
    readonly maxGenericDepth?: number;
    /** Emit structured annotation stream records. Default: true. */
    readonly emitAnnotations?: boolean;
    /** Datatype policy in strict mode. Default: reserved_only */
    readonly datatypePolicy?: DatatypePolicy;
    /** Maximum UTF-8 input size in bytes. Fail-closed when exceeded. */
    readonly maxInputBytes?: number;
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
    const maxSeparatorDepth = options.maxSeparatorDepth ?? 1;
    const maxGenericDepth = options.maxGenericDepth ?? 1;
    const emitAnnotations = options.emitAnnotations ?? true;
    const datatypePolicy = options.datatypePolicy;
    const maxInputBytes = options.maxInputBytes;

    if (maxInputBytes !== undefined) {
        const actualBytes = Buffer.byteLength(input, 'utf8');
        if (actualBytes > maxInputBytes) {
            allErrors.push(new InputSizeExceededError(actualBytes, maxInputBytes));
            return { events: [], errors: allErrors };
        }
    }

    input = stripLeadingBom(input);

    // Phase 1: Lexing
    const lexResult = tokenize(input, { includeComments: false });
    allErrors.push(...lexResult.errors);
    if (lexResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors };
    }

    // Phase 2: Parsing
    const parseResult = parse(lexResult.tokens, { maxAttributeDepth, maxSeparatorDepth, maxGenericDepth });
    allErrors.push(...parseResult.errors);
    if (parseResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors };
    }
    if (!parseResult.document) {
        return { events: [], errors: allErrors };
    }

    // Phase 3: Path Resolution
    const resolveResult = resolvePaths(parseResult.document, { indexedPaths: true });
    allErrors.push(...resolveResult.errors);
    if (resolveResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors };
    }

    // Phase 4: Event Emission
    const emitResult = emitEvents(resolveResult, { recovery });
    for (const err of emitResult.errors) {
        if (err instanceof EventEmissionError) {
            allErrors.push(err);
        }
    }
    if (emitResult.errors.length > 0 && !recovery && emitResult.events.length === 0) {
        return { events: [], errors: allErrors };
    }

    // Phase 5: Reference Validation
    const refResult = validateReferences(emitResult.events, { recovery, maxAttributeDepth });
    allErrors.push(...refResult.errors);
    if (refResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors };
    }

    // Phase 6: Mode Enforcement
    const modeResult = enforceMode(refResult.events, parseResult.document.header, {
        recovery,
        ...(datatypePolicy ? { datatypePolicy } : {}),
    });
    allErrors.push(...modeResult.errors);
    if (modeResult.errors.length > 0 && !recovery) {
        return { events: [], errors: allErrors };
    }

    const result: CompileResult = {
        events: modeResult.events,
        errors: allErrors,
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

// =============================================================================
// RE-EXPORTED TYPES - For consumer convenience
// =============================================================================

// Core types consumers need to work with compile() result
export type { AssignmentEvent, CanonicalPath } from '@aeon/aes';
export type { AnnotationRecord } from '@aeon/annotation-stream';
export type { Span, Position } from '@aeon/lexer';

// Utility for formatting paths (commonly needed)
export { formatPath } from '@aeon/aes';

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
