import { compile as compileAeon, type AEONError } from '@aeon/core';
import type { AssignmentEvent } from '@aeon/aes';
import type { Span } from '@aeon/lexer';
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
        maxSeparatorDepth: ctx.maxSeparatorDepth,
        maxGenericDepth: ctx.maxGenericDepth,
    });
    if (result.errors.length > 0) {
        for (const err of result.errors) {
            ctx.error(errorToDiagnostic(err));
        }
    }

    return result.events;
}
