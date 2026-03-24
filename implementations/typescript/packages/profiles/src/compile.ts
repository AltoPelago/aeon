import type {
    CompileCtx,
    CompileOptions,
    CompileResult,
    Diagnostic,
    Processor,
    Profile,
    ProfileRef,
} from './types.js';
import type { AssignmentEvent } from '@aeon/aes';
import { createDefaultRegistry } from './registry.js';

function normalizeDiagnostic(level: 'error' | 'warning', diag: Omit<Diagnostic, 'level'>): Diagnostic {
    return {
        level,
        message: diag.message,
        ...(diag.code !== undefined ? { code: diag.code } : {}),
        ...(diag.span !== undefined ? { span: diag.span } : {}),
        ...(diag.path !== undefined ? { path: diag.path } : {}),
    };
}

function resolveProfile(profileRef: ProfileRef, registry: { get(id: string): Profile | undefined }): Profile | null {
    if (typeof profileRef === 'string') {
        return registry.get(profileRef) ?? null;
    }
    return profileRef;
}

function sortProcessors(processors: readonly Processor[]): readonly Processor[] {
    return [...processors].sort((a, b) => {
        const orderA = a.order ?? 0;
        const orderB = b.order ?? 0;
        if (orderA !== orderB) return orderA - orderB;
        return a.id.localeCompare(b.id);
    });
}

export function compile(input: unknown, options: CompileOptions): CompileResult {
    const registry = options.registry ?? createDefaultRegistry();
    const strict = (options.mode ?? 'strict') === 'strict';
    const datatypePolicy = options.datatypePolicy;
    const maxInputBytes = options.maxInputBytes;

    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const emitted: AssignmentEvent[] = [];

    if (typeof input === 'string' && maxInputBytes !== undefined) {
        const actualBytes = Buffer.byteLength(input, 'utf8');
        if (actualBytes > maxInputBytes) {
            errors.push({
                level: 'error',
                message: `Input size ${actualBytes} bytes exceeds configured limit of ${maxInputBytes} bytes`,
                code: 'INPUT_SIZE_EXCEEDED',
            });
            return {
                aes: [],
                meta: {
                    errors,
                },
            };
        }
    }

    const ctx: CompileCtx = {
        strict,
        ...(datatypePolicy ? { datatypePolicy } : {}),
        maxAttributeDepth: options.maxAttributeDepth ?? 1,
        maxSeparatorDepth: options.maxSeparatorDepth ?? 1,
        maxGenericDepth: options.maxGenericDepth ?? 1,
        emit(event) {
            emitted.push(event);
        },
        warn(diag) {
            warnings.push(normalizeDiagnostic('warning', diag));
        },
        error(diag) {
            errors.push(normalizeDiagnostic('error', diag));
        },
    };

    const profile = resolveProfile(options.profile, registry);
    if (!profile) {
        errors.push({
            level: 'error',
            message: `Unknown profile: ${String(options.profile)}`,
            code: 'PROFILE_NOT_FOUND',
        });
        return {
            aes: [],
            meta: {
                errors,
            },
        };
    }

    const profileResult = profile.compile(input, ctx);
    let aes = Array.isArray(profileResult) ? profileResult : emitted;

    if (profile.processors && profile.processors.length > 0) {
        const processorCtx = {
            strict,
            warn(diag: Omit<Diagnostic, 'level'>) {
                warnings.push(normalizeDiagnostic('warning', diag));
            },
            error(diag: Omit<Diagnostic, 'level'>) {
                errors.push(normalizeDiagnostic('error', diag));
            },
        };

        for (const processor of sortProcessors(profile.processors)) {
            const next = processor.apply(aes, processorCtx);
            if (!Array.isArray(next)) {
                errors.push({
                    level: 'error',
                    message: `Processor '${processor.id}' returned invalid result`,
                    code: 'PROCESSOR_INVALID_RESULT',
                });
                break;
            }
            aes = next;
        }
    }

    const hasErrors = errors.length > 0;

    const meta = {
        ...(errors.length > 0 ? { errors } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(profile.id ? { profileId: profile.id } : {}),
        ...(profile.version ? { version: profile.version } : {}),
    };
    if (Object.keys(meta).length > 0) {
        return {
            aes: strict && hasErrors ? [] : aes,
            meta,
        };
    }

    return {
        aes: strict && hasErrors ? [] : aes,
    };
}
