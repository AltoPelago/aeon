import type {
    Diagnostic,
    FinalizeInput,
    FinalizeWithProfileOptions,
    FinalizeMeta,
    OutputProfile,
    OutputProfileRef,
    OutputRegistry,
} from './types.js';
import { finalizeJson, finalizeLinkedJson } from './json.js';
import { finalizeMap } from './finalize.js';
import { finalizeNode } from './node.js';

class Registry implements OutputRegistry {
    private readonly profiles = new Map<string, OutputProfile<unknown>>();

    register<TDocument>(profile: OutputProfile<TDocument>): OutputRegistry {
        this.profiles.set(profile.id, profile as OutputProfile<unknown>);
        return this;
    }

    get(id: string): OutputProfile<unknown> | undefined {
        return this.profiles.get(id);
    }

    has(id: string): boolean {
        return this.profiles.has(id);
    }

    list(): readonly OutputProfile<unknown>[] {
        return Array.from(this.profiles.values());
    }
}

export function createOutputRegistry(): OutputRegistry {
    return new Registry();
}

export function createDefaultOutputRegistry(): OutputRegistry {
    return createOutputRegistry()
        .register(jsonOutputProfile)
        .register(linkedJsonOutputProfile)
        .register(mapOutputProfile)
        .register(nodeOutputProfile);
}

export const jsonOutputProfile: OutputProfile<ReturnType<typeof finalizeJson>['document']> = {
    id: 'json',
    finalize: (aes, options) => finalizeJson(aes, options),
};

export const linkedJsonOutputProfile: OutputProfile<ReturnType<typeof finalizeLinkedJson>['document']> = {
    id: 'linked-json',
    finalize: (aes, options) => finalizeLinkedJson(aes, options),
};

export const mapOutputProfile: OutputProfile<ReturnType<typeof finalizeMap>['document']> = {
    id: 'map',
    finalize: (aes, options) => finalizeMap(aes, options),
};

export const nodeOutputProfile: OutputProfile<ReturnType<typeof finalizeNode>['document']> = {
    id: 'node',
    finalize: (aes, options) => finalizeNode(aes, options),
};

export function finalizeWithProfile<TDocument>(
    aes: FinalizeInput,
    options: FinalizeWithProfileOptions<TDocument>
): { document: TDocument; meta?: FinalizeMeta } {
    const registry = options.registry ?? createDefaultOutputRegistry();
    const profile = resolveProfile(options.profile, registry);
    if (!profile) {
        const errors: Diagnostic[] = [{
            level: 'error',
            message: `Unknown output profile: ${String(options.profile)}`,
            code: 'OUTPUT_PROFILE_NOT_FOUND',
        }];
        return {
            document: {} as TDocument,
            meta: { errors },
        };
    }
    return profile.finalize(aes, { mode: options.mode ?? 'strict' }) as { document: TDocument; meta?: FinalizeMeta };
}

function resolveProfile<TDocument>(
    profileRef: OutputProfileRef<TDocument>,
    registry: OutputRegistry
): OutputProfile<TDocument> | null {
    if (typeof profileRef === 'string') {
        return (registry.get(profileRef) as OutputProfile<TDocument> | undefined) ?? null;
    }
    return profileRef;
}
