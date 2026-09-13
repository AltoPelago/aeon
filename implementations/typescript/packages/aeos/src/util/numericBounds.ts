/** Exact decimal helpers for AEOS numeric value bounds. */

export type NumericComparison = -1 | 0 | 1;

interface ExactDecimal {
    readonly sign: NumericComparison;
    readonly digits: string;
    readonly scale: bigint;
}

const DECIMAL = /^([+-]?)(?:(\d+)(?:\.(\d+))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;
const MAX_BOUND_CHARACTERS = 65_536;

/** Normalize an exact AEON decimal lexeme without coercing it to Number. */
export function normalizeNumericBound(value: string): string | null {
    const parsed = parseExactDecimal(value);
    if (parsed === null) return null;

    let normalized = value.replaceAll('E', 'e');
    if (normalized.startsWith('+')) normalized = normalized.slice(1);
    if (normalized.startsWith('.')) normalized = `0${normalized}`;
    if (normalized.startsWith('-.')) normalized = `-0${normalized.slice(1)}`;

    const [mantissaInput = '', exponentInput] = normalized.split('e');
    let mantissa = mantissaInput;
    if (mantissa.includes('.')) {
        const [integer = '', fractionInput = ''] = mantissa.split('.');
        const fraction = trimTrailingZeros(fractionInput) || '0';
        mantissa = exponentInput !== undefined && fraction === '0'
            ? integer
            : `${integer}.${fraction}`;
    }

    if (parsed.sign === 0) return '0';
    if (exponentInput === undefined) return mantissa;

    const negativeExponent = exponentInput.startsWith('-');
    const unsignedExponent = exponentInput.startsWith('-') || exponentInput.startsWith('+')
        ? exponentInput.slice(1)
        : exponentInput;
    const exponentDigits = trimLeadingZeros(unsignedExponent) || '0';
    const exponent = exponentDigits === '0' ? '0' : `${negativeExponent ? '-' : ''}${exponentDigits}`;
    return `${mantissa}e${exponent}`;
}

/** Compare two exact decimal lexemes without machine-number range or precision loss. */
export function compareNumericValues(left: string, right: string): NumericComparison | null {
    const leftValue = parseExactDecimal(left);
    const rightValue = parseExactDecimal(right);
    if (leftValue === null || rightValue === null) return null;
    if (leftValue.sign !== rightValue.sign) return leftValue.sign < rightValue.sign ? -1 : 1;
    if (leftValue.sign === 0) return 0;

    const magnitude = compareMagnitude(leftValue, rightValue);
    return leftValue.sign === -1 ? invert(magnitude) : magnitude;
}

function parseExactDecimal(value: string): ExactDecimal | null {
    if (value.length > MAX_BOUND_CHARACTERS) return null;
    const match = DECIMAL.exec(value);
    if (match === null) return null;

    const integer = match[2] ?? '';
    const fraction = match[3] ?? match[4] ?? '';
    if (integer.length > 1 && integer.startsWith('0')) return null;

    const digits = trimLeadingZeros(`${integer}${fraction}`);
    if (digits.length === 0) return { sign: 0, digits: '0', scale: 0n };

    return {
        sign: match[1] === '-' ? -1 : 1,
        digits,
        scale: BigInt(match[5] ?? '0') - BigInt(fraction.length),
    };
}

function trimLeadingZeros(value: string): string {
    let start = 0;
    while (start < value.length && value.charCodeAt(start) === 48) start += 1;
    return value.slice(start);
}

function trimTrailingZeros(value: string): string {
    let end = value.length;
    while (end > 0 && value.charCodeAt(end - 1) === 48) end -= 1;
    return value.slice(0, end);
}

function compareMagnitude(left: ExactDecimal, right: ExactDecimal): NumericComparison {
    const leftOrder = BigInt(left.digits.length) + left.scale;
    const rightOrder = BigInt(right.digits.length) + right.scale;
    if (leftOrder !== rightOrder) return leftOrder < rightOrder ? -1 : 1;

    const width = Math.max(left.digits.length, right.digits.length);
    const leftDigits = left.digits.padEnd(width, '0');
    const rightDigits = right.digits.padEnd(width, '0');
    if (leftDigits === rightDigits) return 0;
    return leftDigits < rightDigits ? -1 : 1;
}

function invert(value: NumericComparison): NumericComparison {
    return value === 0 ? 0 : value === 1 ? -1 : 1;
}
