import type { Span } from '@aeon/lexer';

export type HostDirectiveKind = 'format' | 'unknown';

export interface HostDirective {
    readonly raw: string;
    readonly kind: HostDirectiveKind;
    readonly value: string | null;
}

export interface FilePreambleInfo {
    readonly shebang: string | null;
    readonly hostDirective: HostDirective | null;
    readonly format: string | null;
    readonly span: {
        readonly shebang?: Span;
        readonly hostDirective?: Span;
    };
}

interface LineInfo {
    readonly raw: string;
    readonly span: Span;
    readonly nextOffset: number;
}

export function inspectFilePreamble(source: string): FilePreambleInfo {
    source = stripLeadingBom(source);
    const firstLine = readLine(source, 0, 1);
    if (!firstLine) {
        return { shebang: null, hostDirective: null, format: null, span: {} };
    }

    let shebang: string | null = null;
    let shebangSpan: Span | undefined;
    let hostDirectiveLine: LineInfo | null = null;

    if (firstLine.raw.startsWith('#!')) {
        shebang = firstLine.raw;
        shebangSpan = firstLine.span;
        hostDirectiveLine = readLine(source, firstLine.nextOffset, 2);
    } else if (firstLine.raw.startsWith('//!')) {
        hostDirectiveLine = firstLine;
    }

    if (!hostDirectiveLine && shebangSpan) {
        const secondLine = readLine(source, firstLine.nextOffset, 2);
        if (secondLine && secondLine.raw.startsWith('//!')) {
            hostDirectiveLine = secondLine;
        }
    }

    let hostDirective: HostDirective | null = null;
    let format: string | null = null;
    let hostDirectiveSpan: Span | undefined;

    if (hostDirectiveLine && hostDirectiveLine.raw.startsWith('//!')) {
        hostDirective = parseHostDirective(hostDirectiveLine.raw);
        hostDirectiveSpan = hostDirectiveLine.span;
        if (hostDirective.kind === 'format') {
            format = hostDirective.value;
        }
    }

    return {
        shebang,
        hostDirective,
        format,
        span: {
            ...(shebangSpan ? { shebang: shebangSpan } : {}),
            ...(hostDirectiveSpan ? { hostDirective: hostDirectiveSpan } : {}),
        },
    };
}

function stripLeadingBom(source: string): string {
    return source.startsWith('\uFEFF') ? source.slice(1) : source;
}

function parseHostDirective(raw: string): HostDirective {
    const formatPrefix = '//! format:';
    if (raw.startsWith(formatPrefix)) {
        const value = raw.slice(formatPrefix.length).trim();
        return {
            raw,
            kind: 'format',
            value: value.length > 0 ? value : null,
        };
    }
    return {
        raw,
        kind: 'unknown',
        value: null,
    };
}

function readLine(source: string, offset: number, line: number): LineInfo | null {
    let startOffset = offset;
    if (startOffset >= source.length) {
        return null;
    }

    if (line > 1 && source[startOffset] === '\n') {
        startOffset += 1;
    }
    if (startOffset >= source.length) {
        return null;
    }

    let endOffset = startOffset;
    while (endOffset < source.length && source[endOffset] !== '\n') {
        endOffset += 1;
    }

    let rawEndOffset = endOffset;
    if (rawEndOffset > startOffset && source[rawEndOffset - 1] === '\r') {
        rawEndOffset -= 1;
    }

    return {
        raw: source.slice(startOffset, rawEndOffset),
        span: {
            start: { line, column: 1, offset: startOffset },
            end: { line, column: rawEndOffset - startOffset + 1, offset: rawEndOffset },
        },
        nextOffset: endOffset < source.length ? endOffset + 1 : endOffset,
    };
}
