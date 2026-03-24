import type { Profile, ProfileRegistry } from './types.js';
import { createRequire } from 'node:module';

class Registry implements ProfileRegistry {
    private readonly profiles = new Map<string, Profile>();

    register(profile: Profile): ProfileRegistry {
        this.profiles.set(profile.id, profile);
        return this;
    }

    get(id: string): Profile | undefined {
        return this.profiles.get(id);
    }

    has(id: string): boolean {
        return this.profiles.has(id);
    }

    list(): readonly Profile[] {
        return Array.from(this.profiles.values());
    }
}

export function createRegistry(): ProfileRegistry {
    return new Registry();
}

export function createDefaultRegistry(): ProfileRegistry {
    const require = createRequire(import.meta.url);
    const { altopelagoCoreProfile } = require('./profiles/altopelago-core.js') as {
        altopelagoCoreProfile: Profile;
    };
    const { aeonGpCoreProfile } = require('./profiles/aeon-gp-core.js') as {
        aeonGpCoreProfile: Profile;
    };
    const { jsonProfile } = require('./profiles/json.js') as {
        jsonProfile: Profile;
    };
    return createRegistry()
        .register(altopelagoCoreProfile)
        .register(aeonGpCoreProfile)
        .register(jsonProfile);
}
