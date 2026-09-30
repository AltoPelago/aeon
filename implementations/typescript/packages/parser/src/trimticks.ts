export interface TrimtickMetadata {
    readonly rawValue: string;
}

function isBlankLine(line: string): boolean {
    return /^[ \t]*$/.test(line);
}

function countLeadingGutter(line: string, gutter: ' ' | '\t'): number {
    let i = 0;
    while (i < line.length && line[i] === gutter) i += 1;
    return i;
}

export function applyTrimticks(raw: string): string {
    if (!raw.includes('\n')) {
        return raw;
    }

    const lines = raw.split('\n');

    if (lines.length > 0 && isBlankLine(lines[0]!)) {
        lines.shift();
    }

    while (lines.length > 0 && isBlankLine(lines[lines.length - 1]!)) {
        lines.pop();
    }

    if (lines.length === 0) {
        return '';
    }

    const normalized = lines.map((line) => isBlankLine(line) ? '' : line);

    const nonEmpty = normalized.filter((line) => line.length > 0);
    if (nonEmpty.length === 0) {
        return '';
    }

    const gutter: ' ' | '\t' = nonEmpty[0]![0] === '\t' ? '\t' : ' ';
    const commonIndent = nonEmpty.reduce(
        (min, line) => Math.min(min, countLeadingGutter(line, gutter)),
        Number.POSITIVE_INFINITY
    );

    return normalized.map((line) => {
        if (line.length === 0) return '';
        return line.slice(commonIndent);
    }).join('\n');
}
