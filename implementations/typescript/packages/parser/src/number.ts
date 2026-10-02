export function normalizeNumberLiteral(raw: string): string {
    let value = raw.replace(/_/g, '').replace(/E/g, 'e');
    if (value.startsWith('.')) value = `0${value}`;
    if (value.startsWith('-.')) value = value.replace('-.', '-0.');
    if (value.startsWith('+.')) value = value.replace('+.', '0.');
    if (value.startsWith('+') && /\d/.test(value[1] ?? '')) value = value.slice(1);

    const parts = value.split('e');
    let mantissa = parts[0] ?? '';
    let exponent = parts[1];
    if (mantissa.includes('.')) {
        const [intPart, fractionRaw] = mantissa.split('.');
        const fraction = fractionRaw?.replace(/0+$/, '') || '0';
        mantissa = exponent !== undefined && fraction === '0'
            ? intPart ?? ''
            : `${intPart ?? ''}.${fraction}`;
    }
    if (exponent === undefined) return mantissa;
    if (mantissa === '0' || mantissa === '-0') return `${mantissa}e0`;

    exponent = exponent.replace(/^\+/, '');
    const negative = exponent.startsWith('-');
    const digits = negative ? exponent.slice(1) : exponent;
    const normalized = digits.replace(/^0+/, '') || '0';
    return normalized === '0'
        ? `${mantissa}e0`
        : `${mantissa}e${negative ? '-' : ''}${normalized}`;
}
