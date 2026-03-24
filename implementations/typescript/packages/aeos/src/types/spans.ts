/**
 * @aeos/core - Types: Span
 *
 * Span representation for AEOS diagnostics.
 * This is a simplified tuple format for CTS compatibility.
 */

/**
 * Span as a tuple: [start_offset, end_offset] or null for missing paths.
 *
 * This is the CTS-compatible format. For full position info,
 * the original AEON Span from @aeon/aes can be converted.
 */
export type Span = [number, number] | null;

/**
 * Convert an AEON Span to AEOS tuple format.
 *
 * @param span - AEON Span with start/end Position objects
 * @returns Tuple [start_offset, end_offset]
 */
export function spanToTuple(span: { start: { offset: number }; end: { offset: number } }): [number, number] {
    return [span.start.offset, span.end.offset];
}
