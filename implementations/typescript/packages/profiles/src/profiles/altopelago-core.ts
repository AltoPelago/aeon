import type { Profile, CompileCtx } from '../types.js';
import { compileWithCore } from './core-compile.js';

export const coreProfile: Profile = {
    id: 'core',
    version: '1',
    compile: (input, ctx: CompileCtx) => compileWithCore(input, ctx),
};
