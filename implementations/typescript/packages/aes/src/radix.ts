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

/** Resolve Core radix-family datatype text to its numeric base. */
export function aeonRadixBaseFromDatatype(datatype: string | undefined): number | undefined {
    if (datatype === undefined) return undefined;
    const normalized = datatype.trim().toLowerCase();
    if (normalized === 'decimal') return 10;
    const alias = /^radix(2|6|8|12)$/u.exec(normalized);
    if (alias !== null) return Number(alias[1]);
    const clarified = /^radix\[\s*(\d+)\s*\]$/u.exec(normalized);
    if (clarified === null) return undefined;
    const base = Number(clarified[1]);
    return Number.isInteger(base) && base >= AEON_RADIX_MIN_BASE && base <= AEON_RADIX_MAX_BASE
        ? base
        : undefined;
}
