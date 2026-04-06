import { createDiag, emitError, type DiagContext } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { RuleIndex } from './schemaIndex.js';
import type { SchemaV1 } from '../types/schema.js';

type EventInfo = {
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
};

function isReferenceType(type: string): boolean {
    return type === 'CloneReference' || type === 'PointerReference';
}

export function checkReferenceForms(
    schema: SchemaV1,
    ruleIndex: RuleIndex,
    eventsByPath: ReadonlyMap<string, EventInfo>,
    ctx: DiagContext
): void {
    if ((schema.reference_policy ?? 'allow') === 'forbid') {
        for (const [path, event] of eventsByPath.entries()) {
            if (!isReferenceType(event.type)) continue;
            emitError(ctx, createDiag(
                path,
                event.span,
                `References are forbidden by schema reference_policy, got ${event.type}`,
                ErrorCodes.REFERENCE_FORBIDDEN
            ));
        }
    }

    for (const [path, rule] of ruleIndex) {
        const reference = rule.constraints.reference;
        const referenceKind = rule.constraints.reference_kind;
        if (reference === undefined) continue;

        const event = eventsByPath.get(path);
        if (!event) continue;

        if (reference === 'forbid') {
            if (!isReferenceType(event.type)) continue;
            emitError(ctx, createDiag(
                path,
                event.span,
                `Reference not allowed at ${path}, got ${event.type}`,
                ErrorCodes.REFERENCE_FORBIDDEN
            ));
            continue;
        }

        if (reference === 'allow') {
            continue;
        }

        if (!isReferenceType(event.type)) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Reference required at ${path}, got ${event.type}`,
                ErrorCodes.REFERENCE_REQUIRED
            ));
            continue;
        }

        if (referenceKind === undefined || referenceKind === 'either') {
            continue;
        }

        const expectedType = referenceKind === 'clone' ? 'CloneReference' : 'PointerReference';
        if (event.type === expectedType) continue;
        emitError(ctx, createDiag(
            path,
            event.span,
            `Reference kind mismatch at ${path}: expected ${expectedType}, got ${event.type}`,
            ErrorCodes.REFERENCE_KIND_MISMATCH
        ));
    }
}
