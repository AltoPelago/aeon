import type { Attribute, AttributeValue, Binding, Document, ReferencePathSegment, Value } from '@altopelago/aeon-parser';
import type { Span } from '@altopelago/aeon-lexer';

export class CanonicalOrderingError extends Error {
    constructor(
        readonly code: 'CANONICAL_ORDERING_LIMIT_EXCEEDED' | 'CANONICAL_ORDERING_CONFLICT' | 'CANONICAL_ORDERING_INVALID_OPTION',
        message: string,
        readonly span: Span,
    ) {
        super(message);
        this.name = 'CanonicalOrderingError';
    }
}

/** Compare decoded Unicode scalars, independently of locale and UTF-16 width. */
export function compareScalarKeys(left: string, right: string): number {
    const a = left[Symbol.iterator]();
    const b = right[Symbol.iterator]();
    for (;;) {
        const x = a.next();
        const y = b.next();
        if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1;
        const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
        if (difference !== 0) return difference;
    }
}

interface Scope {
    readonly identity: object;
    readonly keys: readonly string[];
    readonly successors: Map<number, Set<number>>;
    readonly indegree: number[];
}

// Persistent memberships avoid copying an ancestor vector for every value.
interface Membership {
    readonly scope: Scope;
    readonly entry: number;
    readonly parent: Membership | undefined;
}

type Path = readonly ReferencePathSegment[];
type Orders = ReadonlyMap<object, readonly number[]>;

// Typed structural segments prevent quoted keys from aliasing attributes or indices.
function pathKey(path: Path): string {
    return JSON.stringify(path.map(segment => typeof segment === 'object' ? ['attr', segment.key] : segment));
}

/** Build dependency orders only after the caller validates authored Core references. */
export function referenceSafeOrders(document: Document, maxEdges: number): Orders {
    const scopes: Scope[] = [];
    const targets = new Map<string, Membership | undefined>();
    const claims: { target: Path; membership: Membership | undefined }[] = [];
    const bodyKeys = new Set(document.bindings.map(binding => binding.key));

    function scope(identity: object, keys: readonly string[]): Scope {
        const result: Scope = { identity, keys, successors: new Map(), indegree: keys.map(() => 0) };
        scopes.push(result);
        return result;
    }

    function attributes(attributes: readonly Attribute[], path: Path, parent: Membership | undefined, targetable: boolean): void {
        if (attributes.length === 0) return;
        const entries = attributes.flatMap(attribute => [...attribute.entries]);
        const head = scope(attributes, entries.map(([key]) => key));
        entries.forEach(([key, entry], index) => {
            const membership: Membership = { scope: head, entry: index, parent };
            const child = [...path, { type: 'attr' as const, key }];
            attributesAndValue(entry.attributes, entry.value, child, membership, targetable);
        });
    }

    function attributesAndValue(head: readonly Attribute[], payload: Value, path: Path, membership: Membership | undefined, targetable: boolean): void {
        attributes(head, path, membership, targetable);
        value(payload, path, membership, targetable);
    }

    function bindings(entries: readonly Binding[], path: Path, parent: Membership | undefined, header = false, targetable = true): void {
        const object = scope(entries, entries.map(binding => binding.key));
        entries.forEach((binding, index) => {
            const key = header ? `aeon:${binding.key}` : binding.key;
            // Core selects the entire body payload over a colliding header
            // payload; header descendants and metadata cannot leak through.
            const visible = targetable && !(header && bodyKeys.has(key));
            attributesAndValue(binding.attributes, binding.value, [...path, key],
                { scope: object, entry: index, parent }, visible);
        });
    }

    function value(payload: Value, path: Path, membership: Membership | undefined, targetable: boolean): void {
        if (payload.type === 'TypedValue') {
            attributesAndValue(payload.attributes, payload.value, path, membership, targetable);
            return;
        }
        if (payload.type === 'ObjectNode' || payload.type === 'ListNode' || payload.type === 'TupleLiteral') {
            attributes(payload.attributes, path, membership, targetable);
        } else if (payload.type === 'NodeLiteral') {
            // Implicit node-head attributes have no addressable source path.
            // Their references still constrain all enclosing sortable scopes.
            attributes(payload.attributes, path, membership, false);
        }
        if (payload.type === 'CloneReference' || payload.type === 'PointerReference') {
            claims.push({ target: payload.path, membership });
        }
        // Availability precedes descendants, not completion of the subtree.
        // Metadata has already been visited before its attached payload.
        if (targetable) targets.set(pathKey(path), membership);
        if (payload.type === 'ObjectNode') {
            bindings(payload.bindings, path, membership, false, targetable);
        } else if (payload.type === 'ListNode' || payload.type === 'TupleLiteral' || payload.type === 'NodeLiteral') {
            const items = payload.type === 'NodeLiteral' ? payload.children : payload.elements;
            items.forEach((item, index) => value(item, [...path, index], membership, targetable));
        }
    }

    if (document.header) bindings(document.header.bindings, [], undefined, true);
    bindings(document.bindings, [], undefined);
    let edgeCount = 0;
    for (const claim of claims) {
        const targetKey = pathKey(claim.target);
        if (!targets.has(targetKey)) {
            throw new CanonicalOrderingError('CANONICAL_ORDERING_CONFLICT', 'A validated reference has no ordering target', document.span);
        }
        const sourceEntries = new Map<Scope, number>();
        for (let source = claim.membership; source; source = source.parent) sourceEntries.set(source.scope, source.entry);
        for (let target = targets.get(targetKey); target; target = target.parent) {
            const sourceEntry = sourceEntries.get(target.scope);
            if (sourceEntry === undefined || sourceEntry === target.entry) continue;
            const successors = target.scope.successors.get(target.entry) ?? new Set<number>();
            if (successors.has(sourceEntry)) continue;
            if (edgeCount >= maxEdges) {
                throw new CanonicalOrderingError('CANONICAL_ORDERING_LIMIT_EXCEEDED', `Canonical ordering exceeds ${maxEdges} dependency edges`, document.span);
            }
            edgeCount += 1;
            successors.add(sourceEntry);
            target.scope.successors.set(target.entry, successors);
            target.scope.indegree[sourceEntry]! += 1;
        }
    }
    return new Map(scopes.map(scope => [scope.identity, smallestEligibleOrder(scope, document.span)]));
}

function smallestEligibleOrder(scope: Scope, span: Span): readonly number[] {
    // A min-heap is necessary: each emitted entry can unlock a key smaller
    // than keys already eligible. Sorting a batch or using a comparator fails.
    const heap: number[] = [];
    const less = (a: number, b: number) => compareScalarKeys(scope.keys[a]!, scope.keys[b]!) < 0;
    function push(entry: number): void {
        let index = heap.length;
        heap.push(entry);
        while (index > 0) {
            const parent = (index - 1) >>> 1;
            if (!less(entry, heap[parent]!)) break;
            heap[index] = heap[parent]!;
            index = parent;
        }
        heap[index] = entry;
    }
    function pop(): number {
        const first = heap[0]!;
        const last = heap.pop()!;
        if (heap.length > 0) {
            let index = 0;
            while (2 * index + 1 < heap.length) {
                let child = 2 * index + 1;
                if (child + 1 < heap.length && less(heap[child + 1]!, heap[child]!)) child += 1;
                if (!less(heap[child]!, last)) break;
                heap[index] = heap[child]!;
                index = child;
            }
            heap[index] = last;
        }
        return first;
    }
    scope.indegree.forEach((count, index) => { if (count === 0) push(index); });
    const ordered: number[] = [];
    while (heap.length > 0) {
        const entry = pop();
        ordered.push(entry);
        for (const successor of scope.successors.get(entry) ?? []) {
            scope.indegree[successor]! -= 1;
            if (scope.indegree[successor] === 0) push(successor);
        }
    }
    if (ordered.length !== scope.keys.length) {
        throw new CanonicalOrderingError('CANONICAL_ORDERING_CONFLICT', 'Canonical ordering dependencies form a cycle', span);
    }
    return ordered;
}

/** Copy the parsed AST into its emission order; renderers must not re-sort it. */
export function reorderDocument(document: Document, orders?: Orders): Document {
    const legacyCompare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
    function ordered<T>(identity: object, entries: readonly T[], key: (entry: T) => string): readonly T[] {
        const indices = orders?.get(identity);
        if (orders && !indices) {
            throw new CanonicalOrderingError('CANONICAL_ORDERING_CONFLICT', 'A sortable scope has no canonical ordering plan', document.span);
        }
        return indices ? indices.map(index => entries[index]!) : [...entries].sort((a, b) => legacyCompare(key(a), key(b)));
    }
    function attributes(head: readonly Attribute[]): readonly Attribute[] {
        if (head.length === 0) return head;
        const entries = head.flatMap(attribute => [...attribute.entries]);
        return [{ ...head[0]!, entries: new Map(ordered(head, entries, ([key]) => key).map(([key, entry]) =>
            [key, { ...entry, attributes: attributes(entry.attributes), value: value(entry.value) } as AttributeValue])) }];
    }
    function bindings(entries: readonly Binding[]): readonly Binding[] {
        return ordered(entries, entries, binding => binding.key).map(binding => ({
            ...binding, attributes: attributes(binding.attributes), value: value(binding.value),
        }));
    }
    function value(payload: Value): Value {
        switch (payload.type) {
            case 'TypedValue': return { ...payload, attributes: attributes(payload.attributes), value: value(payload.value) };
            case 'ObjectNode': return { ...payload, attributes: attributes(payload.attributes), bindings: bindings(payload.bindings) };
            case 'ListNode':
            case 'TupleLiteral': return { ...payload, attributes: attributes(payload.attributes), elements: payload.elements.map(value) };
            case 'NodeLiteral': return { ...payload, attributes: attributes(payload.attributes), children: payload.children.map(value) };
            default: return payload;
        }
    }
    return { ...document, bindings: bindings(document.bindings), header: document.header
        ? { ...document.header, bindings: bindings(document.header.bindings) } : null };
}
