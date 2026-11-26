import { createProfileFromPolicy } from '../create-profile.js';

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
    radix16: {
        literalFamily: 'RadixLiteral',
        clarifiers: 'none',
        equivalentTo: 'radix[16]',
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
    symbol: {
        literalFamily: 'SymbolicLiteral',
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

// The built-in profile retains the legacy implicit radix/separator clarifier path.
export const aeonGpCoreProfile = createProfileFromPolicy({
    id: 'aeon.gp.profile.v1',
    version: '1',
    coreId: 'aeon.core.v1',
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
    genericAdmission: {
        reservedDatatypes: ['list', 'tuple', 'triple', 'object', 'node', 'null', 'nan', 'infinity', 'symbol'],
        customLabels: true,
        customValueKinds: ['ListNode', 'TupleLiteral'],
        nodeHeadDatatypes: ['node'],
        bindingNodeReservedArguments: ['node'],
    },
    capabilities: {
        references: true,
        clones: true,
    },
}, true);
