import type { Span } from '@altopelago/aeon-lexer';
import type { AssignmentEvent, AttributeEntry } from './events.js';

/**
 * Reconstructed AES candidate input.
 *
 * Candidate events are used by storage engines and orchestrators that need to
 * validate a speculative post-commit state but do not have source-document
 * lexer spans for every reconstructed binding. The shape intentionally mirrors
 * AssignmentEvent while allowing tuple spans and candidate-local value nodes.
 */
export type CandidateSpan = Span | readonly [number, number];

export type CandidateValue =
    | AssignmentEvent['value']
    | (Readonly<Record<string, unknown>> & {
        readonly type: string;
        readonly span?: CandidateSpan;
    });

export interface CandidateAttributeEntry extends Omit<AttributeEntry, 'value' | 'annotations'> {
    readonly value: CandidateValue;
    readonly annotations?: ReadonlyMap<string, CandidateAttributeEntry>;
}

export interface CandidateAssignmentEvent extends Omit<AssignmentEvent, 'value' | 'span' | 'annotations'> {
    readonly value: CandidateValue;
    readonly span: CandidateSpan;
    readonly annotations?: ReadonlyMap<string, CandidateAttributeEntry>;
}

export type CandidateAES = readonly CandidateAssignmentEvent[];
