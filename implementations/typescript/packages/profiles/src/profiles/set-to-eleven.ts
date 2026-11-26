import type { Profile } from '../types.js';
import { compileWithCore } from './core-compile.js';

export const setToElevenProfile: Profile = {
    id: 'set.to.eleven.v1',
    version: '1',
    compile: compileWithCore,
};
