import type { Profile, CompileCtx } from '../types.js';
import { compileWithCore } from './core-compile.js';

export const aeonGpCoreProfile: Profile = {
    id: 'aeon.gp.profile.v1',
    version: '1',
    compile: (input, ctx: CompileCtx) => compileWithCore(input, ctx),
};
