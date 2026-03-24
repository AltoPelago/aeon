export type TrimtickMarkerWidth = 1 | 2 | 3 | 4;

export interface TrimtickMetadata {
    readonly markerWidth: TrimtickMarkerWidth;
    readonly rawValue: string;
}

function isBlankLine(line: string): boolean {
    return /^[ \t]*$/.test(line);
}

function countLeadingSpaces(line: string): number {
    let i = 0;
    while (i < line.length && line[i] === ' ') i += 1;
    return i;
}

function normalizeLeadingIndent(line: string, tabWidth: 2 | 3 | 4): string {
    let i = 0;
    let prefix = '';
    while (i < line.length) {
        const ch = line[i]!;
        if (ch === ' ') {
            prefix += ' ';
            i += 1;
            continue;
        }
        if (ch === '\t') {
            prefix += ' '.repeat(tabWidth);
            i += 1;
            continue;
        }
        break;
    }
    return `${prefix}${line.slice(i)}`;
}

export function applyTrimticks(raw: string, markerWidth: TrimtickMarkerWidth): string {
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

    const normalized = lines.map((line) => {
        if (isBlankLine(line)) return '';
        if (markerWidth === 1) return line;
        return normalizeLeadingIndent(line, markerWidth);
    });

    const nonEmpty = normalized.filter((line) => line.length > 0);
    if (nonEmpty.length === 0) {
        return '';
    }

    const commonIndent = nonEmpty.reduce(
        (min, line) => Math.min(min, countLeadingSpaces(line)),
        Number.POSITIVE_INFINITY
    );

    return normalized.map((line) => {
        if (line.length === 0) return '';
        return line.slice(commonIndent);
    }).join('\n');
}
