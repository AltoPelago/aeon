import type { PartialTelexLimits, TelexLimitOptions, TelexRecord } from './telex.js';
import * as implementation from './film-internal.js';

export const FILM_VERSION = '1' as const;
export const FILM_V1_PREAMBLE: readonly number[] = implementation.FILM_V1_PREAMBLE;

export interface FilmLimits {
    readonly maxInputBytes: number;
    readonly maxRecordBytes: number;
    readonly maxFieldBytes: number;
    readonly maxBufferedBytes: number;
}

export type PartialFilmLimits = Partial<FilmLimits>;

export interface FilmDecodeOptions extends TelexLimitOptions, PartialFilmLimits {
    /** Film-local byte and buffering limits. */
    readonly filmLimits?: PartialFilmLimits;
    /** Shared AES structural limits applied to decoded records. */
    readonly aesLimits?: PartialTelexLimits;
    /** Registered extension fields accepted by the selected AES profile. */
    readonly registeredFields?: readonly string[];
}

export interface FilmStream {
    readonly profile: string;
    readonly profileExplicit: boolean;
    readonly projection: string | null;
    readonly projectionExplicit: boolean;
    readonly records: readonly TelexRecord[];
}

export interface FilmDecodeError extends Error {
    readonly code: string;
    readonly offset: number;
    readonly record: number | null;
    readonly component: string;
    readonly stage: 'film' | 'aes';
    readonly diagnostics: readonly Readonly<Record<string, unknown>>[];
}

export const FilmDecodeError = implementation.FilmDecodeError as unknown as {
    new(
        code: string,
        message: string,
        details?: Readonly<Record<string, unknown>>,
    ): FilmDecodeError;
};

export type FilmIncrementalStatus = 'need-more-input' | 'provisional' | 'complete';

export interface FilmIncrementalResult {
    readonly status: FilmIncrementalStatus;
    readonly records: readonly TelexRecord[];
    readonly stream: FilmStream | null;
    readonly bufferedBytes: number;
    readonly inputBytes: number;
}

export interface IncrementalFilmDecoder {
    push(input: Uint8Array, options?: { readonly final?: boolean }): FilmIncrementalResult;
    finish(): FilmIncrementalResult;
}

export const IncrementalFilmDecoder = implementation.IncrementalFilmDecoder as unknown as {
    new(options?: FilmDecodeOptions): IncrementalFilmDecoder;
};

export const DEFAULT_FILM_LIMITS: Readonly<FilmLimits> = implementation.DEFAULT_FILM_LIMITS;

export function normalizeFilmLimits(options: FilmDecodeOptions = {}): Readonly<FilmLimits> {
    return implementation.normalizeFilmLimits(options) as Readonly<FilmLimits>;
}

/** Decode canonical Film framing into provisional owned AES records. */
export function decodeFilmSyntax(input: Uint8Array, options: FilmDecodeOptions = {}): FilmStream {
    return implementation.decodeFilmSyntax(input, options) as FilmStream;
}

/** Decode Film and return records only after complete AES validation succeeds. */
export function decodeFilm(input: Uint8Array, options: FilmDecodeOptions = {}): FilmStream {
    return implementation.decodeFilm(input, options) as FilmStream;
}

/** Film v1 remains reader-first; this package deliberately exposes no writer. */
export function filmV1IsDraft(): true {
    return implementation.filmV1IsDraft() as true;
}
