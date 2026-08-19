import type { Profile, CompileCtx } from '../types.js';
import { compileWithCore } from './core-compile.js';

export const aeonGpCoreProfile: Profile = {
    id: 'aeon.gp.profile.v1',
    version: '1',
    modeDefault: 'strict',
    datatypePolicyDefault: 'reserved_only',
    collections: {
        list: {
            ordered: false,
            heterogeneous: true,
            unique: false,
            fixedLength: false,
        },
        tuple: {
            ordered: true,
            heterogeneous: true,
            unique: false,
            fixedLength: true,
        },
    },
    containers: {
        object: {
            ordered: false,
            heterogeneous: true,
            uniqueKeys: true,
        },
        node: {
            ordered: true,
            heterogeneous: true,
            uniqueAttributes: true,
            mixedContent: true,
        },
    },
    datatypeSemantics: {
        radix: {
            literalFamily: 'RadixLiteral',
            clarifiers: 'radix_base',
        },
        decimal: {
            literalFamily: 'RadixLiteral',
            clarifiers: 'none',
            equivalentTo: 'radix[10]',
        },
        sep: {
            literalFamily: 'SeparatorLiteral',
            clarifiers: 'separator_chars',
        },
        separator: {
            literalFamily: 'SeparatorLiteral',
            clarifiers: 'separator_chars',
            aliasOf: 'sep',
        },
        kadot: {
            literalFamily: 'SeparatorLiteral',
            clarifiers: 'none',
        },
    },
    capabilities: {
        references: true,
        clones: true,
    },
    compile: (input, ctx: CompileCtx) => compileWithCore(input, ctx),
};
