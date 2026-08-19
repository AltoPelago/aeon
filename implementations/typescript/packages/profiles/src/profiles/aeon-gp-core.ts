import type { Profile, CompileCtx } from '../types.js';
import { compileWithCore } from './core-compile.js';
import { validateDatatypeSemantics } from './datatype-semantics.js';

const datatypeSemantics = {
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
    encoding: {
        literalFamily: 'EncodingLiteral',
        clarifiers: 'encoding_name',
    },
    inline: {
        literalFamily: 'EncodingLiteral',
        clarifiers: 'encoding_name',
    },
    embed: {
        literalFamily: 'EncodingLiteral',
        clarifiers: 'encoding_name',
    },
} as const;

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
    datatypeSemantics,
    capabilities: {
        references: true,
        clones: true,
    },
    compile: (input, ctx: CompileCtx) => {
        const aes = compileWithCore(input, ctx);
        validateDatatypeSemantics(aes, datatypeSemantics, ctx);
        return aes;
    },
};
