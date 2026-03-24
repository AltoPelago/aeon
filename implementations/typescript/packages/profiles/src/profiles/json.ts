import type { CompileCtx, Profile } from '../types.js';
import { createResolveRefsProcessor } from '../processors/resolve-refs.js';
import { compileWithCore } from './core-compile.js';

export const jsonProfile: Profile = {
    id: 'json',
    version: '1',
    compile: (input, ctx: CompileCtx) => compileWithCore(input, ctx),
    processors: [
        createResolveRefsProcessor(),
    ],
};
