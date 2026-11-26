import { datatypeHasGenericArgs } from '@altopelago/aeon-aes';
import { compileWithCore } from './profiles/core-compile.js';
import { validateDatatypeSemantics } from './profiles/datatype-semantics.js';
import type { Profile, ProfilePolicy } from './types.js';

export function createProfile(policy: ProfilePolicy): Profile {
    return createProfileFromPolicy(policy, false);
}

export function createProfileFromPolicy(policy: ProfilePolicy, legacy: boolean): Profile {
    const { coreId: _coreId, description: _description, genericAdmission, ...metadata } = policy;
    const { customLabels, customValueKinds } = genericAdmission;
    const { modeDefault, datatypePolicyDefault } = metadata;
    const coreDefaults: Profile['coreDefaults'] = {
        ...(modeDefault ? { mode: modeDefault === 'loose' ? 'transport' : 'strict' } : {}),
        ...(datatypePolicyDefault ? { datatypePolicy: datatypePolicyDefault } : {}),
    };
    const literalKinds = new Map(Object.entries(metadata.datatypeSemantics)
        .map(([name, rule]) => [name, [rule.literalFamily]] as const));
    const customKinds = (datatype: string): readonly string[] | null => {
        const hasGeneric = datatypeHasGenericArgs(datatype);
        if (!legacy) {
            const [name = ''] = datatype.split(/[<\[]/, 1);
            const kinds = literalKinds.get(name);
            if (kinds) {
                return hasGeneric && customLabels
                    ? kinds.filter(kind => customValueKinds.includes(kind))
                    : kinds;
            }
        }
        return hasGeneric && customLabels ? customValueKinds : null;
    };
    const datatypePolicy = {
        genericAdmission,
        datatypeSemantics: metadata.datatypeSemantics,
        allowLegacyReservedClarifiers: legacy,
    };

    return {
        ...metadata,
        ...(!legacy ? { coreDefaults: Object.freeze(coreDefaults) } : {}),
        compile(input, ctx) {
            const aes = compileWithCore(input, ctx, !legacy || customLabels ? customKinds : undefined);
            validateDatatypeSemantics(aes, datatypePolicy, ctx);
            return aes;
        },
    };
}
