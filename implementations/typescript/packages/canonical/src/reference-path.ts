export type ReferencePathPart = string | number | { readonly type: 'attr'; readonly key: string };

function escapeQuotedPathSegment(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function formatReferencePath(path: readonly ReferencePathPart[]): string {
    if (path.length === 0) return '';
    let result = '';
    for (let i = 0; i < path.length; i++) {
        const segment = path[i]!;
        if (typeof segment === 'number') {
            result += `[${segment}]`;
            continue;
        }
        if (typeof segment === 'object' && segment.type === 'attr') {
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                result += `@${segment.key}`;
            } else {
                result += `@["${escapeQuotedPathSegment(segment.key)}"]`;
            }
            continue;
        }
        const member = segment as string;
        if (i > 0) {
            result += '.';
        }
        if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(member)) {
            result += member;
        } else {
            result += `["${escapeQuotedPathSegment(member)}"]`;
        }
    }
    return result;
}
