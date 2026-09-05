/**
 * @altopelago/aeos-core - Types: AES
 *
 * Re-exports AES types from @altopelago/aeon-aes.
 * These are type-only imports to maintain zero runtime dependencies.
 */

// Type-only imports from AEON - no runtime dependency
import type { AssignmentEvent, TelexRecord } from '@altopelago/aeon-aes';
import type { Span as AeonSpan } from '@altopelago/aeon-lexer';

// Re-export for internal use
export type { AssignmentEvent, AeonSpan, TelexRecord };

/** A decoded portable AES body record; header-plane records are filtered first. */
export type PortableAesBodyEvent = TelexRecord & {
    readonly path: string;
    readonly kind: string;
    readonly header?: never;
};

/**
 * Readonly AES array type for validation input
 */
export type AES = readonly (AssignmentEvent | PortableAesBodyEvent)[];
