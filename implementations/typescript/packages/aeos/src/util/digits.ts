/**
 * @aeos/core - Util: Digits
 *
 * Helpers for counting ASCII digits in numeric literals.
 */

/**
 * Count ASCII digits in a numeric literal (excludes sign, decimal point, exponent).
 *
 * Examples:
 * - "123" → 3
 * - "-456" → 3
 * - "+789" → 3
 * - "1.5" → 2 (digits before and after decimal)
 * - "1e10" → 3 (1 + 10)
 *
 * For v1, we count only the integer part (before decimal point) for integer constraints.
 */
export function countDigits(raw: string): number {
    let count = 0;
    for (const char of raw) {
        if (char >= '0' && char <= '9') {
            count++;
        }
    }
    return count;
}

/**
 * Count integer part digits only (before any decimal point).
 *
 * For integer literals, this is the total digit count (excluding sign).
 * For float literals, this counts digits before the '.'.
 */
export function countIntegerDigits(raw: string): number {
    // Remove leading sign
    let s = raw;
    if (s.startsWith('+') || s.startsWith('-')) {
        s = s.slice(1);
    }

    // Find decimal point or exponent
    const decimalIndex = s.indexOf('.');
    const expIndex = Math.min(
        s.indexOf('e') !== -1 ? s.indexOf('e') : Infinity,
        s.indexOf('E') !== -1 ? s.indexOf('E') : Infinity
    );

    // Determine end of integer part
    const endIndex = Math.min(
        decimalIndex !== -1 ? decimalIndex : Infinity,
        expIndex !== Infinity ? expIndex : Infinity,
        s.length
    );

    // Count digits in integer part
    let count = 0;
    for (let i = 0; i < endIndex; i++) {
        const char = s[i];
        if (char !== undefined && char >= '0' && char <= '9') {
            count++;
        }
    }

    return count;
}

/**
 * Check if a numeric literal is signed (has leading - or +).
 */
export function isSigned(raw: string): boolean {
    return raw.startsWith('-') || raw.startsWith('+');
}

/**
 * Check if a numeric literal is negative (has leading -).
 */
export function isNegative(raw: string): boolean {
    return raw.startsWith('-');
}
