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
    return projection.includePaths.some((candidate) => candidate === path || isDescendantPath(candidate, path));
}

function isDescendantPath(candidate: string, ancestor: string): boolean {
    return candidate.startsWith(`${ancestor}.`)
        || candidate.startsWith(`${ancestor}[`)
        || candidate.startsWith(`${ancestor}@`);
}
