import type {
    Diagnostic,
    FinalizeHeader,
    FinalizeInput,
    FinalizeMeta,
    FinalizeOptions,
    FinalizeResult,
    FinalizedEntry,
    FinalizedMap,
} from './types.js';
import { formatPath } from '@aeon/aes';
import { createProjectionState, shouldIncludeProjectedPath } from './projection.js';

function toDiagnostic(level: 'error' | 'warning', message: string, path?: string, span?: unknown): Diagnostic {
    return {
        level,
        message,
        ...(path !== undefined ? { path } : {}),
        ...(span !== undefined ? { span: span as any } : {}),
    };
}

export function finalizeMap(
    aes: FinalizeInput,
    options: FinalizeOptions = {}
): FinalizeResult {
    const strict = (options.mode ?? 'strict') === 'strict';
    const scope = options.scope ?? 'payload';
    const errors: Diagnostic[] = [];
    const warnings: Diagnostic[] = [];
    const entries = new Map<string, FinalizedEntry>();
    const projection = createProjectionState(options.includePaths, options.materialization);

    if (scope !== 'payload' && options.header) {
        appendHeaderEntries(entries, options.header, projection, scope);
    }

    if (scope === 'payload' || scope === 'full') {
        for (const event of aes) {
        const topLevelKey = topLevelMemberKey(event);
        if (topLevelKey && isHeaderEventKey(topLevelKey, options.header)) {
            continue;
        }
        const basePath = formatPath(event.path);
        const path = scope === 'full' ? `$.payload${basePath.slice(1)}` : basePath;
        if (!shouldIncludeProjectedPath(path, projection)) {
            continue;
        }
        if (entries.has(path)) {
            const diag = toDiagnostic(
                strict ? 'error' : 'warning',
                `Duplicate path during finalization: ${path}`,
                path,
                event.span
            );
            if (strict) errors.push(diag);
            else warnings.push(diag);
            if (strict) continue;
        }

        const entry: FinalizedEntry = {
            path,
            value: event.value,
            span: event.span,
            ...(event.datatype ? { datatype: event.datatype } : {}),
            ...(event.annotations ? { annotations: event.annotations } : {}),
        };
        if (!entries.has(path)) entries.set(path, entry);
    }
    }

    const document: FinalizedMap = { entries };
    const meta: FinalizeMeta = {
        ...(errors.length > 0 ? { errors } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
    };

    if (strict && errors.length > 0) {
        return Object.keys(meta).length > 0 ? { document, meta } : { document };
    }

    return Object.keys(meta).length > 0 ? { document, meta } : { document };
}

function appendHeaderEntries(
    entries: Map<string, FinalizedEntry>,
    header: FinalizeHeader,
    projection: ReturnType<typeof createProjectionState>,
    scope: 'full' | 'header' | 'payload'
): void {
    for (const [key, value] of header.fields) {
        const path = scope === 'full' ? `$.header.${key}` : `$.${key}`;
        if (!shouldIncludeProjectedPath(path, projection)) {
            continue;
        }
        entries.set(path, {
            path,
            value,
            span: value.span,
        });
    }
}

function topLevelMemberKey(event: FinalizeInput[number]): string | null {
    const segment = event.path.segments[1];
    if (event.path.segments.length !== 2 || event.path.segments[0]?.type !== 'root' || !segment || segment.type !== 'member') {
        return null;
    }
    return segment.key;
}

function isHeaderEventKey(key: string, header: FinalizeHeader | undefined): boolean {
    if (key === 'aeon:header') return true;
    if (!header || !key.startsWith('aeon:')) return false;
    return header.fields.has(key.slice('aeon:'.length));
}
