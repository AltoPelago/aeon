/**
 * @aeos/cts-runner - Utilities
 */

import { createHash } from 'node:crypto';

/**
 * Deep copy an object via JSON serialization
 */
export function deepCopy<T>(x: T): T {
    return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * Deterministic deep equality by hash of stable JSON stringify
 */
export function deepEquals(a: unknown, b: unknown): boolean {
    return stableHash(a) === stableHash(b);
}

function stableHash(x: unknown): string {
    const json = stableStringify(x);
    return createHash('sha256').update(json).digest('hex');
}

/**
 * Stable stringify with sorted object keys
 */
export function stableStringify(x: unknown): string {
    return JSON.stringify(sortKeys(x));
}

function sortKeys(x: unknown): unknown {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') {
        const obj = x as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) out[k] = sortKeys(obj[k]);
        return out;
    }
    return x;
}

/**
 * Check if value is a plain object
 */
export function isObject(x: unknown): x is Record<string, unknown> {
    return !!x && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Normalize canonical-ish paths so equivalent forms compare consistently.
 *
 * Examples:
 * - $.x          -> $.x
 * - $.["x"]     -> $.x
 * - $.[$"x"]    -> $.x
 * - $.arr[01]    -> $.arr[1]
 */
export function normalizePath(path: string): string {
    let normalized = path.trim();

    normalized = normalized.replace(/\[\$"([^"\\]*(?:\\.[^"\\]*)*)"\]/g, '["$1"]');
    normalized = normalized.replace(/\$\["([^"\\]*(?:\\.[^"\\]*)*)"\]/g, (_m, key: string) => {
        return isIdentifier(key) ? `$.${key}` : `$["${key}"]`;
    });

    normalized = normalized.replace(/\.\["([^"\\]*(?:\\.[^"\\]*)*)"\]/g, (_m, key: string) => {
        return isIdentifier(key) ? `.${key}` : `.["${key}"]`;
    });

    normalized = normalized.replace(/\[(\d+)\]/g, (_m, digits: string) => `[${String(Number(digits))}]`);

    return normalized;
}

function isIdentifier(value: string): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
