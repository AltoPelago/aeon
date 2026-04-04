export interface ProjectionState {
    readonly projected: boolean;
    readonly includePaths: readonly string[];
}

export function createProjectionState(includePaths: readonly string[] | undefined, materialization: 'all' | 'projected' | undefined): ProjectionState {
    return {
        projected: materialization === 'projected',
        includePaths: Array.isArray(includePaths) ? includePaths : [],
    };
}

export function shouldIncludeProjectedPath(path: string, projection: ProjectionState): boolean {
    if (!projection.projected) return true;
    const normalizedPath = normalizeProjectionPath(path);
    return projection.includePaths.some((candidate) => {
        const normalizedCandidate = normalizeProjectionPath(candidate);
        return normalizedCandidate === normalizedPath || isDescendantPath(normalizedCandidate, normalizedPath);
    });
}

function isDescendantPath(candidate: string, ancestor: string): boolean {
    return candidate.startsWith(`${ancestor}.`)
        || candidate.startsWith(`${ancestor}[`)
        || candidate.startsWith(`${ancestor}@`)
        || candidate.startsWith(`${ancestor}<`);
}

function normalizeProjectionPath(path: string): string {
    return path
        .replace(/\.\["([A-Za-z_][A-Za-z0-9_:-]*)"\]/g, '.$1')
        .replace(/@\["([A-Za-z_][A-Za-z0-9_:-]*)"\]/g, '@$1')
        .replace(/^\$\["([A-Za-z_][A-Za-z0-9_:-]*)"\]/, '$.$1');
}
