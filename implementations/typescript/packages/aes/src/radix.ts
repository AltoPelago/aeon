/** Lowest and highest bases supported by the AEON radix family. */
export const AEON_RADIX_MIN_BASE = 2;
export const AEON_RADIX_MAX_BASE = 64;

/**
 * Return the AEON radix digit value for one code unit.
 *
 * The alphabet is case-sensitive and ordered as 0-9, A-Z, a-z, &, !.
 */
export function aeonRadixDigitValue(character: string): number | null {
    if (character.length !== 1) return null;
    if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
    if (character >= 'A' && character <= 'Z') return character.charCodeAt(0) - 55;
    if (character >= 'a' && character <= 'z') return character.charCodeAt(0) - 61;
    if (character === '&') return 62;
    if (character === '!') return 63;
    return null;
}

export type RadixBaseResolution =
    | { readonly kind: 'unspecified' }
    | { readonly kind: 'invalid' }
    | { readonly kind: 'base'; readonly base: number };

/** Interpret an exact finite numeric spelling as an integral base in 2..64.
 * Exponents saturate at an input-sized bound; no powers or large integers are
 * constructed, even for hostile exponents or coefficients.
 */
export function aeonRadixBaseFromNumber(value: string): number | undefined {
    let cursor = value[0] === '+' ? 1 : 0;
    const start = cursor;
    const isDigit = (index: number) => value[index] !== undefined && value[index]! >= '0' && value[index]! <= '9';
    while (isDigit(cursor)) cursor += 1;
    const integer = value.slice(start, cursor);
    if (integer.length > 1 && integer[0] === '0') return undefined;
    let fraction = '';
    if (value[cursor] === '.') {
        const fractionStart = ++cursor;
        while (isDigit(cursor)) cursor += 1;
        fraction = value.slice(fractionStart, cursor);
        if (fraction.length === 0) return undefined;
    }
    if (integer.length === 0 && fraction.length === 0) return undefined;
    let exponent = 0;
    if (value[cursor] === 'e' || value[cursor] === 'E') {
        cursor += 1;
        const negative = value[cursor] === '-';
        if (negative || value[cursor] === '+') cursor += 1;
        const exponentStart = cursor;
        while (isDigit(cursor)) {
            exponent = Math.min(value.length + 2, exponent * 10 + value.charCodeAt(cursor) - 48);
            cursor += 1;
        }
        if (cursor === exponentStart) return undefined;
        if (negative) exponent = -exponent;
    }
    if (cursor !== value.length) return undefined;
    const digits = integer + fraction;
    let first = 0;
    while (digits[first] === '0') first += 1;
    let end = digits.length;
    while (end > first && digits[end - 1] === '0') end -= 1;
    const width = end - first;
    const shift = exponent - fraction.length + digits.length - end;
    if (width < 1 || width > 2 || shift < 0 || width + shift > 2) return undefined;
    const base = Number(digits.slice(first, end)) * (shift === 1 ? 10 : 1);
    return base >= AEON_RADIX_MIN_BASE && base <= AEON_RADIX_MAX_BASE ? base : undefined;
}

/** Distinguish an absent base from an explicitly invalid radix declaration. */
export function resolveAeonRadixBaseFromDatatype(datatype: string | undefined): RadixBaseResolution {
    if (datatype === undefined) return { kind: 'unspecified' };
    // Datatype names are case-sensitive: Radix and Decimal are custom names.
    const normalized = datatype.trim();
    if (normalized === 'decimal') return { kind: 'base', base: 10 };
    const alias = /^radix(2|6|8|12)$/u.exec(normalized);
    if (alias !== null) return { kind: 'base', base: Number(alias[1]) };
    if (!normalized.startsWith('radix[')) return { kind: 'unspecified' };
    const base = normalized.endsWith(']')
        ? aeonRadixBaseFromNumber(normalized.slice(6, -1).trim()) : undefined;
    return base === undefined ? { kind: 'invalid' } : { kind: 'base', base };
}

/** Resolve the expanded logical AES form without reparsing numbers as floats. */
export function resolveAeonRadixBaseFromComponents(
    datatype: string | undefined,
    clarifiers: readonly { readonly kind: string; readonly value: string }[] | undefined,
): RadixBaseResolution {
    if (datatype !== 'radix') return resolveAeonRadixBaseFromDatatype(datatype);
    if (!clarifiers?.length) return { kind: 'unspecified' };
    const clarifier = clarifiers[0]!;
    const base = clarifiers.length === 1 && clarifier.kind === 'NumberLiteral'
        ? aeonRadixBaseFromNumber(clarifier.value) : undefined;
    return base === undefined ? { kind: 'invalid' } : { kind: 'base', base };
}

/** Compatibility view for callers that need only a successfully resolved base. */
export function aeonRadixBaseFromDatatype(datatype: string | undefined): number | undefined {
    const resolved = resolveAeonRadixBaseFromDatatype(datatype);
    return resolved.kind === 'base' ? resolved.base : undefined;
}

/**
 * Return the represented fractional digit count for an AEON radix payload.
 *
 * Visual `_` separators do not contribute to scale. When a base is supplied,
 * digits outside that base make the payload invalid.
 */
export function aeonRadixScale(payload: string, base?: number): number | null {
    if (payload.length === 0) return null;
    if (base !== undefined && (!Number.isInteger(base) || base < AEON_RADIX_MIN_BASE || base > AEON_RADIX_MAX_BASE)) {
        return null;
    }

    let index = payload[0] === '+' || payload[0] === '-' ? 1 : 0;
    if (index === payload.length) return null;
    let sawDigit = false;
    let sawPoint = false;
    let scale = 0;
    for (; index < payload.length; index += 1) {
        const character = payload[index]!;
        if (character === '.') {
            if (sawPoint) return null;
            sawPoint = true;
            continue;
        }
        if (character === '_') {
            const previous = payload[index - 1];
            const next = payload[index + 1];
            if (previous === undefined || next === undefined || aeonRadixDigitValue(previous) === null || aeonRadixDigitValue(next) === null) {
                return null;
            }
            continue;
        }
        const digit = aeonRadixDigitValue(character);
        if (digit === null || base !== undefined && digit >= base) return null;
        sawDigit = true;
        if (sawPoint) scale += 1;
    }
    return !sawDigit || sawPoint && scale === 0 ? null : scale;
}
