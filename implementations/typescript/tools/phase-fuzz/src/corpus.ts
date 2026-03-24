import type { PRNG } from './prng.js';

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
    'a = $Base64SGVsbG8=',
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

export function buildLexerCorpus(prng: PRNG, totalCases: number, maxLength: number): string[] {
    return buildCorpus(prng, totalCases, maxLength, LEXER_BASELINES);
}

export function buildParserCorpus(prng: PRNG, totalCases: number, maxLength: number): string[] {
    return buildCorpus(prng, totalCases, maxLength, PARSER_BASELINES);
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
