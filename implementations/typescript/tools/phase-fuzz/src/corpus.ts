import type { PRNG } from './prng.js';
import { tokenize } from '@altopelago/aeon-lexer';
import { parse } from '@altopelago/aeon-parser';

const CHARSET = [
    'a', 'b', 'c', 'x', 'y', 'z',
    '0', '1', '2', '7', '9',
    ' ', '\n', '\r', '\t',
    '{', '}', '[', ']', '(', ')', '<', '>',
    ':', '=', ',', '.', '@', '~', '^', '#', '$', '%', '&', ';',
    '/', '?', '!', '+', '-', '_', '"', "'", '`',
    '\\',
    '\u0000', '\u0007', '\u001b', '\u007f',
    '\u00a9', '\u03bb', '\u2028', '\ufeff',
];

const LEXER_BASELINES = [
    '',
    'a = 1',
    'a = "x"',
    "a = 'x'",
    'a = `x\n  y`',
    'a = { b = 1 }',
    'a = [1, 2, 3]',
    'a = #(FF00AA)',
    'a = <div("x")>',
    'a = (1, 2, 3)',
    '//# doc\na = 1',
    '//? hint\na = 1',
    '//{ structure\n<[x]>',
    '/[ if $.x ]/\na = 1',
    '/( color: red; )/\na = 1',
    'a = ~b',
    'a = ~>b',
    'a = $.b',
    'a = 2026-03-12',
    'a = 2026-03-12T12:30:45Z',
    'a = 12:30:45+10:00',
    'a = &Base64SGVsbG8=',
    'a = %101010',
    'a = ^alpha\\,beta',
    'a@{x = 1}:number = 1',
    'a@{style = "x", data = <div()>} = <div@{class = "hero"}("x")>',
    'aeon:mode = "strict"\r\na = 1\r\nb = 2',
    '\ufeffa = 1',
    '"unterminated',
    "'unterminated",
    '`unterminated',
    '"\\u{110000}"',
    '"\\u0G00"',
    '/# block',
    '/* block',
    '//(',
    '/(',
    '<tag(',
    'a = [1, 2',
    'a = { b = [ <x(~y)> ] }',
];

const PARSER_BASELINES = [
    'a = 1',
    'a = { b = 1 }',
    'a = [1, 2, 3]',
    'a = <h1("title")>',
    'a = <main@{class = "hero"}(<h1("title")>, <p("copy")>)>',
    'a = (1, 2, 3)',
    'a = ~b',
    'a = ~>b',
    'a = $.b',
    'a:number = 1',
    'a:date = 2026-03-12',
    'a = ^x\\,y',
    'a@{class = "hero"} = <div("x")>',
    'a = [1, { b = 2 }, <x()>]',
    'aeon:mode = "strict"\na = 1\nb = <x(~a)>',
    'aeon:header = { mode = "strict", profile = "core" }\na = 1',
    'a = "x"\nb = `y\n  z`\nc = false',
    'a = [1,',
    'a = {',
    'a = <x(',
    'a = ~',
    'aeon:mode = "strict"\na =',
    'a@{ = 1',
    'a = <x@{class = }()>',
    'a = (1,',
    'a = <x(~>y, [1, 2)>',
];

const DUPLICATE_GRAMMAR_BASELINES = [
    'a = 1',
    'a = "hello"',
    'a:string = "hello"',
    'count:number = 2',
    'greeting = <div("hello")>',
    'a@{a = 1, b = 2} = "hello"',
    'hero@{class = "hero", role = "banner"} = <section("hello")>',
    'path = ~item.title',
    'pointer = ~>item.title',
    'items = [1, 2, 3]',
    'tuple = (1, 2, 3)',
    'obj = { a = 1, b = 2 }',
    'flag = true',
    'stamp:date = 2026-03-12',
    'code = &Base64SGVsbG8=',
];

const FOCUSED_DUPLICATE_BASELINES = buildFocusedDuplicateBaselines();

export interface FocusedDuplicateCase {
    readonly id: string;
    readonly source: string;
    readonly family: string;
}

export type FocusedDuplicateFamilyName = 'attribute' | 'type' | 'container' | 'scalar';

export function buildLexerCorpus(prng: PRNG, totalCases: number, maxLength: number): string[] {
    return buildCorpus(prng, totalCases, maxLength, LEXER_BASELINES);
}

export function buildParserCorpus(prng: PRNG, totalCases: number, maxLength: number): string[] {
    return buildCorpus(prng, totalCases, maxLength, PARSER_BASELINES);
}

export function buildDuplicateGrammarCorpus(
    prng: PRNG,
    totalCases: number,
    maxLength: number,
    stepWeights: readonly [number, number, number] = [50, 40, 10]
): string[] {
    const cases: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < totalCases; index += 1) {
        const baseline = DUPLICATE_GRAMMAR_BASELINES[index % DUPLICATE_GRAMMAR_BASELINES.length] ?? 'a = 1';
        const unique = buildUniqueDuplicateGrammarCase(prng, baseline, index, maxLength, seen, stepWeights);
        cases.push(unique);
    }

    return cases;
}

export function buildFocusedDuplicateGrammarCorpus(prng: PRNG, totalCases: number, maxLength: number): string[] {
    const cases: string[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < totalCases; index += 1) {
        const baseline = FOCUSED_DUPLICATE_BASELINES[index % FOCUSED_DUPLICATE_BASELINES.length] ?? 'a @{ a = 2 } = 2';
        const unique = buildUniqueFocusedDuplicateGrammarCase(prng, baseline, index, maxLength, seen);
        cases.push(unique);
    }

    return cases;
}

export function buildFocusedDuplicateCases(
    prng: PRNG,
    totalCases: number,
    maxLength: number,
    familyFilter?: FocusedDuplicateFamilyName
): FocusedDuplicateCase[] {
    const families = filterFocusedFamilies(buildFocusedDuplicateFamilies(), familyFilter);
    const defaultFamily: FocusedDuplicateFamily = {
        family: 'focused-scalar',
        baselines: ['a = 2'],
        mutator: duplicateValueTail,
    };
    const cases: FocusedDuplicateCase[] = [];
    const seen = new Set<string>();

    for (let index = 0; index < totalCases; index += 1) {
        const familyIndex = index % families.length;
        const familyCaseIndex = Math.floor(index / families.length);
        const family = families[familyIndex] ?? families[0] ?? defaultFamily;
        const baseline = family.baselines[familyCaseIndex % family.baselines.length] ?? family.baselines[0] ?? 'a = 1';
        const candidate = buildUniqueFocusedCase(prng, baseline, familyCaseIndex, maxLength, seen, family.mutator);
        cases.push({ id: `generated-${index}`, source: candidate, family: family.family });
    }

    return cases;
}

function buildFocusedDuplicateBaselines(): string[] {
    const bindingKeys = ['a', 'b', 'c', 'item', 'node', 'path', 'flag', 'count'];
    const attributeKeys = ['a', 'role', 'class', 'data', 'ref', 'mode', 'value', 'code'];
    const values = [
        '2',
        '"hello"',
        'true',
        'false',
        '2026-03-12',
        '&FF',
        '!none',
    ];

    const baselines: string[] = [];
    for (const bindingKey of bindingKeys) {
        for (const attributeKey of attributeKeys) {
            for (const value of values) {
                baselines.push(`${bindingKey} @{ ${attributeKey} = ${value} } = ${value}`);
            }
        }
    }

    return baselines;
}

function filterFocusedFamilies(
    families: readonly FocusedDuplicateFamily[],
    familyFilter: FocusedDuplicateFamilyName | undefined
): readonly FocusedDuplicateFamily[] {
    if (!familyFilter) {
        return families;
    }

    const mapping: Record<FocusedDuplicateFamilyName, FocusedDuplicateFamily['family']> = {
        attribute: 'focused-attribute',
        type: 'focused-type',
        container: 'focused-container',
        scalar: 'focused-scalar',
    };

    const target = mapping[familyFilter];
    const filtered = families.filter((family) => family.family === target);
    return filtered.length > 0 ? filtered : families;
}

interface FocusedDuplicateFamily {
    readonly family: string;
    readonly baselines: readonly string[];
    readonly mutator: (prng: PRNG, source: string, index: number) => string;
}

function buildFocusedDuplicateFamilies(): readonly FocusedDuplicateFamily[] {
    return [
        {
            family: 'focused-attribute',
            baselines: buildFocusedDuplicateBaselines(),
            mutator: (prng, source, index) => {
                const mutators = [
                    duplicateAttributeBlock,
                    duplicateSiblingAttributeBlock,
                    duplicateAttributeIntroducer,
                    duplicateAttributeEntryList,
                ] as const;
                const mutator = mutators[index % mutators.length] ?? duplicateAttributeBlock;
                return mutator(prng, source);
            },
        },
        {
            family: 'focused-type',
            baselines: buildFocusedTypeBaselines(),
            mutator: duplicateTypeAnnotation,
        },
        {
            family: 'focused-container',
            baselines: buildFocusedContainerBaselines(),
            mutator: (prng, source, index) => {
                const mutators = [duplicateContainerSeparator, duplicateContainerDelimiter] as const;
                const mutator = mutators[index % mutators.length] ?? duplicateContainerSeparator;
                return mutator(prng, source);
            },
        },
        {
            family: 'focused-scalar',
            baselines: buildFocusedScalarBaselines(),
            mutator: duplicateValueTail,
        },
    ];
}

function buildFocusedTypeBaselines(): string[] {
    const bindingKeys = ['a', 'b', 'c', 'count', 'stamp', 'flag', 'when', 'when_precise'];
    const typeValues: ReadonlyArray<readonly [string, readonly string[]]> = [
        ['string', ['"hello"', '"world"', '"sample"']],
        ['number', ['1', '2', '42']],
        ['boolean', ['true', 'false']],
        ['date', ['2026-03-12', '2024-02-01']],
        ['time', ['12:30:45', '09:15:00']],
        ['datetime', ['2026-03-12T12:30:45Z', '2024-02-01T09:15:00+05:00']],
    ];

    const baselines: string[] = [];
    for (const key of bindingKeys) {
        for (const [typeName, values] of typeValues) {
            for (const value of values) {
                baselines.push(`${key}:${typeName} = ${value}`);
            }
        }
    }

    return baselines;
}

function buildFocusedContainerBaselines(): string[] {
    const bindingKeys = ['a', 'b', 'items', 'tuple', 'obj'];
    const listValues = ['1', '2', '"hello"', 'true', '2026-03-12'];
    const objectValues = ['1', '"hello"', 'true'];

    const baselines: string[] = [];
    for (const key of bindingKeys) {
        for (const first of listValues) {
            for (const second of listValues) {
                baselines.push(`${key} = [${first}, ${second}]`);
                baselines.push(`${key} = (${first}, ${second})`);
            }
        }

        for (const first of objectValues) {
            for (const second of objectValues) {
                baselines.push(`${key} = { a = ${first}, b = ${second} }`);
            }
        }
    }

    return baselines;
}

function buildFocusedScalarBaselines(): string[] {
    const bindingKeys = ['a', 'b', 'c', 'flag', 'code', 'stamp'];
    const values = [
        '"hello"',
        '2',
        'true',
        'false',
        '!none',
        '&FF',
        '&Base64SGVsbG8=',
        '2026-03-12',
        '2026-03-12T12:30:45Z',
        '12:30:45+10:00',
    ];

    const baselines: string[] = [];
    for (const key of bindingKeys) {
        for (const value of values) {
            baselines.push(`${key} = ${value}`);
        }
    }

    return baselines;
}

function buildCorpus(prng: PRNG, totalCases: number, maxLength: number, baselines: readonly string[]): string[] {
    const cases = baselines.slice(0, totalCases);

    while (cases.length < totalCases) {
        const baseline = baselines[prng.int(baselines.length)] ?? '';
        const mutated = mutateSource(prng, baseline, maxLength);
        cases.push(mutated);
    }

    return cases;
}

function buildDuplicateGrammarCase(
    prng: PRNG,
    source: string,
    stepWeights: readonly [number, number, number]
): string {
    const mutators = [
        duplicateAssignmentOperator,
        duplicateValueTail,
        duplicateTypeAnnotation,
        splitAttributeBlocks,
        duplicateReferencePrefix,
        duplicateContainerSeparator,
        duplicateContainerDelimiter,
        duplicateLiteralFamily,
    ] as const;

    let next = source;
    const steps = chooseDuplicateMutationSteps(prng, stepWeights);

    for (let i = 0; i < steps; i += 1) {
        const mutator = mutators[prng.int(mutators.length)] ?? duplicateAssignmentOperator;
        next = mutator(prng, next);
    }

    // Add occasional hostile lexical jitter so duplicate probes cover broader malformed forms.
    if (prng.bool(0.25)) {
        next = spliceDelimiterStorm(prng, next);
    }

    if (prng.bool(0.2)) {
        next = appendNoise(prng, next);
    }

    return next;
}

function chooseDuplicateMutationSteps(prng: PRNG, stepWeights: readonly [number, number, number]): 1 | 2 | 3 {
    const [oneStepWeight, twoStepWeight] = stepWeights;
    const roll = prng.int(100);

    if (roll < oneStepWeight) {
        return 1;
    }

    if (roll < oneStepWeight + twoStepWeight) {
        return 2;
    }

    return 3;
}

function buildUniqueDuplicateGrammarCase(
    prng: PRNG,
    baseline: string,
    index: number,
    maxLength: number,
    seen: Set<string>,
    stepWeights: readonly [number, number, number]
): string {
    const maxAttempts = 48;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidate = trimCaseLength(buildDuplicateGrammarCase(prng, baseline, stepWeights), maxLength);
        if (!seen.has(candidate) && hasRejectionDiagnostics(candidate)) {
            seen.add(candidate);
            return candidate;
        }
    }

    const fallbacks = [
        `${baseline} ==`,
        `${baseline} @{`,
        `${baseline} ~>~>`,
        `${baseline} :string:string:string`,
        `${baseline} //? duplicate-variant-${index} ==`,
    ];

    for (const fallbackSource of fallbacks) {
        const fallback = trimCaseLength(fallbackSource, maxLength);
        if (!seen.has(fallback) && hasRejectionDiagnostics(fallback)) {
            seen.add(fallback);
            return fallback;
        }
    }

    throw new Error(`unable to build malformed duplicate grammar case for index ${index}`);
}

function buildUniqueFocusedDuplicateGrammarCase(
    prng: PRNG,
    baseline: string,
    index: number,
    maxLength: number,
    seen: Set<string>
): string {
    const maxAttempts = 32;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidate = trimCaseLength(buildFocusedDuplicateGrammarCase(prng, baseline, index), maxLength);
        if (!seen.has(candidate) && hasRejectionDiagnostics(candidate)) {
            seen.add(candidate);
            return candidate;
        }
    }

    const fallbacks = [
        'a @{ a = 2 } @{ a = 2 } = 2',
        'a @{ a = 2 } { a = 2 } = 2',
        'a @@{ a = 2 } = 2',
        'a:number @{ a = 2 } @{ a = 2 } = 2',
    ];

    for (const fallbackSource of fallbacks) {
        const fallback = trimCaseLength(fallbackSource, maxLength);
        if (!seen.has(fallback) && hasRejectionDiagnostics(fallback)) {
            seen.add(fallback);
            return fallback;
        }
    }

    throw new Error(`unable to build focused duplicate grammar case for index ${index}`);
}

function buildUniqueFocusedCase(
    prng: PRNG,
    baseline: string,
    index: number,
    maxLength: number,
    seen: Set<string>,
    mutator: (prng: PRNG, source: string, index: number) => string
): string {
    const maxAttempts = 32;
    let firstMalformed: string | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const candidate = trimCaseLength(mutator(prng, baseline, index + attempt), maxLength);
        if (!hasRejectionDiagnostics(candidate)) {
            continue;
        }

        if (firstMalformed === null) {
            firstMalformed = candidate;
        }

        if (!seen.has(candidate)) {
            seen.add(candidate);
            return candidate;
        }
    }

    // If all malformed candidates were already seen, keep the run alive by reusing one.
    if (firstMalformed !== null) {
        return firstMalformed;
    }

    throw new Error(`unable to build focused duplicate case for index ${index}`);
}

function trimCaseLength(source: string, maxLength: number): string {
    return source.length > maxLength ? source.slice(0, maxLength) : source;
}

function hasRejectionDiagnostics(source: string): boolean {
    try {
        const lexed = tokenize(source);
        if (lexed.errors.length > 0) {
            return true;
        }

        const parsed = parse(lexed.tokens);
        return parsed.errors.length > 0;
    } catch {
        return true;
    }
}

function duplicateAssignmentOperator(prng: PRNG, source: string): string {
    const marker = ' = ';
    const index = source.indexOf(marker);
    if (index === -1) {
        return `${source} == ${renderDuplicateValue(prng)}`;
    }
    const duplicated = prng.bool(0.5) ? ' == ' : ' = = ';
    return `${source.slice(0, index)}${duplicated}${source.slice(index + marker.length)}`;
}

function buildFocusedDuplicateGrammarCase(prng: PRNG, source: string, index: number): string {
    const mutators = [
        duplicateAttributeBlock,
        duplicateSiblingAttributeBlock,
        duplicateAttributeIntroducer,
        duplicateAttributeEntryList,
    ] as const;

    const mutator = mutators[index % mutators.length] ?? duplicateAttributeBlock;
    return mutator(prng, source);
}

function duplicateAttributeBlock(_prng: PRNG, source: string): string {
    const attributeStart = source.indexOf('@{');
    if (attributeStart === -1) {
        return `${source} @{ a = 2 } @{ a = 2 } = 2`;
    }

    const attributeEnd = findMatchingBrace(source, attributeStart + 1);
    if (attributeEnd === -1) {
        return `${source} @{ a = 2 }`;
    }

    const block = source.slice(attributeStart, attributeEnd + 1);
    return `${source.slice(0, attributeEnd + 1)} ${block}${source.slice(attributeEnd + 1)}`;
}

function duplicateSiblingAttributeBlock(_prng: PRNG, source: string): string {
    const attributeStart = source.indexOf('@{');
    if (attributeStart === -1) {
        return `${source} { a = 2 }`;
    }

    const attributeEnd = findMatchingBrace(source, attributeStart + 1);
    if (attributeEnd === -1) {
        return `${source} { a = 2 }`;
    }

    return `${source.slice(0, attributeEnd + 1)} { a = 2 }${source.slice(attributeEnd + 1)}`;
}

function duplicateAttributeIntroducer(_prng: PRNG, source: string): string {
    const attributeStart = source.indexOf('@{');
    if (attributeStart === -1) {
        return `${source} @@{ a = 2 }`;
    }

    return `${source.slice(0, attributeStart)}@@${source.slice(attributeStart)}`;
}

function duplicateAttributeEntryList(_prng: PRNG, source: string): string {
    const attributeStart = source.indexOf('@{');
    if (attributeStart === -1) {
        return `${source} @{ a = 2, a = 2 }`;
    }

    const attributeEnd = findMatchingBrace(source, attributeStart + 1);
    if (attributeEnd === -1) {
        return `${source} @{ a = 2, a = 2 }`;
    }

    const rawContent = source.slice(attributeStart + 2, attributeEnd).trim();
    const entries = rawContent
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    const duplicatedEntries = [...entries, ...(entries.slice(0, 1).length > 0 ? entries.slice(0, 1) : ['a = 2'])];
    const nextContent = duplicatedEntries.length > 0 ? duplicatedEntries.join(', ') : 'a = 2, a = 2';
    return `${source.slice(0, attributeStart + 2)}${nextContent}${source.slice(attributeEnd)}`;
}

function duplicateValueTail(prng: PRNG, source: string): string {
    const marker = ' = ';
    const index = source.indexOf(marker);
    if (index === -1) {
        return `${source} = ${renderDuplicateValue(prng)} ${renderDuplicateValue(prng)}`;
    }

    const head = source.slice(0, index + marker.length);
    const value = source.slice(index + marker.length).trim() || renderDuplicateValue(prng);
    const duplicatedValue = value.startsWith('<') ? renderDuplicateValue(prng) : value;
    return `${head}${value} ${duplicatedValue}`;
}

function duplicateTypeAnnotation(prng: PRNG, source: string): string {
    const marker = ' = ';
    const equalsIndex = source.indexOf(marker);
    if (equalsIndex === -1) {
        return `${source}:string:string = ${renderDuplicateValue(prng)}`;
    }

    const binding = source.slice(0, equalsIndex);
    const value = source.slice(equalsIndex + marker.length);
    const colonIndex = binding.indexOf(':');
    if (colonIndex === -1) {
        return `${binding}:string:string${marker}${value}`;
    }

    const key = binding.slice(0, colonIndex);
    const annotation = binding.slice(colonIndex + 1).trim() || 'string';
    return `${key}:${annotation}:${annotation}${marker}${value}`;
}

function splitAttributeBlocks(prng: PRNG, source: string): string {
    const attributeStart = source.indexOf('@{');
    const equalsIndex = source.indexOf(' = ');
    if (attributeStart === -1 || equalsIndex === -1) {
        const key = source.slice(0, equalsIndex === -1 ? source.length : equalsIndex).trim() || 'a';
        const value = equalsIndex === -1 ? renderDuplicateValue(prng) : source.slice(equalsIndex + 3).trim() || renderDuplicateValue(prng);
        return `${key}@{a = 1} @{b = 2} = ${value}`;
    }

    const attributeEnd = findMatchingBrace(source, attributeStart + 1);
    if (attributeEnd === -1) {
        return `${source} @{b = 2}`;
    }

    const key = source.slice(0, attributeStart);
    const value = source.slice(equalsIndex + 3).trim() || renderDuplicateValue(prng);
    const rawContent = source.slice(attributeStart + 2, attributeEnd).trim();
    const entries = rawContent
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    const firstEntry = entries[0] ?? 'a = 1';
    const secondEntry = entries[1] ?? `b = ${renderDuplicateValue(prng)}`;
    return `${key}@{${firstEntry}} @{${secondEntry}} = ${value}`;
}

function duplicateReferencePrefix(prng: PRNG, source: string): string {
    const marker = ' = ';
    const equalsIndex = source.indexOf(marker);
    const key = source.slice(0, equalsIndex === -1 ? source.length : equalsIndex).trim() || 'path';
    const choice = prng.int(4);

    if (choice === 0) {
        return `${key} = ~~item.title`;
    }
    if (choice === 1) {
        return `${key} = ~>~>item.title`;
    }
    if (choice === 2) {
        return `${key} = ~$.$.item`;
    }
    return `${key} = ~~>item.title`;
}

function duplicateContainerSeparator(prng: PRNG, source: string): string {
    if (source.includes('[')) {
        return duplicateFirstContainerSeparator(replaceFirstOccurrence(source, '[', '[, '));
    }
    if (source.includes('(')) {
        return duplicateFirstContainerSeparator(replaceFirstOccurrence(source, '(', '(, '));
    }
    if (source.includes('{')) {
        return duplicateFirstContainerSeparator(replaceFirstOccurrence(source, '{', '{, '));
    }

    const key = source.split(' = ')[0]?.trim() || 'items';
    const variants = [
        `${key} = [1,, 2]`,
        `${key} = (1,, 2)`,
        `${key} = { a = 1,, b = 2 }`,
    ];
    return variants[prng.int(variants.length)] ?? `${key} = [1,, 2]`;
}

function duplicateContainerDelimiter(prng: PRNG, source: string): string {
    if (source.includes('[')) {
        return prng.bool(0.5) ? replaceFirstOccurrence(source, '[', '[[') : `${source}]`;
    }
    if (source.includes('(')) {
        return prng.bool(0.5) ? replaceFirstOccurrence(source, '(', '((') : `${source})`;
    }
    if (source.includes('{')) {
        return prng.bool(0.5) ? replaceFirstOccurrence(source, '{', '{{') : `${source}}`;
    }

    const key = source.split(' = ')[0]?.trim() || 'value';
    const variants = [
        `${key} = [[1, 2]`,
        `${key} = ((1, 2)`,
        `${key} = {{ a = 1 }`,
        `${key} = <div(("x")>`,
    ];
    return variants[prng.int(variants.length)] ?? `${key} = [[1, 2]`;
}

function duplicateFirstContainerSeparator(source: string): string {
    return replaceFirstOccurrence(source, ',', ',,');
}

function replaceFirstOccurrence(source: string, search: string, replacement: string): string {
    const index = source.indexOf(search);
    if (index === -1) {
        return source;
    }
    return `${source.slice(0, index)}${replacement}${source.slice(index + search.length)}`;
}

function duplicateLiteralFamily(prng: PRNG, source: string): string {
    const key = extractBindingKey(source);
    const variants = [
        `${key}::string = ""`,
        `${key}@@{a = "hello"} = 1`,
        `${key}:list<n><n> = [2, 2]`,
        `${key} = !none !none`,
        `${key} = &FF &FF`,
        `${key}:date = 202 202`,
        `${key}:date = 2024--02-01`,
        `${key} = yes no`,
        `${key} = true true`,
    ];
    return variants[prng.int(variants.length)] ?? `${key}::string = ""`;
}

function extractBindingKey(source: string): string {
    const equalsIndex = source.indexOf('=');
    const left = (equalsIndex === -1 ? source : source.slice(0, equalsIndex)).trim();
    if (!left) {
        return 'a';
    }

    const stopAt = left.search(/[:@\s]/);
    if (stopAt <= 0) {
        return left;
    }

    const key = left.slice(0, stopAt).trim();
    return key.length > 0 ? key : 'a';
}

function renderDuplicateValue(prng: PRNG): string {
    const values = [
        '1',
        '2',
        '"hello"',
        '"world"',
        'true',
        'false',
        '2026-03-12',
        '^alpha\\,beta',
        '~item.title',
        '~>item.title',
        '<div("x")>',
        '[1, 2]',
    ];
    return values[prng.int(values.length)] ?? '1';
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
    let depth = 0;
    for (let index = openBraceIndex; index < source.length; index += 1) {
        const char = source[index];
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

function mutateSource(prng: PRNG, source: string, maxLength: number): string {
    let next = source;
    const steps = 2 + prng.int(7);

    for (let i = 0; i < steps; i += 1) {
        switch (prng.int(9)) {
            case 0:
                next = insertRandom(prng, next);
                break;
            case 1:
                next = deleteSlice(prng, next);
                break;
            case 2:
                next = duplicateSlice(prng, next);
                break;
            case 3:
                next = wrapSlice(prng, next);
                break;
            case 4:
                next = replaceChar(prng, next);
                break;
            case 5:
                next = spliceDelimiterStorm(prng, next);
                break;
            case 6:
                next = mirrorSlice(prng, next);
                break;
            case 7:
                next = injectStructuredFragment(prng, next);
                break;
            default:
                next = appendNoise(prng, next);
                break;
        }
    }

    if (next.length > maxLength) {
        next = next.slice(0, maxLength);
    }

    return next;
}

function insertRandom(prng: PRNG, source: string): string {
    const index = prng.int(source.length + 1);
    return `${source.slice(0, index)}${randomChunk(prng, 1 + prng.int(4))}${source.slice(index)}`;
}

function deleteSlice(prng: PRNG, source: string): string {
    if (source.length === 0) {
        return source;
    }
    const start = prng.int(source.length);
    const end = Math.min(source.length, start + 1 + prng.int(Math.max(1, source.length - start)));
    return `${source.slice(0, start)}${source.slice(end)}`;
}

function duplicateSlice(prng: PRNG, source: string): string {
    if (source.length === 0) {
        return randomChunk(prng, 1 + prng.int(4));
    }
    const start = prng.int(source.length);
    const end = Math.min(source.length, start + 1 + prng.int(Math.max(1, source.length - start)));
    const slice = source.slice(start, end);
    const insertAt = prng.int(source.length + 1);
    return `${source.slice(0, insertAt)}${slice}${source.slice(insertAt)}`;
}

function wrapSlice(prng: PRNG, source: string): string {
    const wrappers: Array<[string, string]> = [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
        ['<', '>'],
        ['"', '"'],
        ["'", "'"],
        ['`', '`'],
        ['/#', '#/'],
    ];
    const [left, right] = wrappers[prng.int(wrappers.length)] ?? ['(', ')'];
    return `${left}${source}${right}`;
}

function replaceChar(prng: PRNG, source: string): string {
    if (source.length === 0) {
        return randomChunk(prng, 1);
    }
    const index = prng.int(source.length);
    return `${source.slice(0, index)}${randomChar(prng)}${source.slice(index + 1)}`;
}

function appendNoise(prng: PRNG, source: string): string {
    return `${source}${prng.bool(0.4) ? '\n' : ''}${randomChunk(prng, 1 + prng.int(6))}`;
}

function spliceDelimiterStorm(prng: PRNG, source: string): string {
    const storms = [
        '{{{{', '[[[[', '((((', '<<<<',
        '}}}}', ']]]]', '))))', '>>>>',
        '/#', '#/', '/(', ')/', '/[', ']/',
        '~>', '@{', '^', '$.', 'aeon:',
    ];
    const insertAt = prng.int(source.length + 1);
    const storm = storms[prng.int(storms.length)] ?? '(((( ';
    return `${source.slice(0, insertAt)}${storm}${source.slice(insertAt)}`;
}

function mirrorSlice(prng: PRNG, source: string): string {
    if (source.length === 0) {
        return source;
    }
    const start = prng.int(source.length);
    const end = Math.min(source.length, start + 1 + prng.int(Math.max(1, source.length - start)));
    const slice = source.slice(start, end);
    return `${source.slice(0, start)}${[...slice].reverse().join('')}${source.slice(end)}`;
}

function injectStructuredFragment(prng: PRNG, source: string): string {
    const fragments = [
        'a = 1',
        '{ b = 2 }',
        '[1, 2, 3]',
        '<x("y")>',
        '/( display: block; )/',
        '/[ if $.x ]/',
        '~item.title',
        '2026-03-12T12:30:45Z',
        '^alpha\\,beta',
        '@{class = "hero"}',
    ];
    const insertAt = prng.int(source.length + 1);
    const fragment = fragments[prng.int(fragments.length)] ?? 'a = 1';
    return `${source.slice(0, insertAt)}${fragment}${source.slice(insertAt)}`;
}

function randomChunk(prng: PRNG, length: number): string {
    let out = '';
    for (let i = 0; i < length; i += 1) {
        out += randomChar(prng);
    }
    return out;
}

function randomChar(prng: PRNG): string {
    return CHARSET[prng.int(CHARSET.length)] ?? 'x';
}
