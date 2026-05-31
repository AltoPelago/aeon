import type { Profile, ProfileRegistry } from './types.js';
import { aeonGpCoreProfile } from './profiles/aeon-gp-core.js';
import { coreProfile } from './profiles/altopelago-core.js';
import { jsonProfile } from './profiles/json.js';

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
    return createRegistry()
        .register(coreProfile)
        .register(aeonGpCoreProfile)
        .register(jsonProfile);
}
