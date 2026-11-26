import { datatypeHasGenericArgs } from '@altopelago/aeon-aes';
import { compileWithCore } from './profiles/core-compile.js';
import { validateDatatypeSemantics } from './profiles/datatype-semantics.js';
import type { Profile, ProfilePolicy } from './types.js';

export function createProfile(policy: ProfilePolicy): Profile {
    return createProfileFromPolicy(policy, false);
}

export function createProfileFromPolicy(policy: ProfilePolicy, allowLegacyReservedClarifiers: boolean): Profile {
    const { coreId: _coreId, description: _description, genericAdmission, ...metadata } = policy;
    const { customLabels, customValueKinds } = genericAdmission;
    const customKinds = (datatype: string) => datatypeHasGenericArgs(datatype) ? customValueKinds : null;
    const datatypePolicy = {
        genericAdmission,
        datatypeSemantics: metadata.datatypeSemantics,
        allowLegacyReservedClarifiers,
    };

    return {
        ...metadata,
        compile(input, ctx) {
            const aes = compileWithCore(input, ctx, customLabels ? customKinds : undefined);
            validateDatatypeSemantics(aes, datatypePolicy, ctx);
            return aes;
        },
    };
}
