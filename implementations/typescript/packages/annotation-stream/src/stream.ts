import { formatPath, type AssignmentEvent } from '@aeon/aes';
import { tokenize, type Span, type Token, TokenType } from '@aeon/lexer';

export type AnnotationKind = 'doc' | 'annotation' | 'hint' | 'reserved';
export type AnnotationForm = 'line' | 'block';
export type AnnotationReservedSubtype = 'structure' | 'profile' | 'instructions';

export interface AnnotationTargetPath {
    readonly kind: 'path';
    readonly path: string;
}

export interface AnnotationTargetSpan {
    readonly kind: 'span';
    readonly span: Span;
}

export interface AnnotationTargetUnbound {
    readonly kind: 'unbound';
    readonly reason: 'eof' | 'no_bindable';
}

export type AnnotationTarget = AnnotationTargetPath | AnnotationTargetSpan | AnnotationTargetUnbound;

export interface AnnotationRecord {
    readonly kind: AnnotationKind;
    readonly form: AnnotationForm;
    readonly raw: string;
    readonly span: Span;
    readonly target: AnnotationTarget;
    readonly subtype?: AnnotationReservedSubtype;
}

export interface BuildAnnotationStreamInput {
    readonly tokens: readonly Token[];
    readonly events: readonly AssignmentEvent[];
    readonly spans?: readonly Span[];
}

interface Bindable {
    readonly span: Span;
    readonly path: string;
    readonly order: number;
}

interface SpanBindable {
    readonly span: Span;
    readonly order: number;
}

interface TrailingIndex<T> {
    readonly items: readonly T[];
    readonly offsets: readonly number[];
}

interface DescendantIndex {
    readonly items: readonly Bindable[];
    readonly starts: readonly number[];
    readonly ends: readonly number[];
}

class AnnotationResolver {
    private readonly pathBindables: readonly Bindable[];
    private readonly spanBindables: readonly SpanBindable[];
    private readonly pathByStart: readonly Bindable[];
    private readonly pathStarts: readonly number[];
    private readonly pathTrailingByLine: ReadonlyMap<number, TrailingIndex<Bindable>>;
    private readonly descendantsByPath: ReadonlyMap<string, DescendantIndex>;
    private readonly spanByStart: readonly SpanBindable[];
    private readonly spanStarts: readonly number[];
    private readonly spanTrailingByLine: ReadonlyMap<number, TrailingIndex<SpanBindable>>;
    private pathCursor = 0;
    private pathActive: Bindable[] = [];
    private spanCursor = 0;
    private spanActive: SpanBindable[] = [];

    constructor(pathBindables: readonly Bindable[], spanBindables: readonly SpanBindable[]) {
        this.pathBindables = pathBindables;
        this.spanBindables = spanBindables;
        this.pathByStart = [...pathBindables].sort((left, right) => left.span.start.offset - right.span.start.offset);
        this.pathStarts = this.pathByStart.map((bindable) => bindable.span.start.offset);
        this.pathTrailingByLine = buildTrailingIndex(pathBindables);
        this.descendantsByPath = buildDescendantIndex(pathBindables);
        this.spanByStart = [...spanBindables].sort((left, right) => left.span.start.offset - right.span.start.offset);
        this.spanStarts = this.spanByStart.map((bindable) => bindable.span.start.offset);
        this.spanTrailingByLine = buildTrailingIndex(spanBindables);
    }

    resolveTarget(commentSpan: Span): AnnotationTarget {
        if (this.pathBindables.length === 0 && this.spanBindables.length === 0) {
            return { kind: 'unbound', reason: 'no_bindable' };
        }

        const pathTarget = this.resolvePathTarget(commentSpan);
        if (pathTarget) {
            return pathTarget;
        }

        const spanTarget = this.resolveSpanTarget(commentSpan);
        if (spanTarget) {
            return spanTarget;
        }

        return { kind: 'unbound', reason: 'eof' };
    }

    private resolvePathTarget(commentSpan: Span): AnnotationTargetPath | null {
        this.pathActive = advanceActiveBindables(commentSpan, this.pathByStart, this.pathActive, this.pathCursor);
        this.pathCursor += countNewlyActive(commentSpan, this.pathByStart, this.pathCursor);

        const container = smallestContaining(commentSpan, this.pathActive);
        if (container) {
            const nearestChild = nearestDescendant(commentSpan, this.descendantsByPath.get(container.path));
            if (nearestChild) {
                return { kind: 'path', path: nearestChild.path };
            }
            return { kind: 'path', path: container.path };
        }

        const trailing = nearestTrailingSameLine(commentSpan, this.pathTrailingByLine);
        if (trailing) {
            return { kind: 'path', path: trailing.path };
        }

        const forward = firstForward(commentSpan, this.pathByStart, this.pathStarts);
        if (forward) {
            return { kind: 'path', path: forward.path };
        }

        return null;
    }

    private resolveSpanTarget(commentSpan: Span): AnnotationTargetSpan | null {
        this.spanActive = advanceActiveBindables(commentSpan, this.spanByStart, this.spanActive, this.spanCursor);
        this.spanCursor += countNewlyActive(commentSpan, this.spanByStart, this.spanCursor);

        const container = smallestContaining(commentSpan, this.spanActive);
        if (container) {
            return { kind: 'span', span: container.span };
        }

        const trailing = nearestTrailingSameLine(commentSpan, this.spanTrailingByLine);
        if (trailing) {
            return { kind: 'span', span: trailing.span };
        }

        const forward = firstForward(commentSpan, this.spanByStart, this.spanStarts);
        if (forward) {
            return { kind: 'span', span: forward.span };
        }

        return null;
    }
}

export function buildAnnotationStream(input: BuildAnnotationStreamInput): readonly AnnotationRecord[] {
    const bindables = input.events.map((event, order) => ({
        span: event.span,
        path: formatPath(event.path),
        order,
    }));
    const spanBindables = (input.spans ?? []).map((span, order) => ({ span, order }));
    const resolver = new AnnotationResolver(bindables, spanBindables);

    const records: AnnotationRecord[] = [];
    for (const token of input.tokens) {
        if (token.type !== TokenType.LineComment && token.type !== TokenType.BlockComment) {
            continue;
        }
        if (!token.comment) {
            continue;
        }
        if (token.comment.channel === 'plain' || token.comment.channel === 'host') {
            continue;
        }

        const target = resolver.resolveTarget(token.span);
        const record: AnnotationRecord = {
            kind: token.comment.channel,
            form: token.comment.form,
            raw: token.value,
            span: token.span,
            target,
        };
        if (token.comment.subtype) {
            (record as { subtype: AnnotationReservedSubtype }).subtype = token.comment.subtype;
        }
        records.push(record);
    }

    return records;
}

export function buildAnnotationStreamFromSource(source: string, events: readonly AssignmentEvent[]): readonly AnnotationRecord[] {
    return buildAnnotationStreamFromSourceAndSpans(source, events, []);
}

export function buildAnnotationStreamFromSourceAndSpans(
    source: string,
    events: readonly AssignmentEvent[],
    spans: readonly Span[],
): readonly AnnotationRecord[] {
    const lexResult = tokenize(source, { includeComments: true });
    if (lexResult.errors.length > 0) {
        return [];
    }
    return buildAnnotationStream({ tokens: lexResult.tokens, events, spans });
}

function spanContains(outer: Span, inner: Span): boolean {
    return outer.start.offset <= inner.start.offset && outer.end.offset >= inner.end.offset;
}

function spanLength(span: Span): number {
    return span.end.offset - span.start.offset;
}

function containingKey(bindable: { readonly span: Span; readonly order: number }): readonly [number, number] {
    return [spanLength(bindable.span), bindable.order];
}

function smallestContaining<T extends { readonly span: Span; readonly order: number }>(
    commentSpan: Span,
    bindables: readonly T[],
): T | null {
    let best: T | null = null;
    for (const bindable of bindables) {
        if (!spanContains(bindable.span, commentSpan)) {
            continue;
        }
        if (!best) {
            best = bindable;
            continue;
        }
        const [leftLen, leftOrder] = containingKey(bindable);
        const [rightLen, rightOrder] = containingKey(best);
        if (leftLen < rightLen || (leftLen === rightLen && leftOrder < rightOrder)) {
            best = bindable;
        }
    }
    return best;
}

function nearestDescendant(commentSpan: Span, index: DescendantIndex | undefined): Bindable | null {
    if (!index) {
        return null;
    }
    const trailingIndex = upperBound(index.ends, commentSpan.start.offset) - 1;
    const forwardIndex = lowerBound(index.starts, commentSpan.end.offset);
    const trailingHit = trailingIndex >= 0 ? index.items[trailingIndex] ?? null : null;
    const forwardHit = forwardIndex < index.items.length ? index.items[forwardIndex] ?? null : null;
    if (trailingHit && forwardHit) {
        const trailingDistance = commentSpan.start.offset - trailingHit.span.end.offset;
        const forwardDistance = forwardHit.span.start.offset - commentSpan.end.offset;
        return forwardDistance <= trailingDistance ? forwardHit : trailingHit;
    }
    return forwardHit ?? trailingHit;
}

function buildDescendantIndex(bindables: readonly Bindable[]): ReadonlyMap<string, DescendantIndex> {
    const grouped = new Map<string, Bindable[]>();
    for (const bindable of bindables) {
        const ancestors = ancestorPaths(bindable.path);
        for (let index = 0; index < ancestors.length - 1; index += 1) {
            const ancestor = ancestors[index]!;
            const items = grouped.get(ancestor);
            if (items) {
                items.push(bindable);
            } else {
                grouped.set(ancestor, [bindable]);
            }
        }
    }
    const indexed = new Map<string, DescendantIndex>();
    for (const [path, items] of grouped.entries()) {
        items.sort((left, right) => left.span.start.offset - right.span.start.offset);
        indexed.set(path, {
            items,
            starts: items.map((item) => item.span.start.offset),
            ends: items.map((item) => item.span.end.offset),
        });
    }
    return indexed;
}

function ancestorPaths(path: string): string[] {
    const result = ['$'];
    let index = 1;
    while (index < path.length) {
        const marker = path[index];
        if (marker === '.') {
            index += 1;
            while (index < path.length && path[index] !== '.' && path[index] !== '[') {
                index += 1;
            }
            result.push(path.slice(0, index));
            continue;
        }
        if (marker === '[') {
            index += 1;
            while (index < path.length && path[index] !== ']') {
                index += 1;
            }
            if (index < path.length) {
                index += 1;
            }
            result.push(path.slice(0, index));
            continue;
        }
        index += 1;
    }
    return result;
}

function buildTrailingIndex<T extends { readonly span: Span }>(bindables: readonly T[]): ReadonlyMap<number, TrailingIndex<T>> {
    const grouped = new Map<number, T[]>();
    for (const bindable of bindables) {
        const items = grouped.get(bindable.span.end.line);
        if (items) {
            items.push(bindable);
        } else {
            grouped.set(bindable.span.end.line, [bindable]);
        }
    }

    const indexed = new Map<number, TrailingIndex<T>>();
    for (const [line, items] of grouped.entries()) {
        items.sort((left, right) => left.span.end.offset - right.span.end.offset);
        indexed.set(line, {
            items,
            offsets: items.map((item) => item.span.end.offset),
        });
    }
    return indexed;
}

function nearestTrailingSameLine<T extends { readonly span: Span }>(
    commentSpan: Span,
    trailingByLine: ReadonlyMap<number, TrailingIndex<T>>,
): T | null {
    const entry = trailingByLine.get(commentSpan.start.line);
    if (!entry) {
        return null;
    }
    const index = upperBound(entry.offsets, commentSpan.start.offset) - 1;
    if (index < 0) {
        return null;
    }
    return entry.items[index] ?? null;
}

function firstForward<T extends { readonly span: Span }>(
    commentSpan: Span,
    byStart: readonly T[],
    starts: readonly number[],
): T | null {
    const index = lowerBound(starts, commentSpan.end.offset);
    return byStart[index] ?? null;
}

function countNewlyActive<T extends { readonly span: Span }>(
    commentSpan: Span,
    byStart: readonly T[],
    cursor: number,
): number {
    let next = cursor;
    while (next < byStart.length && byStart[next]!.span.start.offset <= commentSpan.start.offset) {
        next += 1;
    }
    return next - cursor;
}

function advanceActiveBindables<T extends { readonly span: Span }>(
    commentSpan: Span,
    byStart: readonly T[],
    active: readonly T[],
    cursor: number,
): T[] {
    const next = active.filter((bindable) => bindable.span.end.offset >= commentSpan.end.offset);
    let index = cursor;
    while (index < byStart.length && byStart[index]!.span.start.offset <= commentSpan.start.offset) {
        next.push(byStart[index]!);
        index += 1;
    }
    return next;
}

function lowerBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid]! < target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

function upperBound(values: readonly number[], target: number): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (values[mid]! <= target) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}
