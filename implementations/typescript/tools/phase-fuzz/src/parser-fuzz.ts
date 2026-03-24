import { tokenize, type Span } from '@aeon/lexer';
import { parse, type ASTNode, type Document, type ParserError, type Value, type Binding, type Attribute, type AttributeValue } from '@aeon/parser';
import { buildParserCorpus } from './corpus.js';
import { createPrng } from './prng.js';
import type { FuzzRunOptions, FuzzRunSummary } from './lexer-fuzz.js';
import { PARSER_REGRESSION_CASES } from './regressions.js';

export function runParserFuzz(options: FuzzRunOptions): FuzzRunSummary {
    const generatedCorpus = buildParserCorpus(createPrng(options.seed), options.cases, options.maxLength);
    const cases = [
        ...PARSER_REGRESSION_CASES.map((entry) => ({ id: entry.id, source: entry.source })),
        ...generatedCorpus.map((source, index) => ({ id: `generated-${index}`, source })),
    ];

    cases.forEach((entry) => {
        verifyParserCase(entry.source, entry.id);
    });

    return {
        lane: 'parser',
        cases: cases.length,
        regressionCases: PARSER_REGRESSION_CASES.length,
        seed: options.seed,
    };
}

function verifyParserCase(source: string, caseId: string): void {
    const first = safeParse(source, caseId);
    const second = safeParse(source, caseId);
    const richInput = safeParseFromRichTokenization(source, caseId);

    const firstSignature = parseResultSignature(first.document, first.errors);
    const secondSignature = parseResultSignature(second.document, second.errors);
    const richSignature = parseResultSignature(richInput.document, richInput.errors);

    if (firstSignature !== secondSignature) {
        throw new Error(`parser case ${caseId} is non-deterministic`);
    }
    if (firstSignature !== richSignature) {
        throw new Error(`parser case ${caseId} diverged when comments/newlines were lexed then filtered`);
    }

    for (const error of first.errors) {
        validateSpan(error.span, source.length, `parser error ${error.code}`, caseId);
        if (!error.code) {
            throw new Error(`parser case ${caseId} produced an error without a code`);
        }
    }

    if (first.document) {
        validateDocument(first.document, source.length, caseId);
    }
}

function safeParse(source: string, caseId: string) {
    try {
        const lexed = tokenize(source);
        return parse(lexed.tokens);
    } catch (error) {
        throw new Error(`parser case ${caseId} crashed: ${String(error)}`);
    }
}

function safeParseFromRichTokenization(source: string, caseId: string) {
    try {
        const lexed = tokenize(source, { includeComments: true, includeNewlines: true });
        const filteredTokens = lexed.tokens.filter((token) =>
            token.type !== 'LineComment'
            && token.type !== 'BlockComment'
            && token.type !== 'Newline'
        );
        return parse(filteredTokens);
    } catch (error) {
        throw new Error(`parser case ${caseId} crashed after rich token filtering: ${String(error)}`);
    }
}

function parseResultSignature(document: Document | null, errors: readonly ParserError[]): string {
    return JSON.stringify({
        document: document ? normalizeDocument(document) : null,
        errors: errors.map((error) => ({
            code: error.code,
            message: error.message,
            start: error.span.start.offset,
            end: error.span.end.offset,
        })),
    });
}

function normalizeDocument(document: Document): object {
    return normalizeNode(document);
}

type HeaderLike = Extract<Document['header'], { fields: ReadonlyMap<string, Value> }>;
type EnvelopeLike = NonNullable<Document['envelope']>;

function normalizeNode(node: ASTNode): object {
    if ('type' in node === false) {
        return { span: normalizeSpan(node.span) };
    }

    switch ((node as { type: string }).type) {
        case 'Document': {
            const document = node as Document;
            return {
                type: document.type,
                span: normalizeSpan(document.span),
                header: document.header ? normalizeNode(document.header) : null,
                envelope: document.envelope ? normalizeNode(document.envelope) : null,
                bindings: document.bindings.map(normalizeNode),
            };
        }
        case 'Header':
        case 'Envelope': {
            const container = node as HeaderLike | EnvelopeLike;
            const fields = Array.from(container.fields.entries())
                .map((entry) => [entry[0], normalizeValue(entry[1])] as const)
                .sort((a, b) => a[0].localeCompare(b[0]));
            return {
                type: (node as { type: string }).type,
                span: normalizeSpan(node.span),
                ...('bindings' in container ? { bindings: (container as HeaderLike & { bindings: readonly Binding[] }).bindings.map(normalizeNode) } : {}),
                fields,
            };
        }
        case 'Binding': {
            const binding = node as Binding;
            return {
                type: binding.type,
                span: normalizeSpan(binding.span),
                key: binding.key,
                datatype: binding.datatype ? normalizeNode(binding.datatype) : null,
                attributes: binding.attributes.map(normalizeNode),
                value: normalizeValue(binding.value),
            };
        }
        case 'TypeAnnotation': {
            const typeAnnotation = node as { type: 'TypeAnnotation'; name: string; genericArgs: readonly string[]; separators: readonly string[]; span: Span };
            return {
                type: typeAnnotation.type,
                span: normalizeSpan(typeAnnotation.span),
                name: typeAnnotation.name,
                genericArgs: [...typeAnnotation.genericArgs],
                separators: [...typeAnnotation.separators],
            };
        }
        case 'Attribute': {
            const attribute = node as Attribute;
            return {
                type: attribute.type,
                span: normalizeSpan(attribute.span),
                entries: Array.from(attribute.entries.entries())
                    .map((entry) => [entry[0], normalizeAttributeValue(entry[1])] as const)
                    .sort((a, b) => a[0].localeCompare(b[0])),
            };
        }
        default:
            return normalizeValue(node as Value);
    }
}

function normalizeAttributeValue(value: AttributeValue): object {
    return {
        datatype: value.datatype ? normalizeNode(value.datatype) : null,
        attributes: value.attributes.map(normalizeNode),
        value: normalizeValue(value.value),
    };
}

function normalizeValue(value: Value): object {
    const base = {
        type: value.type,
        span: normalizeSpan(value.span),
    };

    switch (value.type) {
        case 'StringLiteral':
            return { ...base, value: value.value, raw: value.raw, delimiter: value.delimiter };
        case 'NumberLiteral':
        case 'HexLiteral':
        case 'RadixLiteral':
        case 'EncodingLiteral':
        case 'SeparatorLiteral':
        case 'DateLiteral':
        case 'DateTimeLiteral':
        case 'TimeLiteral':
            return { ...base, value: value.value, raw: value.raw };
        case 'BooleanLiteral':
        case 'SwitchLiteral':
            return { ...base, value: value.value, raw: value.raw };
        case 'CloneReference':
        case 'PointerReference':
            return { ...base, path: value.path };
        case 'ObjectNode':
            return { ...base, attributes: value.attributes.map(normalizeNode), bindings: value.bindings.map(normalizeNode) };
        case 'ListNode':
            return { ...base, attributes: value.attributes.map(normalizeNode), elements: value.elements.map(normalizeValue) };
        case 'TupleLiteral':
            return { ...base, attributes: value.attributes.map(normalizeNode), elements: value.elements.map(normalizeValue), raw: value.raw };
        case 'NodeLiteral':
            return {
                ...base,
                tag: value.tag,
                datatype: value.datatype ? normalizeNode(value.datatype) : null,
                attributes: value.attributes.map(normalizeNode),
                children: value.children.map(normalizeValue),
            };
        default:
            throw new Error(`Unhandled value type in parser fuzz normalizer: ${(value as { type: string }).type}`);
    }
}

function validateDocument(document: Document, sourceLength: number, caseId: string): void {
    validateSpan(document.span, sourceLength, 'document', caseId);
    if (document.header) {
        validateNode(document.header, document.span, sourceLength, caseId);
    }
    if (document.envelope) {
        validateNode(document.envelope, document.span, sourceLength, caseId);
    }
    for (const binding of document.bindings) {
        validateNode(binding, document.span, sourceLength, caseId);
    }
}

function validateNode(node: ASTNode, parentSpan: Span, sourceLength: number, caseId: string): void {
    validateSpan(node.span, sourceLength, `node`, caseId);
    ensureWithin(node.span, parentSpan, caseId);

    if (!('type' in node)) {
        return;
    }

    switch ((node as { type: string }).type) {
        case 'Header':
        case 'Envelope': {
            const fields = (node as unknown as { fields: ReadonlyMap<string, Value> }).fields;
            if ('bindings' in node) {
                for (const binding of (node as unknown as { bindings: readonly Binding[] }).bindings) {
                    validateNode(binding, node.span, sourceLength, caseId);
                }
            }
            for (const [, value] of fields.entries()) {
                validateValue(value, node.span, sourceLength, caseId);
            }
            return;
        }
        case 'Binding': {
            const binding = node as Binding;
            if (binding.datatype) {
                validateNode(binding.datatype, binding.span, sourceLength, caseId);
            }
            for (const attribute of binding.attributes) {
                validateNode(attribute, binding.span, sourceLength, caseId);
            }
            validateValue(binding.value, binding.span, sourceLength, caseId);
            return;
        }
        case 'TypeAnnotation':
            return;
        case 'Attribute': {
            const attribute = node as Attribute;
            for (const [, entry] of attribute.entries.entries()) {
                if (entry.datatype) {
                    validateNode(entry.datatype, attribute.span, sourceLength, caseId);
                }
                for (const nested of entry.attributes) {
                    validateNode(nested, attribute.span, sourceLength, caseId);
                }
                validateValue(entry.value, attribute.span, sourceLength, caseId);
            }
            return;
        }
        default:
            validateValue(node as Value, parentSpan, sourceLength, caseId);
    }
}

function validateValue(value: Value, parentSpan: Span, sourceLength: number, caseId: string): void {
    validateSpan(value.span, sourceLength, value.type, caseId);
    ensureWithin(value.span, parentSpan, caseId);

    switch (value.type) {
        case 'ObjectNode':
            for (const attribute of value.attributes) {
                validateNode(attribute, value.span, sourceLength, caseId);
            }
            for (const binding of value.bindings) {
                validateNode(binding, value.span, sourceLength, caseId);
            }
            return;
        case 'ListNode':
            for (const attribute of value.attributes) {
                validateNode(attribute, value.span, sourceLength, caseId);
            }
            for (const element of value.elements) {
                validateValue(element, value.span, sourceLength, caseId);
            }
            return;
        case 'TupleLiteral':
            for (const attribute of value.attributes) {
                validateNode(attribute, value.span, sourceLength, caseId);
            }
            for (const element of value.elements) {
                validateValue(element, value.span, sourceLength, caseId);
            }
            return;
        case 'NodeLiteral':
            if (value.datatype) {
                validateNode(value.datatype, value.span, sourceLength, caseId);
            }
            for (const attribute of value.attributes) {
                validateNode(attribute, value.span, sourceLength, caseId);
            }
            for (const child of value.children) {
                validateValue(child, value.span, sourceLength, caseId);
            }
            return;
        default:
            return;
    }
}

function validateSpan(span: Span, sourceLength: number, label: string, caseId: string): void {
    if (span.start.offset < 0 || span.end.offset < 0 || span.start.offset > span.end.offset || span.end.offset > sourceLength) {
        throw new Error(`parser case ${caseId} has out-of-bounds span for ${label}`);
    }
    if (span.start.line < 1 || span.start.column < 1 || span.end.line < 1 || span.end.column < 1) {
        throw new Error(`parser case ${caseId} has invalid line/column values for ${label}`);
    }
}

function ensureWithin(child: Span, parent: Span, caseId: string): void {
    if (child.start.offset < parent.start.offset || child.end.offset > parent.end.offset) {
        throw new Error(`parser case ${caseId} has a child span outside its parent span`);
    }
}

function normalizeSpan(span: Span): object {
    return {
        start: span.start.offset,
        end: span.end.offset,
    };
}
