import { formatPath, type AssignmentEvent } from '@altopelago/aeon-aes';
import { tokenize, type Span, type Token, TokenType } from '@altopelago/aeon-lexer';

export type AnnotationKind = 'doc' | 'annotation' | 'hint' | 'reserved';
export type AnnotationForm = 'line' | 'block';
export type AnnotationReservedSubtype = 'structure' | 'profile' | 'instructions';
export type AnnotationPlacementPart =
    | 'key'
    | 'attributes'
    | 'attribute-marker'
    | 'attribute-open'
    | 'attribute-key'
    | 'attribute-datatype-colon'
    | 'attribute-datatype'
    | 'attribute-equals'
    | 'attribute-value'
    | 'attribute-separator'
    | 'attribute-close'
    | 'datatype-colon'
    | 'datatype'
    | 'equals'
    | 'value'
    | 'node-open'
    | 'node-tag'
    | 'node-datatype-colon'
    | 'node-datatype'
    | 'node-children-open'
    | 'node-child-value'
    | 'node-child-separator'
    | 'node-children-close'
    | 'node-close';

export interface AnnotationPlacement {
    readonly after?: AnnotationPlacementPart;
    readonly before?: AnnotationPlacementPart;
}

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
    readonly placement?: AnnotationPlacement;
}

export interface BuildAnnotationStreamInput {
    readonly tokens: readonly Token[];
    readonly events: readonly AssignmentEvent[];
    readonly spans?: readonly Span[];
}

interface Bindable {
    readonly span: Span;
    readonly valueSpan: Span;
    readonly valueType: AssignmentEvent['value']['type'];
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
    readonly byStart: readonly Bindable[];
    readonly byEnd: readonly Bindable[];
    readonly starts: readonly number[];
    readonly ends: readonly number[];
}

interface PlacementLandmark {
    readonly part: AnnotationPlacementPart;
    readonly span: Span;
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
            const nearestChild = nearestDescendant(commentSpan, container, this.descendantsByPath.get(container.path));
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
        valueSpan: event.value.span,
        valueType: event.value.type,
        path: formatPath(event.path),
        order,
    }));
    const eventByPath = new Map(input.events.map((event) => [formatPath(event.path), event]));
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
        const placement = resolvePlacement(token, target, eventByPath, input.tokens);
        if (placement) {
            (record as { placement: AnnotationPlacement }).placement = placement;
        }
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

function nearestDescendant(commentSpan: Span, container: Bindable, index: DescendantIndex | undefined): Bindable | null {
    if (!index) {
        return null;
    }
    const trailingIndex = upperBound(index.ends, commentSpan.start.offset) - 1;
    const forwardIndex = lowerBound(index.starts, commentSpan.end.offset);
    const trailingHit = trailingIndex >= 0 ? index.byEnd[trailingIndex] ?? null : null;
    const forwardHit = forwardIndex < index.byStart.length ? index.byStart[forwardIndex] ?? null : null;
    if (
        forwardHit
        && !trailingHit
        && shouldKeepCommentOnContainerBeforeDescendant(commentSpan, container, forwardHit)
    ) {
        return null;
    }
    if (trailingHit && forwardHit) {
        const trailingDistance = commentSpan.start.offset - trailingHit.span.end.offset;
        const forwardDistance = forwardHit.span.start.offset - commentSpan.end.offset;
        return forwardDistance <= trailingDistance ? forwardHit : trailingHit;
    }
    return forwardHit ?? trailingHit;
}

function shouldKeepCommentOnContainerBeforeDescendant(
    commentSpan: Span,
    container: Bindable,
    forwardHit: Bindable,
): boolean {
    if (commentSpan.end.offset <= container.valueSpan.start.offset) {
        return true;
    }
    return container.valueType === 'NodeLiteral'
        && commentSpan.start.offset >= container.valueSpan.start.offset
        && commentSpan.end.offset <= forwardHit.span.start.offset;
}

function resolvePlacement(
    comment: Token,
    target: AnnotationTarget,
    eventByPath: ReadonlyMap<string, AssignmentEvent>,
    tokens: readonly Token[],
): AnnotationPlacement | undefined {
    if (target.kind !== 'path') {
        return undefined;
    }
    const event = eventByPath.get(target.path);
    if (!event) {
        return undefined;
    }

    const landmarks = bindingLandmarks(event, tokens);
    if (landmarks.length === 0) {
        return undefined;
    }
    if (landmarks.some((landmark) => spansOverlapInterior(landmark.span, comment.span))) {
        return undefined;
    }

    const previous = landmarks
        .filter((landmark) => landmark.span.end.offset <= comment.span.start.offset)
        .at(-1);
    const next = landmarks.find((landmark) => landmark.span.start.offset >= comment.span.end.offset);
    if (!previous && !next) {
        return undefined;
    }

    return {
        ...(previous ? { after: previous.part } : {}),
        ...(next ? { before: next.part } : {}),
    };
}

function bindingLandmarks(event: AssignmentEvent, tokens: readonly Token[]): readonly PlacementLandmark[] {
    const eventTokens = tokens
        .filter((token) => token.type !== TokenType.EOF)
        .filter((token) => token.type !== TokenType.Newline)
        .filter((token) => !isCommentToken(token))
        .filter((token) => token.span.start.offset >= event.span.start.offset && token.span.end.offset <= event.span.end.offset);
    const topLevel = topLevelTokens(eventTokens);
    const key = topLevel[0];
    if (!key) {
        return [];
    }

    const valueSpan = event.value.span;
    const equals = topLevel
        .filter((token) => token.type === TokenType.Equals && token.span.end.offset <= valueSpan.start.offset)
        .at(-1);
    const headEnd = equals?.span.start.offset ?? valueSpan.start.offset;
    const attributes = findAttributesLandmarks(eventTokens, key.span.end.offset, headEnd);
    const attributeEnd = attributes.at(-1)?.span.end.offset ?? key.span.end.offset;
    const datatypeColon = topLevel.find((token) =>
        token.type === TokenType.Colon
        && token.span.start.offset >= attributeEnd
        && token.span.end.offset <= headEnd
    );
    const datatype = datatypeColon ? findDatatypeLandmark(eventTokens, datatypeColon.span.end.offset, headEnd) : undefined;
    const valueLandmarks = event.value.type === 'NodeLiteral'
        ? findNodeValueLandmarks(eventTokens, valueSpan)
        : [{ part: 'value' as const, span: valueSpan }];

    return [
        { part: 'key' as const, span: key.span },
        ...attributes,
        ...(datatypeColon ? [{ part: 'datatype-colon' as const, span: datatypeColon.span }] : []),
        ...(datatype ? [datatype] : []),
        ...(equals ? [{ part: 'equals' as const, span: equals.span }] : []),
        ...valueLandmarks,
    ].sort(compareLandmarks);
}

function isCommentToken(token: Token): boolean {
    return token.type === TokenType.LineComment || token.type === TokenType.BlockComment;
}

function topLevelTokens(tokens: readonly Token[]): readonly Token[] {
    const result: Token[] = [];
    let depth = 0;
    for (const token of tokens) {
        if (depth === 0) {
            result.push(token);
        }
        depth += depthDelta(token);
        if (depth < 0) {
            depth = 0;
        }
    }
    return result;
}

function depthDelta(token: Token): number {
    switch (token.type) {
        case TokenType.LeftBrace:
        case TokenType.LeftBracket:
        case TokenType.LeftParen:
        case TokenType.LeftAngle:
            return 1;
        case TokenType.RightBrace:
        case TokenType.RightBracket:
        case TokenType.RightParen:
        case TokenType.RightAngle:
            return -1;
        default:
            return 0;
    }
}

function findAttributesLandmarks(
    tokens: readonly Token[],
    afterOffset: number,
    beforeOffset: number,
): readonly PlacementLandmark[] {
    const landmarks: PlacementLandmark[] = [];
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index]!;
        if (
            token.type !== TokenType.At
            || token.span.start.offset < afterOffset
            || token.span.end.offset > beforeOffset
        ) {
            index += 1;
            continue;
        }

        const attrLandmarks = scanAttributeLandmarks(tokens, index, beforeOffset);
        landmarks.push(...attrLandmarks.landmarks);
        index = Math.max(index + 1, attrLandmarks.nextIndex);
    }
    return landmarks;
}

function scanAttributeLandmarks(
    tokens: readonly Token[],
    atIndex: number,
    beforeOffset: number,
): { readonly landmarks: readonly PlacementLandmark[]; readonly nextIndex: number } {
    const at = tokens[atIndex]!;
    const landmarks: PlacementLandmark[] = [{ part: 'attribute-marker', span: at.span }];
    let index = atIndex + 1;
    let depth = 0;
    let entryPart: 'key' | 'datatype' | 'value' = 'key';
    let opened = false;

    while (index < tokens.length) {
        const token = tokens[index]!;
        if (token.span.start.offset > beforeOffset) {
            break;
        }
        if (token.type === TokenType.LeftBrace) {
            depth += 1;
            landmarks.push({ part: opened ? 'attribute-value' : 'attribute-open', span: token.span });
            opened = true;
            index += 1;
            continue;
        }
        if (token.type === TokenType.RightBrace) {
            if (depth <= 1) {
                landmarks.push({ part: 'attribute-close', span: token.span });
                return { landmarks, nextIndex: index + 1 };
            }
            depth -= 1;
            landmarks.push({ part: 'attribute-value', span: token.span });
            index += 1;
            continue;
        }
        if (depth === 1) {
            switch (token.type) {
                case TokenType.Colon:
                    landmarks.push({ part: 'attribute-datatype-colon', span: token.span });
                    entryPart = 'datatype';
                    break;
                case TokenType.Equals:
                    landmarks.push({ part: 'attribute-equals', span: token.span });
                    entryPart = 'value';
                    break;
                case TokenType.Comma:
                    landmarks.push({ part: 'attribute-separator', span: token.span });
                    entryPart = 'key';
                    break;
                default:
                    if (isSemanticToken(token)) {
                        landmarks.push({ part: attributeEntryPart(entryPart), span: token.span });
                    }
                    break;
            }
        } else if (depth > 1 && isSemanticToken(token)) {
            landmarks.push({ part: 'attribute-value', span: token.span });
        }
        index += 1;
    }

    return { landmarks, nextIndex: index };
}

function attributeEntryPart(part: 'key' | 'datatype' | 'value'): AnnotationPlacementPart {
    if (part === 'key') {
        return 'attribute-key';
    }
    if (part === 'datatype') {
        return 'attribute-datatype';
    }
    return 'attribute-value';
}

function findNodeValueLandmarks(tokens: readonly Token[], valueSpan: Span): readonly PlacementLandmark[] {
    const valueTokens = tokens.filter((token) =>
        token.span.start.offset >= valueSpan.start.offset
        && token.span.end.offset <= valueSpan.end.offset
    );
    const landmarks: PlacementLandmark[] = [];
    let angleDepth = 0;
    let parenDepth = 0;
    let state: 'open' | 'tag' | 'datatype' | 'children' | 'done' = 'open';

    for (const token of valueTokens) {
        if (token.type === TokenType.LeftAngle && angleDepth === 0) {
            landmarks.push({ part: 'node-open', span: token.span });
            angleDepth = 1;
            state = 'tag';
            continue;
        }
        if (token.type === TokenType.RightAngle && angleDepth === 1 && parenDepth === 0) {
            landmarks.push({ part: 'node-close', span: token.span });
            state = 'done';
            continue;
        }
        if (state === 'tag' && isSemanticToken(token)) {
            landmarks.push({ part: 'node-tag', span: token.span });
            state = 'open';
            continue;
        }
        if (angleDepth === 1 && parenDepth === 0 && token.type === TokenType.Colon) {
            landmarks.push({ part: 'node-datatype-colon', span: token.span });
            state = 'datatype';
            continue;
        }
        if (state === 'datatype' && isSemanticToken(token)) {
            landmarks.push({ part: 'node-datatype', span: token.span });
            continue;
        }
        if (angleDepth === 1 && token.type === TokenType.LeftParen) {
            parenDepth += 1;
            landmarks.push({ part: parenDepth === 1 ? 'node-children-open' : 'value', span: token.span });
            state = 'children';
            continue;
        }
        if (angleDepth === 1 && token.type === TokenType.RightParen) {
            if (parenDepth === 1) {
                landmarks.push({ part: 'node-children-close', span: token.span });
            }
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
        }
        if (angleDepth === 1 && parenDepth === 1 && token.type === TokenType.Comma) {
            landmarks.push({ part: 'node-child-separator', span: token.span });
            continue;
        }
        if (angleDepth === 1 && parenDepth === 1 && isSemanticToken(token)) {
            landmarks.push({ part: 'node-child-value', span: token.span });
        }
    }

    return landmarks.length > 0 ? landmarks : [{ part: 'value', span: valueSpan }];
}

function findDatatypeLandmark(
    tokens: readonly Token[],
    afterOffset: number,
    beforeOffset: number,
): PlacementLandmark | undefined {
    const datatypeTokens = tokens.filter((token) =>
        token.span.start.offset >= afterOffset
        && token.span.end.offset <= beforeOffset
        && token.type !== TokenType.Equals
    );
    const first = datatypeTokens[0];
    const last = datatypeTokens.at(-1);
    if (!first || !last) {
        return undefined;
    }
    return {
        part: 'datatype',
        span: { start: first.span.start, end: last.span.end },
    };
}

function spansOverlapInterior(left: Span, right: Span): boolean {
    return left.start.offset < right.end.offset && right.start.offset < left.end.offset;
}

function compareLandmarks(left: PlacementLandmark, right: PlacementLandmark): number {
    const start = left.span.start.offset - right.span.start.offset;
    if (start !== 0) {
        return start;
    }
    return landmarkSpecificity(left.part) - landmarkSpecificity(right.part);
}

function landmarkSpecificity(part: AnnotationPlacementPart): number {
    return part === 'value' || part === 'attributes' ? 1 : 0;
}

function isSemanticToken(token: Token): boolean {
    return token.type !== TokenType.Newline
        && token.type !== TokenType.EOF
        && !isCommentToken(token);
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
        const byStart = [...items].sort((left, right) => left.span.start.offset - right.span.start.offset);
        const byEnd = [...items].sort((left, right) => left.span.end.offset - right.span.end.offset);
        indexed.set(path, {
            byStart,
            byEnd,
            starts: byStart.map((item) => item.span.start.offset),
            ends: byEnd.map((item) => item.span.end.offset),
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
