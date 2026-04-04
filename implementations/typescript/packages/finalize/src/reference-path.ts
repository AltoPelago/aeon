export type ReferencePathPart = string | number | { readonly type: 'attr'; readonly key: string };

export function formatReferencePath(pathParts: readonly ReferencePathPart[]): string {
    if (pathParts.length === 0) return '';
    let out = '';
    for (let i = 0; i < pathParts.length; i++) {
        const segment = pathParts[i]!;
        if (typeof segment === 'number') {
            out += `[${segment}]`;
        } else if (typeof segment === 'object' && segment.type === 'attr') {
            if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(segment.key)) {
                out += `@${segment.key}`;
            } else {
                out += `@[${JSON.stringify(segment.key)}]`;
            }
        } else {
            const member = segment as string;
            const isBare = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(member);
            if (isBare) {
                if (i > 0) out += '.';
                out += member;
            } else {
                if (i > 0) out += '.';
                out += `[${JSON.stringify(member)}]`;
            }
        }
    }
    return out;
}
