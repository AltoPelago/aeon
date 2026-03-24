import type {
    FinalizedNode,
    FinalizedObjectNode,
    FinalizedListNode,
    FinalizedNodeDocument,
    NodeTransform,
    NodeTransformContext,
} from './types.js';

export function transformDocument(
    document: FinalizedNodeDocument,
    transform: NodeTransform
): FinalizedNodeDocument {
    const root = transformNode(document.root, transform, { path: ['$'] }) as FinalizedObjectNode;
    return { root };
}

export function transformNode(
    node: FinalizedNode,
    transform: NodeTransform,
    ctx: NodeTransformContext
): FinalizedNode {
    const entered = transform.enter ? transform.enter(node, ctx) : undefined;
    const current = entered ?? node;

    let next = current;
    if (current.type === 'Object') {
        next = transformObject(current, transform, ctx);
    } else if (current.type === 'List') {
        next = transformList(current, transform, ctx);
    }

    const left = transform.leave ? transform.leave(next, ctx) : undefined;
    return left ?? next;
}

function transformObject(
    node: FinalizedObjectNode,
    transform: NodeTransform,
    ctx: NodeTransformContext
): FinalizedObjectNode {
    const entries = new Map<string, FinalizedNode>();
    for (const [key, value] of node.entries.entries()) {
        const childCtx: NodeTransformContext = {
            path: [...ctx.path, key],
        };
        entries.set(key, transformNode(value, transform, childCtx));
    }
    return entriesAreSame(node.entries, entries) ? node : { ...node, entries };
}

function transformList(
    node: FinalizedListNode,
    transform: NodeTransform,
    ctx: NodeTransformContext
): FinalizedListNode {
    const items = node.items.map((item, index) =>
        transformNode(item, transform, { path: [...ctx.path, `[${index}]`] })
    );
    return items === node.items ? node : { ...node, items };
}

function entriesAreSame(
    original: ReadonlyMap<string, FinalizedNode>,
    next: ReadonlyMap<string, FinalizedNode>
): boolean {
    if (original.size !== next.size) return false;
    for (const [key, value] of original.entries()) {
        if (!next.has(key)) return false;
        if (next.get(key) !== value) return false;
    }
    return true;
}
