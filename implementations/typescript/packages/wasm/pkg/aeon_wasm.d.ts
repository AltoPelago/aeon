/* tslint:disable */
/* eslint-disable */

/**
 * Bounded progressive AEON stream exposed through the generated WASM module.
 *
 * Each method returns one JSON envelope so the JavaScript adapter performs one
 * boundary crossing per input chunk, output batch, or lifecycle operation.
 */
export class AeonStream {
    free(): void;
    [Symbol.dispose](): void;
    cancel(): string;
    finish(): string;
    constructor(options_json: string);
    pullBatch(): string;
    pushString(chunk: string): string;
    push(chunk: Uint8Array): string;
    state(): string;
    takeTerminal(): string;
}

export function benchmark_process_aeon(source: string, options_json: string): number;

export function canonicalize_telex(source: string, options_json: string): string;

export function check_telex_completeness(source: string, options_json: string): string;

export function materialize_telex(source: string, options_json: string): string;

export function process_aeon(source: string, options_json: string): string;

export function validate_telex(source: string, options_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_aeonstream_free: (a: number, b: number) => void;
    readonly aeonstream_cancel: (a: number) => [number, number, number, number];
    readonly aeonstream_finish: (a: number) => [number, number, number, number];
    readonly aeonstream_new: (a: number, b: number) => [number, number, number];
    readonly aeonstream_pullBatch: (a: number) => [number, number, number, number];
    readonly aeonstream_push: (a: number, b: number, c: number) => [number, number, number, number];
    readonly aeonstream_pushString: (a: number, b: number, c: number) => [number, number, number, number];
    readonly aeonstream_state: (a: number) => [number, number];
    readonly aeonstream_takeTerminal: (a: number) => [number, number, number, number];
    readonly benchmark_process_aeon: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly canonicalize_telex: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly check_telex_completeness: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly materialize_telex: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly process_aeon: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly validate_telex: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
