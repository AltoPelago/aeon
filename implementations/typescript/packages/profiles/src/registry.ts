import type { Profile, ProfileRegistry } from './types.js';

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
