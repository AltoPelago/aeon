/**
 * @aeos/core - Types: AES
 *
 * Re-exports AES types from @aeon/aes.
 * These are type-only imports to maintain zero runtime dependencies.
 */

// Type-only imports from AEON - no runtime dependency
import type { AssignmentEvent } from '@aeon/aes';
import type { Span as AeonSpan } from '@aeon/lexer';

// Re-export for internal use
export type { AssignmentEvent, AeonSpan };

/**
 * Readonly AES array type for validation input
 */
export type AES = readonly AssignmentEvent[];
