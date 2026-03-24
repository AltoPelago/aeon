import type { Span } from '@aeon/lexer';
import type { Value, TypeAnnotation, Attribute } from '@aeon/parser';
import {
    type CanonicalPath,
    type CanonicalBinding,
    type PathResolutionResult,
    PathResolutionError,
    formatNormalizedPath,
} from './paths.js';
import { formatDatatypeAnnotation } from './datatype.js';

/**
 * Assignment Event - emitted for each binding
 * 
 * This is the core semantic unit of AEON. Each binding produces exactly one event.
 * Events are emitted in document order and contain the original AST values
 * without any transformation or evaluation.
 */
export interface AssignmentEvent {
    /** Canonical path to the binding (e.g., $.config.db.host) */
    readonly path: CanonicalPath;
    /** Derived wildcard path for dispatch ergonomics (e.g., config.db.items[*]) */
    readonly normalizedPath?: string;
    /** Local key name (e.g., "host") */
    readonly key: string;
    /** Original AST value node - NOT evaluated or transformed */
    readonly value: Value;
    /** Source location of the binding */
    readonly span: Span;
    /** Datatype hint if present (e.g., "int32") */
    readonly datatype?: string;
    /** Attributes if present */
    readonly annotations?: ReadonlyMap<string, AttributeEntry>;
}

/**
 * Attribute entry
 */
export interface AttributeEntry {
    readonly value: Value;
    readonly datatype?: string;
    readonly annotations?: ReadonlyMap<string, AttributeEntry>;
}

/**
 * Event emission result
 * 
 * Note: errors may include both EventEmissionError and PathResolutionError
 * (propagated from the resolution phase for fail-closed semantics).
 */
export interface EventEmissionResult {
    readonly events: readonly AssignmentEvent[];
    readonly errors: readonly (EventEmissionError | PathResolutionError)[];
}

/**
 * Event emission error (should be rare - indicates internal inconsistency)
 */
export class EventEmissionError extends Error {
    readonly span: Span;
    readonly code: string;

    constructor(message: string, span: Span, code: string = 'EVENT_ERROR') {
        super(message);
        this.name = 'EventEmissionError';
        this.span = span;
        this.code = code;
    }
}

/**
 * Event emission options
 */
export interface EventEmissionOptions {
    /** 
     * Enable recovery mode: emit events for valid bindings even if errors exist.
     * Default: false (fail-closed - no events on any error)
     */
    readonly recovery?: boolean;
}

/**
 * Emit Assignment Events from resolved bindings
 * 
 * This is a projection step - it transforms resolved bindings into events
 * without any evaluation, resolution, or transformation of values.
 * 
 * Events are emitted in document order (the order bindings appear in source).
 * 
 * **Fail-closed behavior**: If the resolution result contains any errors,
 * this function returns an empty event array (unless recovery mode is enabled).
 * This ensures downstream consumers never receive a partial event stream.
 */
export function emitEvents(
    resolved: PathResolutionResult,
    options: EventEmissionOptions = {}
): EventEmissionResult {
    // Propagate resolution errors to event emission result
    const allErrors: (EventEmissionError | PathResolutionError)[] = [...resolved.errors];

    // FAIL-CLOSED: If there are resolution errors and recovery is not enabled,
    // return empty events. This is a non-negotiable safety requirement.
    if (resolved.errors.length > 0 && !options.recovery) {
        return {
            events: [],
            errors: allErrors,
        };
    }

    // Emit one event per resolved binding, in document order
    // The bindings are already in document order from the path resolver
    const events: AssignmentEvent[] = [];
    for (const canonicalBinding of resolved.bindings) {
        const event = createEvent(canonicalBinding);
        events.push(event);
    }

    return {
        events,
        errors: allErrors,
    };
}

/**
 * Create an AssignmentEvent from a CanonicalBinding
 */
function createEvent(cb: CanonicalBinding): AssignmentEvent {
    const binding = cb.binding;

    // Build base event
    const event: AssignmentEvent = {
        path: cb.path,
        normalizedPath: formatNormalizedPath(cb.path),
        key: binding.key,
        value: binding.value,
        span: cb.span,
    };

    // Add optional datatype if present
    if (binding.datatype) {
        (event as { datatype: string }).datatype = formatDatatypeAnnotation(binding.datatype);
    }

    // Add annotations if attributes present
    if (binding.attributes.length > 0) {
        (event as { annotations: ReadonlyMap<string, AttributeEntry> }).annotations =
            buildAnnotations(binding.attributes);
    }

    return event;
}

/**
 * Build annotations map from attributes
 */
function buildAnnotations(attributes: readonly Attribute[]): ReadonlyMap<string, AttributeEntry> {
    const result = new Map<string, AttributeEntry>();

    for (const attr of attributes) {
        for (const [key, entry] of attr.entries) {
            const attrEntry: AttributeEntry = {
                value: entry.value,
            };
            if (entry.datatype) {
                (attrEntry as { datatype: string }).datatype = formatDatatypeAnnotation(entry.datatype);
            }
            const nestedAnnotations = buildAnnotations(entry.attributes);
            if (nestedAnnotations.size > 0) {
                (attrEntry as { annotations: ReadonlyMap<string, AttributeEntry> }).annotations = nestedAnnotations;
            }
            result.set(key, attrEntry);
        }
    }

    return result;
}

// Re-export for backward compatibility
export { TypeAnnotation };
