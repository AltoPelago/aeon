import type { PortableAesEvent, PortableAesKind } from './portable.js';
import * as datatypeImplementation from './telex-datatype-internal.js';
import * as implementation from './telex-internal.js';
import * as limitImplementation from './telex-limits-internal.js';

export const TELEX_VERSION = '0' as const;
export const COMPLETE_AES_PROFILE = 'aes.complete.v0' as const;
export const PARTIAL_AES_PROFILE = 'aes.partial.v0' as const;
export const AEON_DOCUMENT_PROJECTION = 'aeon.document.v0' as const;

export interface AesStringLiteral {
    readonly kind: 'StringLiteral';
    readonly value: string;
}

export interface AesNumberLiteral {
    readonly kind: 'NumberLiteral';
    readonly value: string;
}

export interface AesDatatypeDescriptor {
    readonly datatype: string;
    readonly generics: readonly (AesDatatypeDescriptor | AesNumberLiteral)[];
    readonly clarifiers: readonly (AesStringLiteral | AesNumberLiteral)[];
}

export interface TelexRecord {
    readonly header?: string;
    readonly path?: string;
    readonly kind?: PortableAesKind | string;
    readonly datatype?: string;
    readonly generics?: readonly (AesDatatypeDescriptor | AesNumberLiteral)[];
    readonly clarifiers?: readonly (AesStringLiteral | AesNumberLiteral)[];
    readonly identity?: string;
    readonly value?: string;
    readonly origin?: string;
    readonly span?: string;
    readonly [extension: string]: unknown;
}

export interface TelexLimits {
    readonly maxInputBytes: number;
    readonly maxLineBytes: number;
    readonly maxFieldsPerEvent: number;
    readonly maxEvents: number;
    readonly maxDecodedPayloadBytes: number;
    readonly maxPathDepth: number;
    readonly maxPathCharacters: number;
    readonly maxGenericDepth: number;
    readonly maxGenericArguments: number;
    readonly maxClarifierValues: number;
    readonly maxDatatypeComponents: number;
}

export type PartialTelexLimits = Partial<TelexLimits>;

export interface TelexLimitOptions extends PartialTelexLimits {
    readonly limits?: PartialTelexLimits;
    readonly datatypeLimits?: PartialTelexLimits & {
        readonly maxDepth?: number;
        readonly maxItems?: number;
    };
}

export interface TelexEncodeOptions extends TelexLimitOptions {
    readonly profile?: string;
    readonly projection?: string;
}

export interface TelexValidationOptions extends TelexLimitOptions {
    readonly profile?: string;
    readonly projection?: string | null;
    readonly registeredFields?: readonly string[];
}

export interface ParsedTelex {
    readonly version: typeof TELEX_VERSION;
    readonly profile: string;
    readonly profileExplicit: boolean;
    readonly projection: string | null;
    readonly projectionExplicit: boolean;
    readonly records: readonly TelexRecord[];
    readonly canonical: boolean;
}

export interface TelexMissingPrefix {
    readonly field?: 'header';
    readonly path: string;
    readonly requiredBy: string;
}

export interface TelexCompletenessResult {
    readonly complete: boolean;
    readonly missing: readonly TelexMissingPrefix[];
}

export interface AesDiagnostic {
    readonly code: string;
    readonly message: string;
    readonly record?: number;
    readonly path?: string;
    readonly field?: string;
    readonly requiredPath?: string;
    readonly firstRecord?: number;
    readonly counter?: string;
    readonly observed?: number;
    readonly limit?: number;
}

export interface TelexValidationResult {
    readonly valid: boolean;
    readonly profile: string;
    readonly diagnostics: readonly AesDiagnostic[];
}

export interface TelexSyntaxError extends Error {
    readonly line?: number;
    readonly code: string;
    readonly counter?: string;
    readonly observed?: number;
    readonly limit?: number;
}

export const TelexSyntaxError = implementation.TelexSyntaxError as unknown as {
    new(message: string, line?: number, code?: string, details?: Readonly<Record<string, unknown>>): TelexSyntaxError;
};

export const DEFAULT_TELEX_LIMITS = limitImplementation.DEFAULT_TELEX_LIMITS as Readonly<TelexLimits>;

export function normalizeTelexLimits(options: TelexLimitOptions = {}): Readonly<TelexLimits> {
    return limitImplementation.normalizeTelexLimits(options) as Readonly<TelexLimits>;
}

export function normalizeDatatypeLimits(options: TelexLimitOptions = {}): Readonly<Pick<
    TelexLimits,
    'maxGenericDepth' | 'maxGenericArguments' | 'maxClarifierValues' | 'maxDatatypeComponents'
>> {
    return limitImplementation.normalizeDatatypeLimits(options) as Readonly<Pick<
        TelexLimits,
        'maxGenericDepth' | 'maxGenericArguments' | 'maxClarifierValues' | 'maxDatatypeComponents'
    >>;
}

export function parseDatatypeDescriptor(
    input: string,
    options: TelexLimitOptions = {},
): AesDatatypeDescriptor {
    return datatypeImplementation.parseDatatypeDescriptor(input, options) as AesDatatypeDescriptor;
}

export function formatDatatypeDescriptor(
    descriptor: AesDatatypeDescriptor,
    options: TelexLimitOptions = {},
): string {
    return datatypeImplementation.formatDatatypeDescriptor(descriptor, options) as string;
}

export function assertDatatypeDescriptor(
    descriptor: unknown,
    options: TelexLimitOptions = {},
): asserts descriptor is AesDatatypeDescriptor {
    datatypeImplementation.assertDatatypeDescriptor(descriptor, options);
}

export function parseTelex(input: string, options: TelexLimitOptions = {}): ParsedTelex {
    return implementation.parseTelex(input, options) as ParsedTelex;
}

export function encodeTelex(
    records: readonly (TelexRecord | PortableAesEvent)[],
    options: TelexEncodeOptions = {},
): string {
    return implementation.encodeTelex(records, options) as string;
}

export function canonicalizeTelex(input: string, options: TelexLimitOptions = {}): string {
    return implementation.canonicalizeTelex(input, options) as string;
}

export function checkTelexCompleteness(
    input: string,
    options: TelexLimitOptions = {},
): TelexCompletenessResult {
    return implementation.checkTelexCompleteness(input, options) as TelexCompletenessResult;
}

export function checkPrefixCompleteness(
    records: readonly (TelexRecord | PortableAesEvent)[],
    options: { readonly projection?: string | null } = {},
): TelexCompletenessResult {
    return implementation.checkPrefixCompleteness(records, options) as TelexCompletenessResult;
}

export function validateTelex(
    input: string | ParsedTelex,
    options: TelexValidationOptions = {},
): TelexValidationResult {
    return implementation.validateTelex(input, options) as TelexValidationResult;
}

export function validateTelexRecords(
    records: readonly (TelexRecord | PortableAesEvent)[],
    options: TelexValidationOptions = {},
): TelexValidationResult {
    return implementation.validateTelexRecords(records, options) as TelexValidationResult;
}
