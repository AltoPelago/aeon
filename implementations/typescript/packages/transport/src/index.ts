import { Transform } from 'node:stream';

export interface FrameOptions {
    readonly maxFrameSize?: number;
    readonly maxBufferSize?: number;
}

export interface HeaderInfo {
    version?: string;
    mode?: 'transport' | 'strict';
    profile?: string;
    schema?: string;
    encoding?: string;
}

export interface HeaderInspectionOptions {
    readonly maxHeaderBytes?: number;
}

export interface TransportDiagnostic {
    readonly level: 'error' | 'warning';
    readonly code: string;
    readonly message: string;
}

export interface HeaderInspectionResult {
    readonly header: HeaderInfo;
    readonly errors: readonly TransportDiagnostic[];
    readonly warnings: readonly TransportDiagnostic[];
}

export class TransportError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}

const DEFAULT_MAX_FRAME = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_MAX_HEADER = 64 * 1024;

export function encodeFrame(payload: Uint8Array | string, options: FrameOptions = {}): Uint8Array {
    const data = toBytes(payload);
    const maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME;
    if (data.length > maxFrameSize) {
        throw new TransportError('FRAME_TOO_LARGE', `Frame size ${data.length} exceeds max ${maxFrameSize}`);
    }
    const header = new Uint8Array(4);
    const length = data.length >>> 0;
    header[0] = (length >>> 24) & 0xff;
    header[1] = (length >>> 16) & 0xff;
    header[2] = (length >>> 8) & 0xff;
    header[3] = length & 0xff;
    const framed = new Uint8Array(4 + data.length);
    framed.set(header, 0);
    framed.set(data, 4);
    return framed;
}

export function decodeFrame(
    buffer: Uint8Array,
    options: FrameOptions = {}
): { frame: Uint8Array; rest: Uint8Array } | null {
    if (buffer.length < 4) return null;
    const length =
        (buffer[0]! << 24) |
        (buffer[1]! << 16) |
        (buffer[2]! << 8) |
        buffer[3]!;
    const maxFrameSize = options.maxFrameSize ?? DEFAULT_MAX_FRAME;
    if (length < 0 || length > maxFrameSize) {
        throw new TransportError('FRAME_TOO_LARGE', `Frame size ${length} exceeds max ${maxFrameSize}`);
    }
    if (buffer.length < 4 + length) return null;
    const frame = buffer.slice(4, 4 + length);
    const rest = buffer.slice(4 + length);
    return { frame, rest };
}

export class FrameDecoder {
    private buffer: Uint8Array;
    private readonly options: FrameOptions;

    constructor(options: FrameOptions = {}) {
        this.options = options;
        this.buffer = new Uint8Array(0);
    }

    push(chunk: Uint8Array): Uint8Array[] {
        this.buffer = concatBytes(this.buffer, chunk);
        const maxBufferSize = this.options.maxBufferSize ?? DEFAULT_MAX_BUFFER;
        if (this.buffer.length > maxBufferSize) {
            throw new TransportError('BUFFER_TOO_LARGE', `Buffer size ${this.buffer.length} exceeds max ${maxBufferSize}`);
        }
        const frames: Uint8Array[] = [];
        while (true) {
            const decoded = decodeFrame(this.buffer, this.options);
            if (!decoded) break;
            frames.push(decoded.frame);
            this.buffer = decoded.rest;
        }
        return frames;
    }

    flush(): Uint8Array[] {
        if (this.buffer.length > 0) {
            throw new TransportError('INCOMPLETE_FRAME', 'Trailing bytes without a complete frame');
        }
        return [];
    }
}

export function createFrameEncoderStream(options: FrameOptions = {}): Transform {
    return new Transform({
        readableObjectMode: false,
        writableObjectMode: false,
        transform(chunk, _encoding, callback) {
            try {
                const data = typeof chunk === 'string' ? chunk : (chunk as Uint8Array);
                const framed = encodeFrame(data, options);
                callback(null, framed);
            } catch (err) {
                callback(err as Error);
            }
        },
    });
}

export function createFrameDecoderStream(options: FrameOptions = {}): Transform {
    const decoder = new FrameDecoder(options);
    return new Transform({
        readableObjectMode: true,
        writableObjectMode: false,
        transform(chunk, _encoding, callback) {
            try {
                const frames = decoder.push(chunk as Uint8Array);
                for (const frame of frames) {
                    this.push(frame);
                }
                callback();
            } catch (err) {
                callback(err as Error);
            }
        },
        flush(callback) {
            try {
                decoder.flush();
                callback();
            } catch (err) {
                callback(err as Error);
            }
        },
    });
}

export function inspectHeader(input: string | Uint8Array, options: HeaderInspectionOptions = {}): HeaderInspectionResult {
    const maxHeaderBytes = options.maxHeaderBytes ?? DEFAULT_MAX_HEADER;
    const sourceBytes = typeof input === 'string' ? toBytes(input) : input;
    if (sourceBytes.length > maxHeaderBytes) {
        return {
            header: {},
            errors: [{
                level: 'error',
                code: 'HEADER_TOO_LARGE',
                message: `Header inspection limit ${maxHeaderBytes} bytes exceeded`,
            }],
            warnings: [],
        };
    }
    const source = typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
    const header: HeaderInfo = {};
    const errors: TransportDiagnostic[] = [];
    const warnings: TransportDiagnostic[] = [];

    const lines = source.split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i] ?? '';
        let line = raw.trim();
        if (line.length === 0) continue;
        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end !== -1) {
                inBlockComment = false;
                line = line.slice(end + 2).trim();
            } else {
                continue;
            }
        }
        if (line.startsWith('/*')) {
            inBlockComment = !line.includes('*/');
            continue;
        }
        if (line.startsWith('//')) continue;

        if (line.startsWith('aeon:header')) {
            const block = collectBraceBlock(lines, i);
            if (!block) {
                warnings.push({
                    level: 'warning',
                    code: 'HEADER_BLOCK_INCOMPLETE',
                    message: 'Unable to parse structured header block',
                });
                break;
            }
            const { body, endIndex } = block;
            parseStructuredHeader(body, header);
            i = endIndex;
            continue;
        }

        if (!line.startsWith('aeon:')) {
            break;
        }

        const parsed = parseHeaderLine(line);
        if (parsed) {
            applyHeaderField(header, parsed.key, parsed.value);
        }
    }

    if (!header.encoding) {
        header.encoding = 'utf-8';
    }

    return { header, errors, warnings };
}

function parseHeaderLine(line: string): { key: string; value: string } | null {
    if (!line.startsWith('aeon:')) return null;
    const equals = findAssignmentEquals(line, 'aeon:'.length);
    if (equals === -1) return null;
    const key = line.slice('aeon:'.length, equals).trim();
    if (!isHeaderFieldName(key)) return null;
    const rawValue = line.slice(equals + 1).trim();
    if (rawValue.length === 0) return null;
    const value = stripQuotes(rawValue);
    return { key, value };
}

function parseStructuredHeader(body: string, header: HeaderInfo): void {
    const lines = body.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('//')) continue;
        const equals = findAssignmentEquals(line, 0);
        if (equals === -1) continue;
        const key = line.slice(0, equals).trim();
        if (!isHeaderFieldName(key)) continue;
        const rawValue = line.slice(equals + 1).trim();
        if (!rawValue) continue;
        const value = stripQuotes(rawValue);
        applyHeaderField(header, key, value);
    }
}

function findAssignmentEquals(line: string, start: number): number {
    for (let i = start; i < line.length; i += 1) {
        if (line[i] === '=') return i;
    }
    return -1;
}

function isHeaderFieldName(value: string): boolean {
    if (value.length === 0) return false;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i]!;
        const isAlphaNum = (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9');
        if (isAlphaNum || ch === ':' || ch === '_' || ch === '-') continue;
        return false;
    }
    return true;
}

function collectBraceBlock(lines: string[], startIndex: number): { body: string; endIndex: number } | null {
    const startLine = lines[startIndex] ?? '';
    const startPos = startLine.indexOf('{');
    if (startPos === -1) return null;
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let escaped = false;
    const collected: string[] = [];
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const ch of line) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (quote) {
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === quote) {
                    quote = null;
                }
                continue;
            }
            if (ch === '"' || ch === "'") {
                quote = ch;
                continue;
            }
            if (ch === '{') depth += 1;
            if (ch === '}') depth -= 1;
        }
        if (i === startIndex) {
            collected.push(line.slice(startPos + 1));
        } else {
            collected.push(line);
        }
        if (depth === 0) {
            const body = collected.join('\n').replace(/}\s*$/, '');
            return { body, endIndex: i };
        }
    }
    return null;
}

function applyHeaderField(header: HeaderInfo, key: string, value: string): void {
    switch (key) {
        case 'version':
        case 'aeon:version':
            header.version = value;
            break;
        case 'mode':
        case 'aeon:mode':
            header.mode = value === 'strict' ? 'strict' : 'transport';
            break;
        case 'profile':
        case 'aeon:profile':
        case 'profile:id':
        case 'aeon:profile:id':
            header.profile = value;
            break;
        case 'schema':
        case 'aeon:schema':
        case 'schema:id':
        case 'aeon:schema:id':
            header.schema = value;
            break;
        case 'encoding':
        case 'aeon:encoding':
            header.encoding = value;
            break;
        default:
            break;
    }
}

function stripQuotes(value: string): string {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        return value.slice(1, -1);
    }
    return value;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    if (a.length === 0) return b.slice();
    if (b.length === 0) return a.slice();
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
}

function toBytes(payload: Uint8Array | string): Uint8Array {
    if (typeof payload === 'string') {
        return new TextEncoder().encode(payload);
    }
    return payload;
}
