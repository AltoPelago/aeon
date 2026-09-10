import { compile as compileAeon, type AEONError, type AEONWarning } from '@altopelago/aeon-core';
import type { AssignmentEvent } from '@altopelago/aeon-aes';
import type { Span } from '@altopelago/aeon-lexer';
import type { CompileCtx, Diagnostic } from '../types.js';

function errorToDiagnostic(error: AEONError): Omit<Diagnostic, 'level'> {
    const anyError = error as unknown as {
        message: string;
        code?: string;
        span?: unknown;
        path?: string;
        sourcePath?: string;
        targetPath?: string;
    };

    const path = anyError.path ?? anyError.sourcePath ?? anyError.targetPath;

    return {
        message: anyError.message,
        ...(typeof anyError.code === 'string' ? { code: anyError.code } : {}),
        ...(anyError.span !== undefined ? { span: anyError.span as Span } : {}),
        ...(path !== undefined ? { path } : {}),
    };
}

function warningToDiagnostic(warning: AEONWarning): Omit<Diagnostic, 'level'> {
    return {
        message: warning.message,
        code: warning.code,
        ...(warning.path !== undefined ? { path: warning.path } : {}),
    };
}

export function compileWithCore(input: unknown, ctx: CompileCtx): readonly AssignmentEvent[] {
    if (typeof input !== 'string') {
        ctx.error({
            message: 'Input must be AEON source text (string).',
            code: 'INVALID_INPUT',
        });
        return [];
    }

    const result = compileAeon(input, {
        recovery: !ctx.strict,
        ...(ctx.datatypePolicy ? { datatypePolicy: ctx.datatypePolicy } : {}),
        maxAttributeDepth: ctx.maxAttributeDepth,
        maxClarifierValues: ctx.maxClarifierValues,
        maxGenericDepth: ctx.maxGenericDepth,
        maxGenericArguments: ctx.maxGenericArguments,
        maxDatatypeComponents: ctx.maxDatatypeComponents,
    });
    if (result.errors.length > 0) {
        for (const err of result.errors) {
            ctx.error(errorToDiagnostic(err));
        }
    }
    if (result.warnings.length > 0) {
        for (const warning of result.warnings) {
            ctx.warn(warningToDiagnostic(warning));
        }
    }

    return result.events;
}
