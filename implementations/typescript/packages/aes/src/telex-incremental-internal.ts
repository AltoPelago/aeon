import type {
    ParsedTelex,
    TelexLimitOptions,
    TelexLimits,
    TelexRecord,
    TelexSyntaxError,
    TelexValidationOptions,
    TelexValidationResult,
} from './telex.js';
import {
    COMPLETE_AES_PROFILE,
    TELEX_VERSION,
} from './telex.js';
import {
    TelexSyntaxError as InternalTelexSyntaxError,
    assertTelexLimit,
    createTelexValidationState,
    decodePayloadBounded,
    decodeWireRecord,
    finalizeTelexValidationState,
    hasCanonicalFieldOrder,
    prepareTelexValidationRecords,
} from './telex-internal.js';
import { normalizeTelexLimits } from './telex-limits-internal.js';

const VERSION_LINE = 'telex.aes=1';
const FIELD_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/u;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const EMPTY_BYTES = new Uint8Array(0);

export type IncrementalTelexProgress =
    | 'need-more-input'
    | 'provisional-records'
    | 'syntax-complete';

export interface IncrementalTelexContext {
    readonly profile: string;
    readonly profileExplicit: boolean;
    readonly projection: string | null;
    readonly projectionExplicit: boolean;
}

export interface IncrementalTelexCompletion extends IncrementalTelexContext {
    readonly canonical: boolean;
}

export interface IncrementalTelexUpdate {
    readonly firstRecord: number;
    readonly records: readonly TelexRecord[];
    readonly context?: IncrementalTelexContext;
    readonly totalInputBytes: number;
    readonly decodedPayloadBytes: number;
    readonly canonicalSoFar: boolean;
    readonly progress: IncrementalTelexProgress;
    readonly completion?: IncrementalTelexCompletion;
}

export interface IncrementalTelexPushOptions {
    readonly final?: boolean;
}

type Phase = 'header' | 'records';

/**
 * Internal byte-oriented Telex decoder used to verify the language-neutral
 * incremental contract. Records are provisional until AES finalization.
 */
export class IncrementalTelexDecoder {
    readonly #limits: Readonly<TelexLimits>;
    #phase: Phase = 'header';
    #line: Uint8Array = EMPTY_BYTES;
    #lineOverflowBytes: number | undefined;
    #lineOverflowEndsCr = false;
    #processedLines = 0;
    #totalInputBytes = 0;
    #decodedPayloadBytes = 0;
    #sawInput = false;
    #lastWasLf = false;
    #canonical = true;
    #versionSeen = false;
    #profile = COMPLETE_AES_PROFILE as string;
    #profileExplicit = false;
    #projection: string | null = null;
    #projectionExplicit = false;
    #lastHeaderRank: number | undefined;
    #separatorWidth = 0;
    #fields: Map<string, string> | undefined;
    #datatypeLine: number | undefined;
    #datatypeComponentLine: number | undefined;
    #recordCount = 0;
    #contextAnnounced = false;
    #complete = false;
    #failure: TelexSyntaxError | undefined;

    constructor(options: TelexLimitOptions = {}) {
        this.#limits = normalizeTelexLimits(options);
    }

    push(input: Uint8Array, options: IncrementalTelexPushOptions = {}): IncrementalTelexUpdate {
        if (!(input instanceof Uint8Array)) {
            throw new TypeError('Incremental Telex input must be a Uint8Array');
        }
        if (this.#failure !== undefined) throw this.#failure;
        if (this.#complete) {
            throw new InternalTelexSyntaxError(
                'The incremental Telex decoder is already complete',
                undefined,
                'TELEX_DECODER_CLOSED',
            );
        }

        try {
            return this.#push(input, options.final === true);
        } catch (error) {
            if (isTelexSyntaxError(error)) this.#failure = error;
            throw error;
        }
    }

    #push(input: Uint8Array, finalChunk: boolean): IncrementalTelexUpdate {
        const firstRecord = this.#recordCount;
        const records: TelexRecord[] = [];
        const observedInputBytes = this.#totalInputBytes + input.byteLength;
        assertTelexLimit(
            'max_input_bytes',
            observedInputBytes,
            this.#limits.maxInputBytes,
            undefined,
        );
        this.#totalInputBytes = observedInputBytes;
        if (input.byteLength > 0) {
            this.#sawInput = true;
            this.#lastWasLf = input[input.byteLength - 1] === 0x0a;
        }
        this.#processBytes(input, records);

        if (!finalChunk) {
            return this.#update(
                firstRecord,
                records,
                records.length === 0 ? 'need-more-input' : 'provisional-records',
            );
        }

        if (this.#lineOverflowBytes !== undefined) {
            const observed = this.#lineOverflowBytes - Number(this.#lineOverflowEndsCr);
            this.#lineOverflowBytes = undefined;
            assertTelexLimit(
                'max_line_bytes',
                observed,
                this.#limits.maxLineBytes,
                this.#processedLines + 1,
            );
        }
        if (this.#line.byteLength > 0 || !this.#sawInput) {
            const line = this.#line;
            this.#line = EMPTY_BYTES;
            this.#processLine(line, false, records);
        }
        this.#finish(records);
        this.#complete = true;
        const completion: IncrementalTelexCompletion = {
            profile: this.#profile,
            profileExplicit: this.#profileExplicit,
            projection: this.#projection,
            projectionExplicit: this.#projectionExplicit,
            canonical: this.#canonical && this.#lastWasLf,
        };
        return this.#update(firstRecord, records, 'syntax-complete', completion);
    }

    #processBytes(input: Uint8Array, records: TelexRecord[]): void {
        let cursor = 0;
        while (cursor < input.byteLength) {
            const newline = input.indexOf(0x0a, cursor);
            if (this.#lineOverflowBytes !== undefined) {
                if (newline !== -1) {
                    this.#lineOverflowBytes += newline - cursor;
                    if (newline > cursor) {
                        this.#lineOverflowEndsCr = input[newline - 1] === 0x0d;
                    }
                    const observed = this.#lineOverflowBytes - Number(this.#lineOverflowEndsCr);
                    assertTelexLimit(
                        'max_line_bytes',
                        observed,
                        this.#limits.maxLineBytes,
                        this.#processedLines + 1,
                    );
                }
                this.#lineOverflowBytes += input.byteLength - cursor;
                this.#lineOverflowEndsCr = input[input.byteLength - 1] === 0x0d;
                return;
            }

            if (this.#line.byteLength === 0 && newline !== -1) {
                const line = input.subarray(cursor, newline);
                this.#checkLineLength(line);
                this.#processLine(line, true, records);
                cursor = newline + 1;
                continue;
            }

            if (newline !== -1) {
                const suffix = input.subarray(cursor, newline);
                const rawLength = this.#line.byteLength + suffix.byteLength;
                const endsCr = suffix.byteLength === 0
                    ? this.#line[this.#line.byteLength - 1] === 0x0d
                    : suffix[suffix.byteLength - 1] === 0x0d;
                assertTelexLimit(
                    'max_line_bytes',
                    rawLength - Number(endsCr),
                    this.#limits.maxLineBytes,
                    this.#processedLines + 1,
                );
                const line = appendBytes(this.#line, suffix);
                this.#line = EMPTY_BYTES;
                this.#processLine(line, true, records);
                cursor = newline + 1;
                continue;
            }

            const suffix = input.subarray(cursor);
            const rawLength = this.#line.byteLength + suffix.byteLength;
            const endsCr = suffix[suffix.byteLength - 1] === 0x0d;
            if (rawLength - Number(endsCr) > this.#limits.maxLineBytes) {
                this.#lineOverflowBytes = rawLength;
                this.#lineOverflowEndsCr = endsCr;
                this.#line = EMPTY_BYTES;
            } else {
                this.#line = appendBytes(this.#line, suffix);
            }
            return;
        }
    }

    #checkLineLength(bytes: Uint8Array): void {
        const endsCr = bytes[bytes.byteLength - 1] === 0x0d;
        assertTelexLimit(
            'max_line_bytes',
            bytes.byteLength - Number(endsCr),
            this.#limits.maxLineBytes,
            this.#processedLines + 1,
        );
    }

    #processLine(bytes: Uint8Array, terminated: boolean, records: TelexRecord[]): void {
        const lineNumber = this.#processedLines + 1;
        const hasSuffixCr = bytes[bytes.byteLength - 1] === 0x0d;
        const physicalLength = bytes.byteLength - Number(hasSuffixCr);
        assertTelexLimit(
            'max_line_bytes',
            physicalLength,
            this.#limits.maxLineBytes,
            lineNumber,
        );
        let logicalBytes = bytes;
        if (terminated && hasSuffixCr) {
            this.#canonical = false;
            logicalBytes = bytes.subarray(0, bytes.byteLength - 1);
        }
        if (logicalBytes.includes(0x0d)) {
            throw new InternalTelexSyntaxError(
                'Bare carriage returns are not allowed',
                undefined,
                'TELEX_BARE_CR',
            );
        }

        let line: string;
        try {
            line = UTF8_DECODER.decode(logicalBytes);
        } catch {
            throw new InternalTelexSyntaxError(
                'Telex input must be valid UTF-8',
                lineNumber,
                'TELEX_INVALID_UTF8',
            );
        }
        if (lineNumber === 1 && line.startsWith('\uFEFF')) {
            throw new InternalTelexSyntaxError(
                'UTF-8 byte-order marks are not allowed',
                1,
                'TELEX_BOM',
            );
        }
        this.#processedLines += 1;

        if (this.#phase === 'header') this.#processHeaderLine(line, lineNumber);
        else this.#processRecordLine(line, lineNumber, records);
    }

    #processHeaderLine(line: string, lineNumber: number): void {
        if (!this.#versionSeen) {
            if (line !== VERSION_LINE) {
                throw new InternalTelexSyntaxError(
                    `Expected ${VERSION_LINE}`,
                    1,
                    'TELEX_INVALID_PREAMBLE',
                );
            }
            this.#versionSeen = true;
            return;
        }
        if (line.length === 0) {
            this.#phase = 'records';
            this.#separatorWidth = 1;
            return;
        }

        const delimiter = line.indexOf('=');
        if (delimiter < 0) this.#missingHeaderSeparator(lineNumber);
        const field = line.slice(0, delimiter);
        if (field !== 'profile' && field !== 'projection') {
            this.#missingHeaderSeparator(lineNumber);
        }
        const rank = field === 'profile' ? 0 : 1;
        if (this.#lastHeaderRank !== undefined && rank < this.#lastHeaderRank) {
            this.#canonical = false;
        }
        this.#lastHeaderRank = rank;
        const state = { decodedPayloadBytes: this.#decodedPayloadBytes };
        const decoded = decodePayloadBounded(
            line.slice(delimiter + 1),
            lineNumber,
            this.#limits,
            state,
        ) as { readonly value: string; readonly canonical: boolean };
        this.#decodedPayloadBytes = state.decodedPayloadBytes;
        this.#canonical &&= decoded.canonical;
        if (decoded.value.length === 0) {
            throw new InternalTelexSyntaxError(
                `${field === 'profile' ? 'Profile' : 'Projection'} identifier must not be empty`,
                lineNumber,
                field === 'profile' ? 'TELEX_EMPTY_PROFILE' : 'TELEX_EMPTY_PROJECTION',
            );
        }
        if (field === 'profile') {
            if (this.#profileExplicit) {
                throw new InternalTelexSyntaxError(
                    'Duplicate stream field: profile',
                    lineNumber,
                    'TELEX_DUPLICATE_STREAM_FIELD',
                );
            }
            this.#profile = decoded.value;
            this.#profileExplicit = true;
        } else {
            if (this.#projectionExplicit) {
                throw new InternalTelexSyntaxError(
                    'Duplicate stream field: projection',
                    lineNumber,
                    'TELEX_DUPLICATE_STREAM_FIELD',
                );
            }
            this.#projection = decoded.value;
            this.#projectionExplicit = true;
        }
    }

    #missingHeaderSeparator(lineNumber: number): never {
        throw new InternalTelexSyntaxError(
            'Expected a blank line after the stream header',
            lineNumber,
            'TELEX_MISSING_HEADER_SEPARATOR',
        );
    }

    #processRecordLine(line: string, lineNumber: number, records: TelexRecord[]): void {
        if (line.length === 0) {
            this.#separatorWidth += 1;
            if (this.#fields !== undefined) this.#closeRecord(lineNumber, records);
            return;
        }
        if (this.#separatorWidth > 1) this.#canonical = false;
        this.#separatorWidth = 0;

        const delimiter = line.indexOf('=');
        if (delimiter < 1) {
            throw new InternalTelexSyntaxError(
                'Expected field=value',
                lineNumber,
                'TELEX_INVALID_FIELD_LINE',
            );
        }
        const field = line.slice(0, delimiter);
        if (!FIELD_NAME.test(field)) {
            throw new InternalTelexSyntaxError(
                `Invalid field name: ${field}`,
                lineNumber,
                'TELEX_INVALID_FIELD_NAME',
            );
        }
        this.#fields ??= new Map();
        if (this.#fields.has(field)) {
            throw new InternalTelexSyntaxError(
                `Duplicate field: ${field}`,
                lineNumber,
                'TELEX_DUPLICATE_FIELD',
            );
        }
        assertTelexLimit(
            'max_fields_per_event',
            this.#fields.size + 1,
            this.#limits.maxFieldsPerEvent,
            lineNumber,
        );
        const state = { decodedPayloadBytes: this.#decodedPayloadBytes };
        const decoded = decodePayloadBounded(
            line.slice(delimiter + 1),
            lineNumber,
            this.#limits,
            state,
        ) as { readonly value: string; readonly canonical: boolean };
        this.#decodedPayloadBytes = state.decodedPayloadBytes;
        this.#canonical &&= decoded.canonical;
        this.#fields.set(field, decoded.value);
        if (field === 'datatype') this.#datatypeLine = lineNumber;
        if ((field === 'generics' || field === 'clarifiers')
            && this.#datatypeComponentLine === undefined) {
            this.#datatypeComponentLine = lineNumber;
        }
    }

    #closeRecord(lineNumber: number, records: TelexRecord[]): void {
        assertTelexLimit(
            'max_events',
            this.#recordCount + 1,
            this.#limits.maxEvents,
            lineNumber,
        );
        const fields = this.#fields;
        if (fields === undefined) throw new Error('Telex record fields are unavailable');
        const decoded = decodeWireRecord(
            fields,
            this.#datatypeLine,
            this.#datatypeComponentLine,
            this.#limits,
        ) as { readonly record: TelexRecord; readonly canonical: boolean };
        this.#fields = undefined;
        this.#datatypeLine = undefined;
        this.#datatypeComponentLine = undefined;
        this.#canonical &&= decoded.canonical && hasCanonicalFieldOrder(fields);
        this.#recordCount += 1;
        records.push(decoded.record);
    }

    #finish(records: TelexRecord[]): void {
        if (!this.#versionSeen) {
            throw new InternalTelexSyntaxError(
                `Expected ${VERSION_LINE}`,
                1,
                'TELEX_INVALID_PREAMBLE',
            );
        }
        if (this.#phase === 'records') {
            if (this.#fields !== undefined) this.#closeRecord(this.#processedLines, records);
            if (this.#separatorWidth > 0) this.#canonical = false;
        }
    }

    #update(
        firstRecord: number,
        records: readonly TelexRecord[],
        progress: IncrementalTelexProgress,
        completion?: IncrementalTelexCompletion,
    ): IncrementalTelexUpdate {
        const contextFixed = this.#phase === 'records' || completion !== undefined;
        let context: IncrementalTelexContext | undefined;
        if (contextFixed && !this.#contextAnnounced) {
            this.#contextAnnounced = true;
            context = {
                profile: this.#profile,
                profileExplicit: this.#profileExplicit,
                projection: this.#projection,
                projectionExplicit: this.#projectionExplicit,
            };
        }
        return {
            firstRecord,
            records,
            ...(context === undefined ? {} : { context }),
            totalInputBytes: this.#totalInputBytes,
            decodedPayloadBytes: this.#decodedPayloadBytes,
            canonicalSoFar: this.#canonical,
            progress,
            ...(completion === undefined ? {} : { completion }),
        };
    }
}

export interface FinalizedIncrementalTelexStream {
    readonly records: readonly TelexRecord[];
    readonly validation: TelexValidationResult;
}

/** Internal semantic sink for ordered provisional Telex record batches. */
export class IncrementalAesAccumulator {
    readonly #records: TelexRecord[] = [];
    readonly #state: unknown;
    #finished = false;

    constructor(
        context: IncrementalTelexContext,
        options: Omit<TelexValidationOptions, 'profile' | 'projection'> = {},
    ) {
        this.#state = createTelexValidationState({
            ...options,
            profile: context.profile,
            projection: context.projection,
        });
    }

    pushBatch(firstRecord: number, records: readonly TelexRecord[]): void {
        this.#acceptBatch(firstRecord, records.map((record) => structuredClone(record)));
    }

    /** Accept records whose ownership has already crossed an isolation boundary. */
    acceptOwnedBatch(firstRecord: number, records: readonly TelexRecord[]): void {
        this.#acceptBatch(firstRecord, records);
    }

    #acceptBatch(firstRecord: number, records: readonly TelexRecord[]): void {
        if (this.#finished) throw new Error('The Telex semantic accumulator is already complete');
        if (!Number.isSafeInteger(firstRecord) || firstRecord < 0) {
            throw new TypeError('AES record batch ordinal must be a non-negative safe integer');
        }
        if (firstRecord !== this.#records.length) {
            throw new Error('AES record batch ordinal is not contiguous');
        }
        if (records.length === 0) return;
        prepareTelexValidationRecords(this.#state, records, firstRecord);
        this.#records.push(...records);
    }

    finish(): FinalizedIncrementalTelexStream {
        if (this.#finished) throw new Error('The Telex semantic accumulator is already complete');
        this.#finished = true;
        const validation = finalizeTelexValidationState(
            this.#state,
            this.#records.length,
        ) as TelexValidationResult;
        return { records: this.#records, validation };
    }
}

/** Test helper that assembles an incremental result without exposing it publicly. */
export function parseTelexInChunks(
    input: Uint8Array,
    splitPoints: readonly number[],
    options: TelexLimitOptions = {},
): ParsedTelex {
    const decoder = new IncrementalTelexDecoder(options);
    const records: TelexRecord[] = [];
    let start = 0;
    for (const end of splitPoints) {
        if (!Number.isSafeInteger(end) || end < start || end > input.byteLength) {
            throw new RangeError('Telex split points must be ordered input byte offsets');
        }
        const update = decoder.push(input.subarray(start, end));
        records.push(...update.records);
        start = end;
    }
    const update = decoder.push(input.subarray(start), { final: true });
    records.push(...update.records);
    const completion = update.completion;
    if (completion === undefined) throw new Error('Final Telex update did not complete syntax');
    return {
        version: TELEX_VERSION,
        profile: completion.profile,
        profileExplicit: completion.profileExplicit,
        projection: completion.projection,
        projectionExplicit: completion.projectionExplicit,
        records,
        canonical: completion.canonical,
    };
}

export function validateTelexInChunks(
    input: Uint8Array,
    splitPoints: readonly number[],
    options: TelexValidationOptions = {},
): FinalizedIncrementalTelexStream {
    const decoder = new IncrementalTelexDecoder(options);
    let accumulator: IncrementalAesAccumulator | undefined;
    let start = 0;
    const boundaries = splitPoints.at(-1) === input.byteLength
        ? splitPoints
        : [...splitPoints, input.byteLength];
    for (const end of boundaries) {
        if (!Number.isSafeInteger(end) || end < start || end > input.byteLength) {
            throw new RangeError('Telex split points must be ordered input byte offsets');
        }
        const final = end === input.byteLength;
        const update = decoder.push(input.subarray(start, end), { final });
        if (update.context !== undefined) {
            accumulator = new IncrementalAesAccumulator(update.context, options);
        }
        if (update.records.length > 0) {
            if (accumulator === undefined) {
                throw new Error('Telex records arrived before stream context');
            }
            accumulator.acceptOwnedBatch(update.firstRecord, update.records);
        }
        start = end;
    }
    if (accumulator === undefined) {
        throw new Error('Telex syntax completed without stream context');
    }
    return accumulator.finish();
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    if (left.byteLength === 0) return right.slice();
    if (right.byteLength === 0) return left;
    const output = new Uint8Array(left.byteLength + right.byteLength);
    output.set(left);
    output.set(right, left.byteLength);
    return output;
}

function isTelexSyntaxError(error: unknown): error is TelexSyntaxError {
    return error instanceof Error && 'code' in error && typeof error.code === 'string';
}
