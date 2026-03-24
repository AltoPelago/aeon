import type { Processor } from '../types.js';
import { resolveRefs } from '@aeon/aes';

export function createResolveRefsProcessor(mode?: 'strict' | 'loose'): Processor {
    return {
        id: 'resolve.refs.v1',
        order: 100,
        apply(aes, ctx) {
            const resolveMode = mode ?? (ctx.strict ? 'strict' : 'loose');
            const result = resolveRefs(aes, { mode: resolveMode });
            if (result.meta?.errors) {
                for (const err of result.meta.errors) {
                    ctx.error({
                        message: err.message,
                        ...(err.code ? { code: err.code } : {}),
                        ...(err.span ? { span: err.span } : {}),
                        ...(err.path ? { path: err.path } : {}),
                    });
                }
            }
            if (result.meta?.warnings) {
                for (const warn of result.meta.warnings) {
                    ctx.warn({
                        message: warn.message,
                        ...(warn.code ? { code: warn.code } : {}),
                        ...(warn.span ? { span: warn.span } : {}),
                        ...(warn.path ? { path: warn.path } : {}),
                    });
                }
            }
            return result.aes;
        },
    };
}
