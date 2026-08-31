/**
 * Return the base name of a datatype without generic parameters or clarifiers.
 */
export function datatypeBase(datatype: string): string {
    const genericIdx = datatype.indexOf('<');
    const clarifierIdx = datatype.indexOf('[');
    const endIdx = [genericIdx, clarifierIdx]
        .filter((idx) => idx >= 0)
        .reduce((min, idx) => Math.min(min, idx), datatype.length);
    return datatype.slice(0, endIdx);
}

/**
 * Parse the JSON-compatible values from a datatype clarifier list.
 */
export function parseClarifierValues(datatype: string): (string | number)[] {
    const start = datatype.indexOf('[');
    if (start < 0 || !datatype.endsWith(']')) return [];
    const payload = datatype.slice(start + 1, -1);
    try {
        const parsed = JSON.parse(`[${payload}]`) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number');
    } catch {
        return [];
    }
}

/**
 * Resolve the radix declared by a built-in numeric datatype.
 */
export function declaredRadixFromDatatype(datatype: string | undefined): number | null {
    if (datatype === undefined) return null;
    const trimmed = datatype.trim();
    if (trimmed.toLowerCase() === 'decimal') return 10;
    const alias = /^radix(2|6|8|12)$/i.exec(trimmed);
    if (alias) return Number(alias[1]);
    if (datatypeBase(trimmed).toLowerCase() !== 'radix') return null;
    const values = parseClarifierValues(trimmed);
    if (values.length !== 1 || typeof values[0] !== 'number') return null;
    const value = values[0];
    return Number.isInteger(value) && value >= 2 && value <= 64 ? value : null;
}
