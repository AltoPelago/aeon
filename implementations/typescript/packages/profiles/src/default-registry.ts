import { aeonGpCoreProfile } from './profiles/aeon-gp-core.js';
import { coreProfile } from './profiles/altopelago-core.js';
import { jsonProfile } from './profiles/json.js';
import { createRegistry } from './registry.js';
import type { ProfileRegistry } from './types.js';

export function createDefaultRegistry(): ProfileRegistry {
    return createRegistry()
        .register(coreProfile)
        .register(aeonGpCoreProfile)
        .register(jsonProfile);
}
