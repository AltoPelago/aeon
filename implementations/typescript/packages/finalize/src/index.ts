/**
 * @aeon/finalize - Finalization utilities
 *
 * Converts AES into a deterministic document model for downstream consumers.
 */

export { finalizeJson } from './json.js';
export { finalizeLinkedJson } from './json.js';
export { finalizeMap } from './finalize.js';
export { finalizeNode } from './node.js';
export { transformDocument, transformNode } from './transform.js';
export {
    createDefaultOutputRegistry,
    createOutputRegistry,
    finalizeWithProfile,
    jsonOutputProfile,
    linkedJsonOutputProfile,
    mapOutputProfile,
    nodeOutputProfile,
} from './outputs.js';
export type {
    Diagnostic,
    DiagnosticLevel,
    FinalizeHeader,
    FinalizeInput,
    FinalizeJsonResult,
    FinalizeMeta,
    FinalizeOptions,
    FinalizeScope,
    FinalizeResult,
    FinalizeNodeResult,
    FinalizedNode,
    FinalizedNodeBase,
    FinalizedNodeDocument,
    FinalizedObjectNode,
    FinalizedListNode,
    FinalizedScalarNode,
    FinalizedReferenceNode,
    FinalizedEntry,
    FinalizedMap,
    JsonArray,
    JsonObject,
    JsonPrimitive,
    JsonValue,
    NodeTransform,
    NodeTransformContext,
    OutputProfile,
    OutputProfileRef,
    OutputRegistry,
    FinalizeWithProfileOptions,
} from './types.js';
