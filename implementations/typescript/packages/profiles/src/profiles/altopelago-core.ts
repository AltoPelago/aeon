import type { Profile, CompileCtx } from '../types.js';
import { compileWithCore } from './core-compile.js';

export const altopelagoCoreProfile: Profile = {
    id: 'altopelago.core.v1',
    version: '1',
    compile: (input, ctx: CompileCtx) => compileWithCore(input, ctx),
};
