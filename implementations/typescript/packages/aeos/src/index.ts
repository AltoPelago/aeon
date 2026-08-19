/**
 * @altopelago/aeos-core - AEOS™ Schema Validation Engine
 *
 * AEOS™ (Another Easy Object Schema) — the canonical entry point for validation.
 *
 * Usage:
 * ```ts
 * import { validate } from '@altopelago/aeos-core';
 *
 * const result = validate(aes, schema);
 * if (result.ok) {
 *   console.log('Validation passed');
 * } else {
 *   console.log('Errors:', result.errors);
 * }
 * ```
 *
 * AEOS answers: "Is this AES structurally and representationally valid?"
 * It does NOT answer: "What does this mean?"
 */

// =============================================================================
// PUBLIC API
// =============================================================================

export { validate } from './validate.js';
export type { ValidateOptions } from './validate.js';
export {
    normalizeSchemaObject,
    parseSchemaSource,
    schemaToAeon,
    SchemaCodecError,
} from './schema-codec.js';
export type { SchemaCodecOptions } from './schema-codec.js';
export {
    diffSchemas,
    diffSchemaSources,
    inferSchemaFromAeon,
    inferSchemaFromEvents,
    projectSchemaSourceToAeon,
    projectSchemaToAeon,
    SchemaInferenceError,
    validateSchemaEvolution,
    validateSchemaEvolutionSources,
} from './schema-tools.js';
export type {
    InferSchemaOptions,
    InferredSchemaCandidate,
    SchemaAeonProjection,
    PossibleRuleMove,
    SchemaDiff,
    SchemaDiffChange,
    SchemaEvolutionDiagnostic,
} from './schema-tools.js';

// =============================================================================
// TYPES
// =============================================================================

// Envelope types (canonical output)
export type { ResultEnvelope, Diag } from './types/envelope.js';
export type { Span } from './types/spans.js';
export { createPassingEnvelope, createFailingEnvelope } from './types/envelope.js';
export { spanToTuple } from './types/spans.js';

// Schema types
export type {
    SchemaV1,
    SchemaRule,
    ConstraintsV1,
    SchemaEvolutionKindV1,
    SchemaEvolutionV1,
} from './types/schema.js';

// AES types (re-exported from @altopelago/aeon-aes)
export type { AES, AssignmentEvent } from './types/aes.js';

// =============================================================================
// DIAGNOSTICS
// =============================================================================

export { ErrorCodes } from './diag/codes.js';
export type { ErrorCode } from './diag/codes.js';
