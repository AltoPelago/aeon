import { createDiag, emitError, type DiagContext } from '../diag/emit.js';
import { ErrorCodes } from '../diag/codes.js';
import type { RuleIndex } from './schemaIndex.js';
import type { SchemaV1 } from '../types/schema.js';
import { matchesPortablePattern } from './stringForm.js';

type EventInfo = {
    type: string;
    raw: string;
    value: string;
    datatype?: string;
    span: [number, number] | null;
    referencePath?: readonly (string | number | { readonly type: 'attr'; readonly key: string })[];
};

function isReferenceType(type: string): boolean {
    return type === 'CloneReference' || type === 'PointerReference';
}

function formatQuotedMemberSegment(key: string): string {
    return `.[${JSON.stringify(key)}]`;
}

function formatReferenceTargetPath(segments: readonly (string | number | { readonly type: 'attr'; readonly key: string })[]): string {
    if (segments.length === 0) return '$';
    let out = '$';
    for (const segment of segments) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }
        if (typeof segment === 'string') {
            out += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment)
                ? `.${segment}`
                : formatQuotedMemberSegment(segment);
            continue;
        }
        out += /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)
            ? `@${segment.key}`
            : `@[${JSON.stringify(segment.key)}]`;
    }
    return out;
}

function targetPatternMatches(pattern: string, value: string): boolean {
    return matchesPortablePattern(pattern, value);
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

        if (reference === 'allow' || reference === undefined) {
            // Allow still permits target-domain constraints.
        } else if (reference === 'require') {
            if (!isReferenceType(event.type)) {
                emitError(ctx, createDiag(
                    path,
                    event.span,
                    `Reference required at ${path}, got ${event.type}`,
                    ErrorCodes.REFERENCE_REQUIRED
                ));
                continue;
            }

            if (referenceKind !== undefined && referenceKind !== 'either') {
                const expectedType = referenceKind === 'clone' ? 'CloneReference' : 'PointerReference';
                if (event.type !== expectedType) {
                    emitError(ctx, createDiag(
                        path,
                        event.span,
                        `Reference kind mismatch at ${path}: expected ${expectedType}, got ${event.type}`,
                        ErrorCodes.REFERENCE_KIND_MISMATCH
                    ));
                    continue;
                }
            }
        }

        const targetPattern = (rule.constraints as any).reference_target_pattern;
        if (targetPattern === undefined) {
            continue;
        }
        if (!isReferenceType(event.type) || !event.referencePath) {
            continue;
        }
        if (!targetPatternMatches(targetPattern, formatReferenceTargetPath(event.referencePath))) {
            emitError(ctx, createDiag(
                path,
                event.span,
                `Reference target path does not satisfy reference_target_pattern at ${path}`,
                ErrorCodes.REFERENCE_TARGET_MISMATCH
            ));
        }
    }
}
